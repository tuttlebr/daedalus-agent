#!/usr/bin/env python3
"""Exercise the native exploration adapter in the built backend over HTTP."""

import argparse
import base64
import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from image_check import environment, require
from leaf_check import LeafPeers, measure

KEY = "synthetic-exploration-http-test-key-" * 4


def main(image, preparation, redis_image, executor):
    seen = []
    publications = []
    artifact_mode = "valid"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            if self.path == "/api/internal/sandboxArtifacts":
                publications.append(
                    self.rfile.read(int(self.headers["content-length"]))
                )
                return self.reply(
                    {
                        "artifact": {
                            "version": 1,
                            "documentId": "fixture-document",
                            "sessionId": "fixture-session",
                            "filename": "report.txt",
                            "mimeType": "text/plain",
                            "size": 4,
                            "downloadUrl": "/api/session/documentStorage?documentId=fixture-document&sessionId=fixture-session",
                        }
                    }
                )
            require(self.path == "/v2/tool", "Unexpected exploration path")
            token = self.headers["authorization"][7:]
            header, payload, signature = token.split(".")

            def decode(value):
                return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

            require(
                json.loads(decode(header)) == {"alg": "HS256", "typ": "JWT"},
                "Unexpected grant algorithm",
            )
            require(
                hmac.compare_digest(
                    decode(signature),
                    hmac.digest(KEY.encode(), f"{header}.{payload}".encode(), "sha256"),
                ),
                "Invalid grant signature",
            )
            claims = json.loads(decode(payload))
            require(
                claims["aud"] == "daedalus-exploration"
                and claims["iss"] == "daedalus-agent"
                and claims["profile"] == "compute-offline-v1",
                "Unexpected grant authority",
            )
            require(claims["iat"] <= time.time() < claims["exp"], "Expired grant")
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            seen.append((claims, body))
            if body["operation"] == "artifact":
                artifact = {
                    "contentBase64": "dGVzdA==",
                    "size": 4,
                    "sha256": hashlib.sha256(b"test").hexdigest(),
                    "runId": "run",
                    "path": "report.txt",
                }
                if artifact_mode == "corrupt":
                    artifact["sha256"] = "wrong"
                return self.reply(artifact)
            self.reply({"version": 2, "profiles": ["compute-offline-v1"]})

        def reply(self, value):
            response = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    model = LeafPeers()

    def configure(config, *_):
        config["functions"] = {"explore": {"_type": "sandbox_exploration"}}
        config["workflow"].update(
            tools=["explore"], tool_output_compaction_enabled=False
        )

    try:
        with environment(
            image,
            redis_image,
            minimal=True,
            memory=False,
            peers=model,
            configure=configure,
            extra_env=lambda _: {
                "EXPLORATION_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                "EXPLORATION_GRANT_KEY": KEY,
                "DAEDALUS_TOOL_EXECUTOR": executor,
                "DAEDALUS_PREPARATION": preparation,
                "DAEDALUS_AUTHORIZATION": preparation,
                "DAEDALUS_ARTIFACT_PUBLISH_URL": f"http://127.0.0.1:{server.server_port}/api/internal/sandboxArtifacts",
            },
        ) as fixture:
            for conversation in ["first", "second"]:
                model.plan = [
                    {"name": "explore", "arguments": {"operation": "capabilities"}}
                ]
                result = measure(
                    fixture, extra_headers={"x-conversation-id": conversation}
                )
                if result["errors"]:
                    print(json.dumps(result))
                    print((fixture["root"] / "backend.log").read_text()[-4000:])
                require(
                    result["done"] and not result["errors"],
                    "Exploration tool failed through built backend",
                )
            require(len(seen) == 2, "Native adapter did not invoke exploration API")
            require(seen[0][0]["owner"] == seen[1][0]["owner"], "Owner binding changed")
            require(
                seen[0][0]["scope"] != seen[1][0]["scope"],
                "Conversation scopes collided",
            )
            require(
                seen[0][0]["exp"] - seen[0][0]["iat"] == 120,
                "Unexpected grant lifetime",
            )
            require(
                all(v[1] == {"operation": "capabilities"} for v in seen),
                "Model request acquired authority fields",
            )
            validation_result = "invalid_tool_batch"
            for arguments, expected in [
                ({"operation": "capabilities", "owner": "other"}, validation_result),
                ({"operation": "publish_file"}, validation_result),
                (
                    {"operation": "publish_file", "runId": "run", "path": "report.txt"},
                    "/api/session/documentStorage?",
                ),
            ]:
                model.plan = [{"name": "explore", "arguments": arguments}]
                result = measure(fixture)
                require(
                    result["done"] and not result["errors"],
                    "Exploration validation aborted chat",
                )
                output = model.results[-1][0]["output"]
                if expected == validation_result:
                    rejected = json.loads(output)
                    require(
                        rejected["status"] == "error"
                        and rejected["executed"] is False
                        and rejected["error"] == validation_result,
                        "Invalid arguments were executed",
                    )
                require(
                    expected in output,
                    f"Unexpected exploration result: {model.results[-1][0]['output']}",
                )
            require(
                publications == [b"test"] and len(seen) == 3,
                "Invalid input escaped validation or publication was lost",
            )
            artifact_mode = "corrupt"
            result = measure(fixture)
            require(
                result["done"]
                and not result["errors"]
                and "Tool failed (" in model.results[-1][0]["output"],
                "Corrupt artifact was accepted",
            )
            require(publications == [b"test"], "Corrupt artifact reached publisher")
            print(
                json.dumps(
                    {
                        "status": "passed",
                        "requests": len(seen),
                        "checks": [
                            "native registration",
                            "built HTTP backend",
                            "signed grants",
                            "conversation isolation",
                            "input validation",
                            "artifact publication and corruption rejection",
                        ],
                    }
                )
            )
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--preparation", choices=["rust", "python"], default="rust")
    parser.add_argument("--executor", choices=["python", "none"], default="python")
    parser.add_argument("--redis-image", default="daedalus:redis-migration-check")
    args = parser.parse_args()
    main(args.image, args.preparation, args.redis_image, args.executor)
