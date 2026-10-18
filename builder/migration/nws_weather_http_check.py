#!/usr/bin/env python3
"""Compare built NWS tools through authenticated chat with actual DNS/TLS peers."""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from document_tool_receipts_check import normalized as chat_result
from image_check import environment, require, run
from leaf_check import LeafPeers, measure
from nws_weather_check import POINT, weather_scenarios
from public_http_namespace import fixture

ROOT = Path(__file__).resolve().parents[1]


def state_when(control, predicate, message):
    deadline = time.monotonic() + 8
    while True:
        state = control.get("/state").json()
        if predicate(state):
            return state
        require(time.monotonic() < deadline, message)
        time.sleep(0.02)


def stop(env, *, shared):
    control = env["namespace"]["control"]
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor() as pool:
        task = pool.submit(measure, env, request_id=request_id, message="hi")
        state_when(
            control,
            lambda state: state["held"] == 1,
            "Weather did not reach cancellation barrier",
        )
        env["client"].post(
            env["base"] + f"/v1/runs/{request_id}/control",
            headers=env["headers"] | {"x-conversation-id": request_id},
            json={"type": "cancel", "command_id": str(uuid.uuid4())},
        ).raise_for_status()
        result = chat_result(task.result(timeout=8))
        require(
            result["done"]
            and result["terminal"] == "error"
            and result["errors"] == [{"error": {"message": "Run cancelled by user"}}],
            "Stop did not terminate weather chat",
        )
        if shared:
            require(
                control.get("/state").json()["disconnected"] == 0,
                "Stop aborted the shared points load",
            )
        else:
            state_when(
                control,
                lambda state: state["disconnected"] == 1,
                "Stop left unshared alerts transport connected",
            )
    return result


def normalized(value, earliest, latest):
    """Validate wall-clock fields before replacing only their varying values.

    Production clocks are never patched. Source timestamps, coverage boundaries,
    timezone offsets and JSON field order remain part of the comparison. JSON
    string wrappers are serialized consistently; component gates separately
    compare the complete tool text byte for byte with a test-only fixed clock.
    """
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return value
        if isinstance(parsed, (dict, list)):
            return json.dumps(normalized(parsed, earliest, latest), ensure_ascii=True)
        return value
    if isinstance(value, list):
        return [normalized(item, earliest, latest) for item in value]
    if not isinstance(value, dict):
        return value
    value = copy.deepcopy(value)
    if "fetched_at" in value:
        fetched = datetime.fromisoformat(value["fetched_at"])
        require(fetched.utcoffset().total_seconds() == 0, "Fetch time is not UTC")
        require(earliest <= fetched <= latest, "Fetch time outside request lifetime")
        value["fetched_at"] = "<validated UTC fetch time>"
    if "coverage" in value:
        coverage = value["coverage"]
        start = datetime.fromisoformat(coverage["start"])
        require(earliest <= start <= latest, "Coverage did not start at current time")
        coverage["start"] = "<current time>" + start.strftime("%z")
        for gap in coverage["gaps"]:
            if datetime.fromisoformat(gap["start"]) == start:
                original = datetime.fromisoformat(gap["start"])
                gap["start"] = "<current time>" + original.strftime("%z")
    return {key: normalized(item, earliest, latest) for key, item in value.items()}


def main(args):
    profiles, baseline, startup, preparation_failures = [], None, [], []
    candidates = [
        ("retained", args.python_image, False, "python", "python"),
        ("native-full", args.image, False, "rust", "rust"),
        ("native-python-auth", args.image, False, "rust", "python"),
        ("native-minimal", args.minimal_image, True, "rust", "rust"),
    ]
    cases = [
        case
        for case in weather_scenarios(datetime.now(UTC))
        if not case.get("factory_error")
    ]
    for name, path in [
        ("stop_preserves_shared_points", POINT),
        ("stop_disconnects_alerts", "/alerts/active?point=42.3000,-83.1000"),
        ("shutdown_aborts_pending_points", POINT),
    ]:
        case = copy.deepcopy(cases[0])
        case.update(
            name=name,
            cancel=True,
            shared=path == POINT,
            shutdown=name.startswith("shutdown"),
        )
        case["responses"][path]["hold"] = True
        if not case["shutdown"]:
            case["inputs"] *= 2
        cases.append(case)
    if args.case:
        selected = set(args.case)
        cases = [case for case in cases if case["name"] in selected]
        require(
            {case["name"] for case in cases} == selected, "Unknown weather HTTP case"
        )

    def configure(config, *_):
        config["functions"] = {
            f"nws_weather_{index}": {"_type": "nws_weather", **case["config"]}
            for index, case in enumerate(cases)
        }
        config["workflow"].update(
            tools=list(config["functions"]), tool_output_compaction_enabled=False
        )

    def modes(preparation, authorization):
        return {
            "DAEDALUS_PREPARATION": preparation,
            "DAEDALUS_AUTHORIZATION": authorization,
            "DAEDALUS_TOOL_EXECUTOR": "disabled"
            if preparation == authorization == "rust"
            else "python",
        }

    for label, image, minimal, preparation, authorization in candidates:
        model, observed, handshakes = LeafPeers(), [], []
        earliest = datetime.now(UTC)
        with environment(
            image,
            args.redis_image,
            minimal=minimal,
            memory=False,
            peers=model,
            configure=configure,
            namespace_factory=fixture(args.python_image, minimal=minimal),
            extra_env=lambda _, p=preparation, a=authorization: modes(p, a),
        ) as env:
            control = env["namespace"]["control"]
            for index, case in enumerate(cases):
                control.post("/reset", json=case).raise_for_status()
                results, fetched_points = [], []
                name = f"nws_weather_{index}"
                for step, arguments in enumerate(case["inputs"]):
                    before, outputs = len(model.requests), len(model.results)
                    model.plan = [{"name": name, "arguments": arguments}]
                    cancelling = case.get("cancel") and step == 0
                    result = (
                        stop(env, shared=case["shared"])
                        if cancelling
                        else chat_result(measure(env, message="hi"))
                    )
                    if cancelling and not case["shutdown"]:
                        control.post("/release").raise_for_status()
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
                        result["done"],
                        f"Incomplete weather chat: {label}/{case['name']}",
                    )
                    for event in result["ends"]:
                        try:
                            payload = json.loads(event["payload"])
                        except (ValueError, TypeError):
                            continue
                        if isinstance(payload, dict) and "location" in payload:
                            fetched_points.append(payload["location"]["fetched_at"])
                    results.append(normalized(result, earliest, datetime.now(UTC)))
                if len(fetched_points) > 1:
                    require(
                        len(set(fetched_points)) == 1,
                        "Cached point changed its fetched timestamp",
                    )
                if case.get("shutdown"):
                    run(
                        "docker",
                        "stop",
                        "--time",
                        "5",
                        env["container"],
                        capture_output=True,
                    )
                    state_when(
                        control,
                        lambda state: state["disconnected"] == 1,
                        "Shutdown left shared weather transport connected",
                    )
                state = control.get("/state").json()
                handshakes.append({"name": case["name"], "sni": state["sni"]})
                if case.get("shared"):
                    require(
                        sum(call["path"] == POINT for call in state["calls"]) == 1,
                        "Cancelled caller lost shared points work",
                    )
                item = {
                    "name": case["name"],
                    "results": results,
                    "calls": sorted(
                        state["calls"],
                        key=lambda entry: json.dumps(entry, sort_keys=True),
                    ),
                    # Concurrent requests may open a different number of pooled
                    # TLS connections. Compare destinations and retain every
                    # handshake separately; HTTP calls and payloads stay exact.
                    "sni": sorted(set(state["sni"])),
                    "disconnected": state["disconnected"],
                }
                if baseline is not None and item != baseline[index]:
                    args.report.parent.mkdir(parents=True, exist_ok=True)
                    failed = args.report.with_suffix(".failed.json")
                    failed.write_text(
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
                        f"Weather HTTP mismatch: {label}/{case['name']}; details in {failed}",
                    )
                observed.append(item)
                print(f"Weather HTTP: {label}/{case['name']}", flush=True)
        if baseline is None:
            baseline = observed
        profiles.append(
            {
                "name": label,
                "cases": observed,
                "tls_handshakes": handshakes,
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
                ("timeout", 0),
                ("points_cache_ttl_seconds", -1),
                ("unknown_weather_setting", True),
            ]:

                def invalid_config(config, *_):
                    config["functions"] = {
                        "weather": {"_type": "nws_weather", field: value}
                    }
                    config["workflow"]["tools"] = ["weather"]

                try:
                    with environment(
                        image,
                        args.redis_image,
                        minimal=minimal,
                        memory=False,
                        configure=invalid_config,
                        extra_env=lambda _, p=preparation, a=authorization: modes(p, a),
                    ):
                        raise AssertionError(
                            f"Invalid weather configuration reached readiness: {label}/{field}"
                        )
                except RuntimeError as error:
                    require(
                        "configuration" in str(error).lower()
                        or field in str(error)
                        or "ValidationError" in str(error)
                        or "ascii" in str(error).lower(),
                        f"Unexpected startup failure: {error}",
                    )
                startup.append({"profile": label, "field": field, "rejected": True})
                print(f"Weather startup: {label}/{field}", flush=True)
            for field, value in [
                ("user_agent", "Synthetic 雪"),
                ("description", " \t "),
            ]:

                def invalid_factory(config, *_):
                    config["functions"] = {
                        "weather": {"_type": "nws_weather", field: value}
                    }
                    config["workflow"]["tools"] = ["weather"]

                model = LeafPeers()
                model.plan = [
                    {
                        "name": "weather",
                        "arguments": {"latitude": 42.3, "longitude": -83.1},
                    }
                ]
                with environment(
                    image,
                    args.redis_image,
                    minimal=minimal,
                    memory=False,
                    peers=model,
                    configure=invalid_factory,
                    extra_env=lambda _, p=preparation, a=authorization: modes(p, a),
                ) as env:
                    result = chat_result(measure(env, message="hi"))
                    require(
                        result
                        == {
                            "starts": [],
                            "ends": [],
                            "terminal": "error",
                            "errors": [
                                {
                                    "error": {
                                        "message": "Agent execution failed; completed output has been preserved"
                                    }
                                }
                            ],
                            "answer": "",
                            "activity_comments": 0,
                            "done": True,
                            "peak_tools": 0,
                        },
                        f"Weather factory failure changed chat contract: {label}/{field}: {result}",
                    )
                    require(
                        not model.requests, "Invalid weather factory reached the model"
                    )
                preparation_failures.append(
                    {"profile": label, "field": field, "result": result}
                )
                print(f"Weather preparation: {label}/{field}", flush=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-native-nws-weather-http",
                "profiles": profiles,
                "startup": startup,
                "preparation_failures": preparation_failures,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "migration/nws_weather_check.py",
                        ROOT / "migration/public_http_namespace.py",
                        ROOT / "migration/public_http_peer.py",
                        ROOT / "migration/image_check.py",
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
