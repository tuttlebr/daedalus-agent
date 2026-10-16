#!/usr/bin/env python3
"""Compare approved memory deletion through built-image chat and Stop requests."""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import uuid
from pathlib import Path

from document_tool_receipts_check import normalized as chat_result
from image_check import environment, require, run
from leaf_check import LeafPeers, measure
from nvidia_docs_check import secure_peer
from user_interaction_check import (
    OTHER,
    TOKEN,
    InteractionPeers,
    approval_key,
    scenarios,
)

ROOT = Path(__file__).resolve().parents[1]


def cancel_delete(env, peer, model):
    peer.reset({"fault": "block", "fail_path": "memories"})
    for event in [peer.started, peer.disconnected, peer.release]:
        event.clear()
    model.plan = [
        {
            "name": "interaction_cancel",
            "arguments": {
                "operation": "delete_memory_guarded",
                "approval_token": TOKEN,
            },
        }
    ]
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor() as pool:
        task = pool.submit(measure, env, request_id=request_id, message="hi")
        try:
            require(peer.started.wait(10), "Deletion never reached the Stop barrier")
            require(
                not peer.redis.exists(approval_key()),
                "Deletion did not consume approval before Hindsight",
            )
            env["client"].post(
                env["base"] + f"/v1/runs/{request_id}/control",
                headers=env["headers"],
                json={"type": "cancel", "command_id": str(uuid.uuid4())},
            ).raise_for_status()
            stopped = chat_result(task.result(timeout=5))
            require(
                stopped["done"]
                and stopped["terminal"] == "error"
                and stopped["errors"]
                == [{"error": {"message": "Run cancelled by user"}}],
                "Stop did not terminate memory deletion",
            )
            require(
                peer.disconnected.wait(5), "Stop left the deletion request connected"
            )
            require(len(peer.calls) == 2, "Stopped deletion issued additional requests")
        finally:
            peer.release.set()
    peer.fault = None
    before = len(peer.calls)
    replay = chat_result(measure(env, message="hi"))
    require(
        len(peer.calls) == before and "already used" in json.dumps(replay),
        "Stop allowed reuse of consumed approval",
    )
    peer.reset({})
    recovery = chat_result(measure(env, message="hi"))
    require(
        recovery["done"]
        and not recovery["errors"]
        and "Durable memory cleared." in json.dumps(recovery),
        "Fresh approval did not recover after Stop",
    )
    return {
        "stopped": stopped,
        "replay": replay,
        "recovered": recovery,
        "state": peer.snapshot(),
    }


def main(args):
    peer = InteractionPeers()
    baseline, cancellation_baseline, profiles = None, None, []
    cases = [
        case
        for case in scenarios({}, "unused")
        if not case.get("env")
        and case["name"]
        not in {
            "missing-user",
            "wrong-internal-token",
            "wrong-redis-password",
            "denied-consumption",
            "cache-failure",
        }
    ]
    with secure_peer(peer) as secure:

        def configure(config, *_):
            config["functions"] = {
                f"interaction_{index}": {
                    "_type": "user_interaction",
                    **case.get("config", {}),
                }
                for index, case in enumerate(cases)
            }
            config["functions"]["interaction_cancel"] = {"_type": "user_interaction"}
            for index, case in enumerate(cases):
                if case["name"].startswith("redis-timeout-"):
                    config["functions"][f"interaction_{index}"]["redis_url"] = (
                        "${REDIS_URL}"
                        + case["config"]["redis_url"].removeprefix("unused")
                    )
            config["workflow"]["tools"] = list(config["functions"])

        for label, image, minimal, preparation, authorization in [
            ("retained", args.python_image, False, "python", "python"),
            ("native-full", args.image, False, "rust", "rust"),
            ("native-python-auth", args.image, False, "rust", "python"),
            ("native-minimal", args.minimal_image, True, "rust", "rust"),
        ]:
            model, observed = LeafPeers(), []
            with environment(
                image,
                args.redis_image,
                minimal=minimal,
                memory=True,
                peers=model,
                configure=configure,
                fixture_mounts=[(secure["root"], secure["root"])],
                extra_env=lambda _, p=preparation, a=authorization: {
                    "HINDSIGHT_API_URL": secure["endpoint"],
                    "SSL_CERT_FILE": str(secure["root"] / "ca.pem"),
                    "DAEDALUS_PREPARATION": p,
                    "DAEDALUS_AUTHORIZATION": a,
                    "DAEDALUS_TOOL_EXECUTOR": "disabled"
                    if p == a == "rust"
                    else "python",
                },
            ) as env:
                peer.redis = env["redis"]
                for index, case in enumerate(cases):
                    peer.reset(case)
                    name = f"interaction_{index}"
                    model.plan = [{"name": name, "arguments": case["input"]}]
                    results = []
                    # Real concurrent GETDEL races are exercised by the component
                    # suite. Chat checks replay sequentially for stable SSE order.
                    for _ in range(2 if case.get("parallel") else case.get("count", 1)):
                        before, outputs = len(model.requests), len(model.results)
                        result = chat_result(
                            measure(
                                env,
                                user=OTHER
                                if case["name"] == "other-user"
                                else "synthetic-alice",
                                message="hi",
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
                            result["done"] and not result["errors"],
                            f"Interaction chat failed: {label}/{case['name']}",
                        )
                        results.append(result)
                    item = {
                        "name": case["name"],
                        "results": results,
                        "state": peer.snapshot(),
                    }
                    observed.append(item)
                    if baseline is not None:
                        require(
                            item == baseline[index],
                            f"Interaction HTTP mismatch: {label}/{case['name']}\n{item}\n{baseline[index]}",
                        )
                    print(f"Interaction HTTP: {label}/{case['name']}", flush=True)
                cancellation = cancel_delete(env, peer, model)
                if cancellation_baseline is None:
                    cancellation_baseline = cancellation
                else:
                    require(
                        cancellation == cancellation_baseline,
                        f"Deletion cancellation mismatch: {label}",
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
                "status": "passed-native-user-interaction-http",
                "profiles": profiles,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        ROOT / "runtime/src/user_interaction.rs",
                        ROOT / "runtime/src/hindsight.rs",
                        Path(__file__),
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
    main(parser.parse_args())
