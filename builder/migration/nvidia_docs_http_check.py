#!/usr/bin/env python3
"""Compare NVIDIA docs registration, schemas and chat results in real images."""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import time
import uuid
from pathlib import Path

from document_tool_receipts_check import normalized as chat_result
from image_check import environment, require, run
from leaf_check import LeafPeers, measure
from nvidia_docs_check import DocsPeer, normalized, scenarios, secure_peer

ROOT = Path(__file__).resolve().parents[1]


def cancel_search(env, peer, model):
    peer.reset({"hold_method": "tools/call"})
    for event in [
        peer.hold_started,
        peer.hold_disconnected,
        peer.hold_release,
        peer.hold_finished,
    ]:
        event.clear()
    model.plan = [
        {
            "name": "docs_cancel",
            "arguments": {"product": "dynamo", "query": "Synthetic cancellation"},
        }
    ]
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor() as pool:
        task = pool.submit(measure, env, request_id=request_id)
        try:
            require(
                peer.hold_started.wait(10),
                "Docs call never reached cancellation barrier",
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
                "Stop did not terminate docs search",
            )
            require(peer.hold_disconnected.wait(5), "Stop left docs request connected")
        finally:
            peer.hold_release.set()
            require(
                peer.hold_finished.wait(5),
                "Docs request did not leave cancellation barrier",
            )
    peer.reset({})
    recovery = chat_result(measure(env))
    require(
        recovery["done"] and not recovery["errors"] and len(recovery["ends"]) == 1,
        "Docs search did not recover after Stop",
    )
    return {"stopped": result, "recovered": recovery}


def main(args):
    peer = DocsPeer()
    profiles, baseline = [], None
    cancellation_baseline = None
    cases = scenarios("https://docs.nvidia.com")
    if args.case:
        selected = set(args.case)
        cases = [case for case in cases if case["name"] in selected]
        require({case["name"] for case in cases} == selected, "Unknown docs HTTP case")

    def configure(config, *_):
        config["functions"] = {
            f"docs_{index}": {"_type": "nvidia_docs", "timeout": case["timeout"]}
            for index, case in enumerate(cases)
        }
        config["functions"]["docs_cancel"] = {"_type": "nvidia_docs", "timeout": 30}
        config["workflow"]["tools"] = list(config["functions"])

    with secure_peer(peer) as secure:
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
                    name = f"docs_{index}"
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
                        f"Docs chat failed: {label}/{case['name']}",
                    )
                    guarded = case["name"] in ["empty-query", "invalid-product"]
                    require(
                        len(result["ends"]) == (0 if guarded else 1),
                        f"Missing docs result: {label}/{case['name']}",
                    )
                    if case.get("settle"):
                        time.sleep(case["settle"])
                    item = normalized(
                        {
                            "name": case["name"],
                            "result": result,
                            "calls": copy.deepcopy(peer.calls),
                        }
                    )
                    observed.append(item)
                    if baseline is not None:
                        require(
                            item == baseline[index],
                            f"Docs HTTP mismatch: {label}/{case['name']}\n{item}\n{baseline[index]}",
                        )
                    require(
                        not peer.failures, f"Unexpected docs requests: {peer.failures}"
                    )
                    print(f"NVIDIA docs HTTP: {label}/{case['name']}", flush=True)
                cancellation = cancel_search(env, peer, model)
                if cancellation_baseline is None:
                    cancellation_baseline = cancellation
                else:
                    require(
                        cancellation == cancellation_baseline,
                        f"Docs cancellation mismatch: {label}",
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
                "status": "passed-native-nvidia-docs-http",
                "profiles": profiles,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "migration/nvidia_docs_check.py",
                        ROOT / "migration/leaf_check.py",
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
