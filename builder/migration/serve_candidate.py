#!/usr/bin/env python3
"""Run a candidate image and scripted external peers for browser tests."""

import argparse
import base64
import contextlib
import hashlib
import json
import os
import signal
import tempfile
import threading
import zlib
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import redis
from collections_check import milvus_fixture
from documents_check import DocumentPeers
from export_llm_sandbox import capabilities, execution
from export_milvus_search import response as search_response
from image_check import environment
from nws_weather_check import weather_scenarios
from output_retriever_check import key, reference
from perplexity_search_check import RESULT as SEARCH_RESULT
from profile_import_check import expand
from public_http_namespace import fixture as public_fixture


class BrowserPeers(DocumentPeers):
    def __init__(self):
        super().__init__()
        self.sandbox_workspaces = {}
        self.sandbox_calls = []

    def handler(self):
        peer = self

        class Handler(super().handler()):
            def do_GET(self):
                if self.path == "/readyz":
                    return self.reply({"status": "ready"})
                if self.path == "/v1/commands":
                    if (
                        self.headers.get("Authorization")
                        != "Bearer synthetic-browser-sandbox"
                    ):
                        raise AssertionError("Sandbox discovery lost authorization")
                    return self.reply(capabilities())
                return super().do_GET()

            def do_POST(self):
                if self.path == "/v1/execute":
                    if (
                        self.headers.get("Authorization")
                        != "Bearer synthetic-browser-sandbox"
                    ):
                        raise AssertionError("Sandbox execution lost authorization")
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    if (
                        body.get("argv") != ["true"]
                        or len(body.get("workspaceId", "")) != 64
                    ):
                        raise AssertionError(
                            "Sandbox file operation lost its trusted workspace"
                        )
                    peer.sandbox_calls.append(body)
                    workspace = peer.sandbox_workspaces.setdefault(
                        body["workspaceId"], {}
                    )
                    for file in body.get("files", []):
                        workspace[file["path"]] = (
                            workspace.get(file["path"], "") if file["append"] else ""
                        ) + file["content"]
                    result = execution()
                    result.update(files=[], missingFiles=[])
                    for path in body.get("collect", []):
                        if path not in workspace:
                            result["missingFiles"].append(path)
                        else:
                            raw = workspace[path].encode()
                            result["files"].append(
                                {
                                    "path": path,
                                    "size": len(raw),
                                    "mode": "0644",
                                    "contentBase64": base64.b64encode(raw).decode(),
                                    "truncated": False,
                                }
                            )
                    return self.reply(result)
                if self.path == "/provider/search":
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    if body.get("query") != [
                        "Synthetic browser search",
                        "Synthetic related search",
                    ]:
                        raise AssertionError(
                            "Browser search did not preserve multi-query arguments"
                        )
                    return self.reply(SEARCH_RESULT)
                if self.path == "/v1/embeddings":
                    self.rfile.read(int(self.headers["Content-Length"]))
                    return self.reply({"data": [{"embedding": [0.25, -0.5]}]})
                return super().do_POST()

        return Handler


def browser_control(peers, milvus, port, weather):
    """Loopback-only test control; the application never exposes these routes."""
    physical = "user_uploads_e2e_user_" + hashlib.sha256(b"e2e-user").hexdigest()
    oracle = expand(
        json.loads(
            (
                Path(__file__).resolve().parents[1]
                / "runtime/tests/fixtures/milvus-index.json"
            ).read_text()
        )
    )["cases"][0]
    # The ingestion dimension probe uses the opaque read token, whereas
    # NV-Ingest's upload credentials use the configured username/password.
    reader_auth = base64.b64encode(b"synthetic-browser-milvus-token").decode()
    script = [call for call in oracle["calls"] if call["method"] != "Connect"]
    script[0]["metadata"]["authorization"] = reader_auth

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path == "/weather":
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                case = weather_scenarios(datetime.now(UTC))[0]
                alerts = case["responses"]["/alerts/active?point=42.3000,-83.1000"]
                if body["mode"] == "partial":
                    alerts["status"] = 503
                elif body["mode"] == "hold":
                    alerts["hold"] = True
                elif body["mode"] != "complete":
                    return self.reply(400, {"error": "Unknown weather fixture"})
                weather.post("/reset", json=case).raise_for_status()
                return self.reply(200, {"mode": body["mode"]})
            if self.path == "/search":
                result = search_response()
                result["results"]["fields_data"][0]["field_name"] = "text"
                result["results"]["output_fields"][0] = "text"
                result["results"]["fields_data"][0]["scalars"]["string_data"]["data"][
                    0
                ] = "Synthetic indexed 雪🌲"
                milvus["control"].post(
                    "/reset",
                    json={
                        "replies": {
                            "ShowCollections": {
                                "collection_names": [physical, "nvidia"]
                            },
                            "DescribeCollection": {
                                "schema": {
                                    "name": physical,
                                    "fields": [
                                        {"name": "text", "data_type": 21},
                                        {"name": "source", "data_type": 21},
                                        {
                                            "name": "vector",
                                            "data_type": 101,
                                            "type_params": [
                                                {"key": "dim", "value": "2"}
                                            ],
                                        },
                                    ],
                                }
                            },
                            "Search": result,
                        }
                    },
                ).raise_for_status()
                return self.reply(200, {"collection": physical})
            if self.path == "/ingestion/release":
                milvus["control"].post("/release").raise_for_status()
                return self.reply(200, {"released": True})
            if self.path != "/ingestion":
                return self.reply(404, {"error": "Unknown fixture route"})
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            peers.reset_documents()
            peers.document_reply = {"status": "success", "data": oracle["records"][0]}
            response = milvus["control"].post(
                "/reset",
                json={
                    "uri": f"http://127.0.0.1:{milvus['port']}",
                    "live_receipt_clock": True,
                    "rename_collections": {"private_collection": physical},
                    "script": script,
                    "reader_authorization": reader_auth,
                    # Metadata reads the default database, which ingestion
                    # writes. That database is selected by an empty name.
                    "reader_database": "",
                    "collections": ["nvidia", "another_private_collection"],
                    "delay": {"Insert": {"seconds": 60, "count": 1}},
                    "mutation_timestamps": {physical: 1234, "meta": 9999},
                },
            )
            response.raise_for_status()
            self.reply(200, {"collection": physical})

        def do_GET(self):
            if self.path == "/weather":
                return self.reply(200, weather.get("/state").json())
            if self.path == "/sandbox":
                return self.reply(200, {"calls": peers.sandbox_calls})
            if self.path == "/search":
                calls = milvus["control"].get("/calls").json()
                return self.reply(
                    200,
                    {"searches": [c["body"] for c in calls if c["method"] == "Search"]},
                )
            if self.path != "/ingestion":
                return self.reply(404, {"error": "Unknown fixture route"})
            calls = milvus["control"].get("/calls").json()
            self.reply(
                200,
                {
                    "script": milvus["control"].get("/script").json(),
                    "jobs": [
                        call["body"]
                        for call in peers.document_calls
                        if call["method"] == "POST"
                    ],
                    "document_inserts": sum(
                        call["method"] == "Insert"
                        and call["body"].get("collection_name") == physical
                        for call in calls
                    ),
                },
            )

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def configure(config, port, *_, skills_root):
    config["functions"]["agent_skills_tool"] = {
        "_type": "agent_skills",
        "skills_directory": str(skills_root),
    }
    config["workflow"]["tools"].append("agent_skills_tool")
    config["workflow"]["skill_model_profiles"] = {"fixture-skill": "deep"}
    config["functions"]["user_documents"] = {
        "_type": "nat_nv_ingest",
        "milvus_uri": "${MILVUS_URI}",
        "redis_url": "${REDIS_URL}",
        "embedder_name": "browser_embeddings",
        "nv_ingest_host": "127.0.0.1",
        "nv_ingest_port": port,
        "embedder_dim": 2,
    }
    config["embedders"] = {
        "browser_embeddings": {
            "_type": "vllm",
            "base_url": f"http://127.0.0.1:{port}",
            "model_name": "synthetic-browser-embedding",
        }
    }
    config["workflow"]["tools"].append("user_documents")
    config["functions"]["domain_search"] = {
        "_type": "domain_retriever",
        "uri": "${MILVUS_URI}",
        "embedding_model": "browser_embeddings",
    }
    config["workflow"]["tools"].append("domain_search")
    config["functions"]["web_search"] = {
        "_type": "perplexity_search",
        "api_key": "synthetic-browser-key",
        "base_url": f"http://127.0.0.1:{port}/provider/search",
    }
    config["workflow"]["tools"].append("web_search")
    config["functions"]["llm_sandbox_tool"] = {"_type": "llm_sandbox"}
    config["workflow"]["tools"].append("llm_sandbox_tool")
    config["functions"]["nws_weather_tool"] = {"_type": "nws_weather"}
    config["workflow"]["tools"].append("nws_weather_tool")
    config["functions"]["tool_output_retriever_tool"] = {
        "_type": "tool_output_retriever"
    }
    config["workflow"]["tools"].append("tool_output_retriever_tool")
    for name, kind in [
        ("add_memory", "daedalus_add_memory"),
        ("get_memory", "daedalus_get_memory"),
    ]:
        config["functions"][name] = {"_type": kind}
        config["workflow"]["tools"].append(name)


@contextlib.contextmanager
def browser_skills():
    with tempfile.TemporaryDirectory(prefix="daedalus-browser-skills-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        skill = root / "probe"
        skill.mkdir()
        (skill / "SKILL.md").write_text(
            "---\nname: fixture-skill\ndescription: Synthetic browser skill\n---\n"
            "## Synthetic browser instructions\n\nLoaded skill evidence 雪🌲\n"
        )
        (skill / "resource.txt").write_text("Synthetic skill resource\n")
        yield root


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image", required=True)
parser.add_argument("--redis-image", required=True)
parser.add_argument("--milvus-image", required=True)
parser.add_argument("--port", type=int, default=18000)
args = parser.parse_args()
stopped = threading.Event()
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: stopped.set())
peers = BrowserPeers()
peers.retrieval_content = "雪🌲 exact cached browser evidence"
peers.retrieval_reference = reference(peers.retrieval_content)
with browser_skills() as skills_root, milvus_fixture(
    args.milvus_image
) as milvus, environment(  # nosec B106
    args.image,
    args.redis_image,
    memory=True,
    port=args.port,
    token="e2e-internal-token",
    peers=peers,
    configure=lambda *args: configure(*args, skills_root=skills_root),
    fixture_mounts=[(skills_root, skills_root)],
    namespace_factory=public_fixture(
        args.milvus_image,
        minimal=True,
        extra_ports=[
            milvus["port"],
            *[
                urlsplit(os.environ[name]).port
                for name in [
                    "REDIS_URL",
                    "DOCUMENT_OBJECT_ENDPOINT",
                    "DAEDALUS_ARTIFACT_PUBLISH_URL",
                ]
            ],
        ],
    ),
    extra_env=lambda port: {
        **{
            name: os.environ[name]
            for name in [
                "REDIS_URL",
                "DOCUMENT_OBJECT_ENDPOINT",
                "DOCUMENT_OBJECT_ACCESS_KEY",
                "DOCUMENT_OBJECT_SECRET_KEY",
                "DOCUMENT_OBJECT_BUCKET",
                "DOCUMENT_OBJECT_REGION",
                "DOCUMENT_OBJECT_PREFIX",
            ]
        },
        "REDIS_TLS_ENABLED": "false",
        "NV_INGEST_HOST": "127.0.0.1",
        "NV_INGEST_PORT": str(port),
        "MILVUS_URI": f"http://127.0.0.1:{milvus['port']}",
        "MILVUS_TOKEN": "synthetic-browser-milvus-token",
        "MILVUS_DATABASE": "default",
        "MILVUS_USERNAME": "synthetic-user",
        "MILVUS_PASSWORD": "synthetic-password",
        "EMBEDDING_DENSE_DIM": "2",
        "DOCUMENT_INGEST_MAX_RETRIES": "0",
        # The retained environment defaults allow this disposable loopback
        # topology; the publisher is the actual running Next.js endpoint.
        "LLM_SANDBOX_BASE_URL": f"http://127.0.0.1:{port}",
        "LLM_SANDBOX_API_KEY": "synthetic-browser-sandbox",
        "DAEDALUS_ARTIFACT_PUBLISH_URL": os.environ["DAEDALUS_ARTIFACT_PUBLISH_URL"],
    },
) as fixture:
    milvus["control"].post(
        "/reset", json={"collections": ["nvidia", "another_private_collection"]}
    ).raise_for_status()
    with redis.Redis.from_url(os.environ["REDIS_URL"]) as shared:
        shared.set(
            key("e2e-user", peers.retrieval_reference),
            b"z1" + zlib.compress(peers.retrieval_content.encode()),
            ex=7200,
        )
    control = browser_control(
        peers, milvus, args.port + 1, fixture["namespace"]["control"]
    )
    try:
        print("Candidate image ready; mock backend is disabled.", flush=True)
        stopped.wait()
    finally:
        control.shutdown()
        control.server_close()
