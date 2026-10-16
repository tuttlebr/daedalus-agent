#!/usr/bin/env python3
"""Verify Perplexity schemas, frontend SSE and Stop across built backend profiles."""

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
from nvidia_docs_check import secure_peer
from perplexity_search_check import SearchPeer, scenarios

ROOT = Path(__file__).resolve().parents[1]


def cancel_search(env, peer, model, backoff):
    peer.reset({"responses": [{"status": 429}] if backoff else [{"hold": True}]})
    for event in [
        peer.hold_started,
        peer.hold_disconnected,
        peer.hold_release,
        peer.hold_finished,
    ]:
        event.clear()
    model.plan = [
        {"name": "search_cancel", "arguments": {"query": "Synthetic cancellation"}}
    ]
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor() as pool:
        task = pool.submit(measure, env, request_id=request_id)
        try:
            if backoff:
                deadline = time.monotonic() + 10
                while not peer.calls and time.monotonic() < deadline:
                    threading.Event().wait(0.02)
                require(
                    len(peer.calls) == 1, "Retry never reached cancellation barrier"
                )
                threading.Event().wait(0.1)
            else:
                require(
                    peer.hold_started.wait(10),
                    "Search never reached cancellation barrier",
                )
            env["client"].post(
                env["base"] + f"/v1/runs/{request_id}/control",
                headers=env["headers"],
                json={"type": "cancel", "command_id": str(uuid.uuid4())},
            ).raise_for_status()
            result = chat_result(task.result(timeout=5))
            require(
                result["done"]
                and result["terminal"] == "error"
                and result["errors"]
                == [{"error": {"message": "Run cancelled by user"}}],
                "Stop did not terminate search",
            )
            if not backoff:
                require(peer.hold_disconnected.wait(5), "Stop left search connected")
            require(len(peer.calls) == 1, "Stop retried the provider request")
        finally:
            peer.hold_release.set()
            if not backoff:
                require(
                    peer.hold_finished.wait(5),
                    "Search did not leave cancellation barrier",
                )
    peer.reset({})
    recovery = chat_result(measure(env))
    require(
        recovery["done"] and not recovery["errors"] and len(recovery["ends"]) == 1,
        "Search did not recover after Stop",
    )
    return {"stopped": result, "recovered": recovery}


def main(args):
    peer = SearchPeer()
    profiles, baseline, cancellation_baseline = [], None, None
    with secure_peer(peer) as secure:
        cases = scenarios(secure["endpoint"], "unused")
        # Very short deadlines measure loopback HTTP timing in the component
        # suite. Give TLS handshakes a separate allowance in this chat suite.
        for case in cases:
            if case["name"] == "read-timeout":
                case["config"]["timeout"] = 0.5
                case["peer"]["responses"][0]["delay"] = 1.2
            if case["name"] == "read-idle-timeout":
                case["config"]["timeout"] = 0.5
                case["peer"]["responses"][0]["chunk_delay"] = 0.2
        if args.case:
            selected = set(args.case)
            cases = [case for case in cases if case["name"] in selected]
            require(
                {case["name"] for case in cases} == selected,
                "Unknown Perplexity HTTP case",
            )

        def configure(config, *_):
            config["functions"] = {
                f"search_{index}": {
                    "_type": "perplexity_search",
                    "api_key": "synthetic-key",
                    "base_url": secure["endpoint"] + "/search",
                    "rate_limit_backoff_seconds": 0,
                    **case["config"],
                }
                for index, case in enumerate(cases)
            }
            config["functions"]["search_cancel"] = {
                "_type": "perplexity_search",
                "api_key": "synthetic-key",
                "base_url": secure["endpoint"] + "/search",
                "rate_limit_backoff_seconds": 5,
            }
            config["workflow"]["tools"] = list(config["functions"])

        for label, image, minimal, preparation, authorization in [
            ("retained", args.python_image, False, "python", "python"),
            ("native-full", args.image, False, "rust", "rust"),
            ("native-python-auth", args.image, False, "rust", "python"),
            ("native-minimal", args.minimal_image, True, "rust", "rust"),
        ]:
            model = LeafPeers()
            observed = []
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
                    before, outputs = len(model.requests), len(model.results)
                    name = f"search_{index}"
                    model.plan = [{"name": name, "arguments": case["input"]}]
                    result = chat_result(measure(env))
                    result["model_outputs"] = copy.deepcopy(model.results[outputs:])
                    schemas = [
                        tool.get("function", tool)
                        for tool in model.requests[before]["tools"]
                    ]
                    schema = next(tool for tool in schemas if tool.get("name") == name)
                    result["schema"] = {
                        key: schema[key]
                        for key in ["name", "description", "parameters"]
                    }
                    require(
                        result["done"] and not result["errors"],
                        f"Search chat failed: {label}/{case['name']}",
                    )
                    require(
                        len(result["ends"])
                        == (
                            0 if case["name"] in ["empty-query", "bad-argument"] else 1
                        ),
                        f"Missing search result: {label}/{case['name']}",
                    )
                    item = {
                        "name": case["name"],
                        "result": result,
                        "calls": copy.deepcopy(peer.calls),
                    }
                    observed.append(item)
                    if baseline is not None:
                        require(
                            item == baseline[index],
                            f"Search HTTP mismatch: {label}/{case['name']}\n{item}\n{baseline[index]}",
                        )
                    require(
                        not peer.failures,
                        f"Unexpected search requests: {peer.failures}",
                    )
                    print(f"Perplexity HTTP: {label}/{case['name']}", flush=True)
                cancellation = {
                    "request": cancel_search(env, peer, model, False),
                    "backoff": cancel_search(env, peer, model, True),
                }
                if cancellation_baseline is None:
                    cancellation_baseline = cancellation
                else:
                    require(
                        cancellation == cancellation_baseline,
                        f"Search cancellation mismatch: {label}",
                    )
            if baseline is None:
                baseline = observed
            profiles.append(
                {
                    "name": label,
                    "cases": observed,
                    "cancellation": cancellation,
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
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-native-perplexity-http",
                "profiles": profiles,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "migration/perplexity_search_check.py",
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
