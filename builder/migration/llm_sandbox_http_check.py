#!/usr/bin/env python3
"""Compare sandbox schemas, authenticated execution, publication and Stop in images."""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import threading
import time
import uuid
from pathlib import Path

from document_tool_receipts_check import normalized as chat_result
from image_check import environment, require, run
from leaf_check import LeafPeers, measure
from llm_sandbox_check import SandboxPeer, scenarios
from nvidia_docs_check import secure_peer

ROOT = Path(__file__).resolve().parents[1]
SCOPE = {"x-user-id": "synthetic-alice", "x-conversation-id": "synthetic-conversation"}


def stop(env, peer, headers):
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor() as pool:
        task = pool.submit(
            measure, env, request_id=request_id, extra_headers=headers, message="hi"
        )
        deadline = time.monotonic() + 10
        while not peer.held and time.monotonic() < deadline:
            require(not task.done(), "Sandbox finished before cancellation barrier")
            threading.Event().wait(0.02)
        require(peer.held, "Sandbox never reached cancellation barrier")
        env["client"].post(
            env["base"] + f"/v1/runs/{request_id}/control",
            headers=env["headers"] | headers,
            json={"type": "cancel", "command_id": str(uuid.uuid4())},
        ).raise_for_status()
        result = chat_result(task.result(timeout=8))
        require(
            result["done"]
            and result["terminal"] == "error"
            and result["errors"] == [{"error": {"message": "Run cancelled by user"}}],
            "Stop did not terminate sandbox operation",
        )
        while not peer.disconnected and time.monotonic() < deadline:
            threading.Event().wait(0.02)
        require(peer.disconnected, "Stop left sandbox transport connected")
    return result


def main(args):
    peer = SandboxPeer()
    profiles, baseline, startup = [], None, []
    candidates = [
        ("retained", args.python_image, False, "python", "python"),
        ("native-full", args.image, False, "rust", "rust"),
        ("native-python-auth", args.image, False, "rust", "python"),
        ("native-minimal", args.minimal_image, True, "rust", "rust"),
    ]
    with secure_peer(peer) as secure:
        # Non-ASCII identities are checked at the factory boundary. The HTTP
        # ingress has its own header validation and cannot carry those fixtures.
        cases = [
            case
            for case in scenarios(secure["endpoint"], "unused", secure["bad_endpoint"])
            if case["name"]
            not in {
                "identity-isolation",
                "publish-unicode-scope",
                "without-context",
                "file-no-context",
            }
        ]
        if args.case:
            selected = set(args.case)
            cases = [case for case in cases if case["name"] in selected]
            require(
                {case["name"] for case in cases} == selected,
                "Unknown sandbox HTTP case",
            )

        def configure(config, *_):
            config["functions"] = {
                f"llm_sandbox_{index}": case["config"]
                for index, case in enumerate(cases)
            }
            config["workflow"].update(
                tools=list(config["functions"]), tool_output_compaction_enabled=False
            )

        for label, image, minimal, preparation, authorization in candidates:
            model, observed = LeafPeers(), []
            with environment(
                image,
                args.redis_image,
                minimal=minimal,
                memory=False,
                peers=model,
                configure=configure,
                fixture_mounts=[(secure["root"], secure["root"])],
                extra_env=lambda _, p=preparation, a=authorization: {
                    **secure["environment"],
                    "DAEDALUS_PREPARATION": p,
                    "DAEDALUS_AUTHORIZATION": a,
                    "DAEDALUS_TOOL_EXECUTOR": "disabled"
                    if p == a == "rust"
                    else "python",
                },
            ) as env:
                for index, case in enumerate(cases):
                    peer.reset(case["peer"])
                    results = []
                    name = f"llm_sandbox_{index}"
                    for step in case["steps"]:
                        if step.get("sleep"):
                            time.sleep(step["sleep"])
                        before, outputs = len(model.requests), len(model.results)
                        model.plan = [{"name": name, "arguments": step["input"]}]
                        headers = step.get("headers", SCOPE)
                        result = (
                            stop(env, peer, headers)
                            if step.get("cancel")
                            else chat_result(
                                measure(env, extra_headers=headers, message="hi")
                            )
                        )
                        result["model_outputs"] = copy.deepcopy(model.results[outputs:])
                        schemas = [
                            tool.get("function", tool)
                            for tool in model.requests[before]["tools"]
                        ]
                        schema = next(
                            tool for tool in schemas if tool.get("name") == name
                        )
                        result["schema"] = {
                            key: schema[key]
                            for key in ["name", "description", "parameters"]
                        }
                        require(
                            result["done"],
                            f"Incomplete sandbox chat: {label}/{case['name']}",
                        )
                        results.append(result)
                    item = {
                        "name": case["name"],
                        "results": results,
                        "calls": copy.deepcopy(peer.calls),
                        "mutations": copy.deepcopy(peer.mutations),
                        "disconnected": peer.disconnected,
                    }
                    if baseline is not None:
                        if item != baseline[index]:
                            args.report.parent.mkdir(parents=True, exist_ok=True)
                            args.report.with_suffix(".failed.json").write_text(
                                json.dumps(
                                    {
                                        "profile": label,
                                        "actual": item,
                                        "expected": baseline[index],
                                    },
                                    indent=2,
                                )
                                + "\n"
                            )
                            require(
                                False,
                                f"Sandbox HTTP mismatch: {label}/{case['name']}; details in {args.report.with_suffix('.failed.json')}",
                            )
                    require(
                        not peer.failures,
                        f"Unexpected sandbox requests: {peer.failures}",
                    )
                    observed.append(item)
                    print(f"Sandbox HTTP: {label}/{case['name']}", flush=True)
            if baseline is None:
                baseline = observed
            profiles.append(
                {
                    "name": label,
                    "cases": observed,
                    "image": run(
                        "docker",
                        "image",
                        "inspect",
                        image,
                        "--format",
                        "{{.Id}}",
                        capture_output=True,
                        text=True,
                    ).stdout.strip(),
                }
            )
        if not args.case:
            for label, image, minimal, preparation, authorization in candidates:
                for field, value in [
                    ("base_url", "http://synthetic.invalid"),
                    ("request_timeout", 0),
                    ("artifact_publish_url", secure["endpoint"] + "/wrong-path"),
                    ("unknown_sandbox_setting", True),
                ]:

                    def invalid_config(config, *_):
                        config["functions"] = {
                            "sandbox": {"_type": "llm_sandbox", field: value}
                        }
                        config["workflow"]["tools"] = ["sandbox"]

                    try:
                        with environment(
                            image,
                            args.redis_image,
                            minimal=minimal,
                            memory=False,
                            configure=invalid_config,
                            extra_env=lambda _, p=preparation, a=authorization: {
                                "DAEDALUS_PREPARATION": p,
                                "DAEDALUS_AUTHORIZATION": a,
                                "DAEDALUS_TOOL_EXECUTOR": "disabled"
                                if p == a == "rust"
                                else "python",
                            },
                        ):
                            raise AssertionError(
                                f"Invalid sandbox configuration reached readiness: {label}/{field}"
                            )
                    except RuntimeError as error:
                        require(
                            "configuration" in str(error).lower()
                            or field in str(error),
                            f"Unexpected startup failure: {error}",
                        )
                    startup.append({"profile": label, "field": field, "rejected": True})
                    print(f"Sandbox startup: {label}/{field}", flush=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-native-sandbox-http",
                "profiles": profiles,
                "startup": startup,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "migration/llm_sandbox_check.py",
                        *sorted((ROOT / "runtime/src").glob("*.rs")),
                    ]
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["python-image", "image", "minimal-image", "redis-image"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", action="append", default=[])
    main(parser.parse_args())
