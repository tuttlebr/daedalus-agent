#!/usr/bin/env python3
"""Public ingestion JSON/SSE parity against real backend images and service peers."""

import argparse
import base64
import contextlib
import copy
import hashlib
import json
import re
import socket
import time
from pathlib import Path
from urllib.parse import urlsplit

from collections_check import milvus_fixture
from document_runner_check import (
    COLLECTION,
    USER,
    RunnerPeers,
    normalized_nv,
    scenarios,
)
from image_check import environment, require, run
from profile_import_check import expand

ROOT = Path(__file__).resolve().parents[1]


def sequential_ingestion_scripts(oracle, native, count):
    """Keep exact captured writes while accounting for native readiness reads.

    The short capture credentials are projected to this harness's configured
    credentials; the peer still checks every authorization header. Unlike the
    retained SDK, native uploads verify existing vector-index/load readiness and
    read each insert schema explicitly. Those four additional reads are the only
    permitted lifecycle difference for a subsequent document.
    """
    require(1 <= count <= len(oracle["cases"]), "Uncaptured sequential document count")
    authorization = base64.b64encode(b"synthetic-user:synthetic-password").decode()
    stages = []
    for index, case in enumerate(oracle["cases"][:count]):
        require(
            case["expected"]["rows"]
            == {"private_collection": index + 1, "meta": index + 1},
            "Sequential capture lost prior document state",
        )
        script = copy.deepcopy(
            [call for call in case["calls"] if call["method"] != "Connect"]
        )
        for call in script:
            require(
                call["metadata"].get("authorization") == "dTpw",
                "Sequential capture changed its synthetic credentials",
            )
            call["metadata"]["authorization"] = authorization
        if native and index:
            writer = next(
                i for i, call in enumerate(script) if call["method"] == "GetVersion"
            )
            exists = script[writer + 1]
            require(
                exists["method"] == "DescribeCollection"
                and exists["body"] == {"collection_name": "private_collection"}
                and script[writer + 2]["method"] == "DescribeCollection"
                and script[writer + 2]["body"] == {"collection_name": "meta"},
                "Sequential capture changed its collection existence checks",
            )
            repair = copy.deepcopy(
                next(
                    call
                    for call in script
                    if call["method"] == "DescribeIndex"
                    and call["body"] == {"collection_name": "private_collection"}
                )
            )
            # Repair is a MilvusClient read, while this captured listing used
            # the ORM's default database. Preserve the client's exact context.
            repair["metadata"] = copy.deepcopy(exists["metadata"])
            loaded = copy.deepcopy(
                next(
                    call
                    for call in stages[0]
                    if call["method"] == "GetLoadingProgress"
                    and call["body"] == {"collection_name": "private_collection"}
                )
            )
            expanded = []
            for position, call in enumerate(script):
                if call["method"] == "Insert":
                    schema = copy.deepcopy(
                        next(
                            probe
                            for probe in script
                            if probe["method"] == "DescribeCollection"
                            and probe["body"]["collection_name"]
                            == call["body"]["collection_name"]
                        )
                    )
                    schema["metadata"] = copy.deepcopy(call["metadata"])
                    expanded.append(schema)
                expanded.append(call)
                if position == writer + 1:
                    expanded.extend([repair, loaded])
            script = expanded
        stages.append(script)
    return stages


def stream_events(response):
    event = None
    for line in response.iter_lines():
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            yield event, json.loads(line[6:])


def disconnect_check(
    fixture, peers, milvus, oracle, sequential, uri, *, native=False, streaming=True
):
    """Disconnect a two-document batch while its first write is in flight.

    A second HTTP request reaching `waiting` is the barrier proving that the
    abandoned writer still owns the collection. Release the write only after
    observing that barrier. SSE cancels the queued document; the retained JSON
    handler continues the whole batch after a disconnect.
    """
    case = copy.deepcopy(scenarios(oracle)[0])
    peers.reset(case)
    queued = {**case["request"]["documentRef"], "documentId": "queued-document"}
    fixture["redis"].execute_command(
        "JSON.SET",
        "document:synthetic-session:queued-document",
        "$",
        json.dumps(case["record"]),
    )
    collection = "migration_disconnect_" + ("stream" if streaming else "json")
    expected_inserts = 2 if streaming else 3
    physical = collection + "_" + COLLECTION.removeprefix("user_uploads_")
    stages = sequential_ingestion_scripts(sequential, native, expected_inserts)
    probes, writers = [], []
    for stage in stages:
        first_write = next(
            i for i, call in enumerate(stage) if call["method"] == "GetVersion"
        )
        probes.append(stage[:first_write])
        writers.extend(stage[first_write:])
    settings = {
        "uri": uri,
        "live_receipt_clock": True,
        "allow_cached_schema_reads": True,
        "rename_collections": {"private_collection": physical},
        "script": writers,
        "probe_scripts": probes,
        "delay": {"Insert": {"seconds": 60, "count": 1}},
    }
    control = milvus["control"]
    control.post("/reset", json=settings).raise_for_status()
    client, url, headers = (
        fixture["client"],
        fixture["base"] + "/v1/documents/ingest/stream",
        fixture["headers"],
    )
    try:

        def writer_calls(calls):
            return [
                call
                for call in calls
                if call["method"] != "Connect" and call.get("phase") != "probe"
            ]

        with contextlib.ExitStack() as first_connection:
            body = {
                "documentRefs": [case["request"]["documentRef"], queued],
                "collection_name": collection,
            }
            if streaming:
                first = first_connection.enter_context(
                    client.stream("POST", url, headers=headers, json=body)
                )
                first.raise_for_status()
                # Retain the iterator until Insert is observed. Closing a
                # temporary HTTPX iterator on break would disconnect during
                # extraction, before this test reaches the owned write.
                first_events = first_connection.enter_context(
                    contextlib.closing(stream_events(first))
                )
                for event, payload in first_events:
                    require(event == "progress", "First stream ended before indexing")
                    if payload["phase"] == "processing":
                        break
            else:
                # httpx waits for headers before yielding its stream context.
                # JSON sends no headers until completion, so own the TCP socket.
                address = urlsplit(fixture["base"])
                first = first_connection.enter_context(
                    socket.create_connection(
                        (address.hostname, address.port), timeout=10
                    )
                )
                payload = json.dumps(body).encode()
                head = (
                    "POST /v1/documents/ingest HTTP/1.1\r\n"
                    + f"Host: {address.netloc}\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(payload)}\r\n"
                    + "".join(f"{name}: {value}\r\n" for name, value in headers.items())
                    + "\r\n"
                )
                first.sendall(head.encode() + payload)
            deadline = time.monotonic() + 10
            while True:
                calls = control.get("/calls").json()
                if any(call["method"] == "Insert" for call in calls):
                    break
                require(time.monotonic() < deadline, "Writer never reached Insert")
                time.sleep(0.02)
        # Exiting the stream closes its HTTP connection before the successor.
        with client.stream(
            "POST",
            url,
            headers=headers,
            json={
                "documentRef": case["request"]["documentRef"],
                "collection_name": collection,
            },
        ) as successor:
            successor.raise_for_status()
            events = stream_events(successor)
            for event, payload in events:
                require(event == "progress", "Successor ended before collection wait")
                if payload["phase"] == "waiting":
                    break
            held = control.get("/calls").json()
            require(
                writer_calls(held) == writer_calls(calls),
                "Disconnect released an in-flight collection lock",
            )
            require(
                sum(call["method"] == "POST" for call in peers.document_calls)
                == (2 if native else 1),
                "Successor changed the extraction/write ownership boundary",
            )
            control.post("/release").raise_for_status()
            remaining = list(events)
            require(
                remaining and remaining[-1][0] == "complete",
                f"Successor stream did not complete: {remaining}",
            )
        deadline = time.monotonic() + 10
        while True:
            state = control.get("/script").json()
            if state["remaining"] == 0 or state["errors"] or streaming:
                break
            require(
                time.monotonic() < deadline,
                f"Disconnected JSON batch did not finish: {state}",
            )
            time.sleep(0.02)
        calls = control.get("/calls").json()
        require(
            control.get("/script").json()
            == {"remaining": 0, "errors": [], "probe_remaining": 0},
            "Disconnected writer/successor changed the Milvus lifecycle",
        )
        require(not any(call["cancelled"] for call in calls), "Started write cancelled")
        require(
            sum(call["method"] == "POST" for call in peers.document_calls)
            == expected_inserts,
            "HTTP disconnect changed queued document ownership",
        )
        inserts = [call for call in calls if call["method"] == "Insert"]
        require(
            sum(call["body"]["collection_name"] == physical for call in inserts)
            == expected_inserts,
            "Unexpected abandoned batch/successor insert count",
        )
        return {
            "name": "disconnect-owns-write-"
            + ("cancels-queue" if streaming else "finishes-json-batch"),
            "complete": remaining[-1][1],
            "document_inserts": expected_inserts,
            "queued_started": not streaming,
        }
    finally:
        control.post("/release")


def exercise(
    image,
    redis_image,
    sdk_image,
    *,
    native=False,
    minimal=False,
    options=None,
    disconnect_only=False,
):
    oracle = expand(
        json.loads((ROOT / "runtime/tests/fixtures/milvus-index.json").read_text())
    )
    sequential = expand(
        json.loads(
            (ROOT / "runtime/tests/fixtures/milvus-index-sequential.json").read_text()
        )
    )
    validation = expand(
        json.loads((ROOT / "runtime/tests/fixtures/document-index.json").read_text())
    )
    results = []
    with milvus_fixture(sdk_image) as milvus:
        uri = f"http://127.0.0.1:{milvus['port']}"
        peers = RunnerPeers(None)
        with environment(
            image,
            redis_image,
            minimal=minimal,
            memory=False,
            peers=peers,
            redis_json=True,
            extra_env=lambda port: {
                "DAEDALUS_PREPARATION": "rust" if native else "python",
                "DAEDALUS_AUTHORIZATION": "rust" if native else "python",
                "NV_INGEST_HOST": "127.0.0.1",
                "NV_INGEST_PORT": str(port),
                "MILVUS_URI": uri,
                "MILVUS_USERNAME": "synthetic-user",
                "MILVUS_PASSWORD": "synthetic-password",
                "EMBEDDING_DENSE_DIM": "2",
                "DOCUMENT_INGEST_MAX_RETRIES": "0",
                "DOCUMENT_INGEST_TIMEOUT_SECONDS": "30",
                "DOCUMENT_OBJECT_ENDPOINT": f"http://127.0.0.1:{port}",
                "DOCUMENT_OBJECT_ACCESS_KEY": "synthetic-object-access",
                "DOCUMENT_OBJECT_SECRET_KEY": "synthetic-object-secret",
                "DOCUMENT_OBJECT_BUCKET": "synthetic-documents",
                **(options or {}),
            },
        ) as fixture:
            peers.admin = fixture["redis"]
            cases = scenarios(oracle)
            if disconnect_only:
                return [
                    disconnect_check(
                        fixture,
                        peers,
                        milvus,
                        oracle,
                        sequential,
                        uri,
                        native=native,
                        streaming=False,
                    )
                ]

            def call(
                name,
                body,
                route,
                *,
                case=None,
                headers=None,
                method="POST",
                suffix="",
                extra_records=None,
            ):
                case = copy.deepcopy(case or cases[0])
                if name.startswith("validation-") or headers == {} or method != "POST":
                    case["settings"]["script"] = []
                peers.reset(case)
                for document_id, record in (extra_records or {}).items():
                    fixture["redis"].execute_command(
                        "JSON.SET",
                        "document:synthetic-session:" + document_id,
                        "$",
                        json.dumps(record),
                    )
                settings = case["settings"]
                settings["uri"] = uri
                settings["live_receipt_clock"] = True
                settings["allow_cached_schema_reads"] = True
                collection = (
                    body.get("collection_name") or body.get("collection") or USER
                    if isinstance(body, dict)
                    else USER
                )
                if not isinstance(collection, str):
                    collection = USER
                normalized = (
                    re.sub("_+", "_", re.sub("[^a-zA-Z0-9_]+", "_", collection))
                    .strip("_")
                    .lower()
                )
                part = COLLECTION.removeprefix("user_uploads_")
                physical = (
                    normalized
                    if normalized.endswith("_" + part)
                    else normalized + "_" + part
                )
                settings["rename_collections"] = {"private_collection": physical}
                milvus["control"].post("/reset", json=settings).raise_for_status()
                response = fixture["client"].request(
                    method,
                    fixture["base"] + "/v1/documents/" + route + suffix,
                    headers=fixture["headers"] if headers is None else headers,
                    json=body,
                )
                ctype = response.headers.get("content-type", "")
                payload = (
                    response.json() if "application/json" in ctype else response.text
                )
                state = milvus["control"].get("/script").json()
                require(
                    state == {"remaining": 0, "errors": []},
                    f"{name}: {state}; {payload}",
                )
                require(
                    all(call["signature_valid"] for call in peers.object_calls),
                    f"{name}: S3 signature failure",
                )
                result = {
                    "name": name,
                    "status": response.status_code,
                    "body": payload,
                    "headers": {
                        key: response.headers[key]
                        for key in [
                            "content-type",
                            "cache-control",
                            "x-accel-buffering",
                            "allow",
                            "location",
                        ]
                        if key in response.headers
                    },
                    "nv_calls": normalized_nv(peers.document_calls),
                    "object_calls": copy.deepcopy(peers.object_calls),
                }
                # Redirect origins belong to the retained proxy; targets/query
                # strings are the public contract, and native redirects are relative.
                if "location" in result["headers"]:
                    result["headers"]["location"] = re.sub(
                        r"^https?://[^/]+", "", result["headers"]["location"]
                    )
                results.append(result)
                return result

            multiple = copy.deepcopy(cases[0])
            multiple["settings"]["script"] = [
                call
                for stage in sequential_ingestion_scripts(sequential, native, 2)
                for call in stage
            ]
            reference = cases[0]["request"]["documentRef"]
            extra_records = {
                "second-document": cases[0]["record"],
                "foreign-document": {**cases[0]["record"], "userId": "another-user"},
            }
            references = [reference, {**reference, "documentId": "second-document"}]
            if options is not None:
                for route in ["ingest", "ingest/stream"]:
                    configured = copy.deepcopy(multiple)
                    if not {
                        "DOCUMENT_INGEST_BATCH_CONCURRENCY",
                        "MINIO_BUCKET",
                    }.intersection(options):
                        configured["settings"]["script"] = []
                    call(
                        "configured-" + route,
                        {
                            "documentRefs": references,
                            "collection_name": "configured_" + route.replace("/", "_"),
                        },
                        route,
                        case=configured,
                        extra_records=extra_records,
                    )
                return results

            for route in ["ingest", "ingest/stream"]:
                call("missing-auth-" + route, {}, route, headers={})
                call("method-" + route, {}, route, method="GET")
                call(
                    "slash-" + route,
                    {},
                    route,
                    method="GET",
                    suffix="/?source=synthetic",
                )
                for i, item in enumerate(validation["validation"]):
                    if item["status"] == 422:
                        result = call(f"validation-{route}-{i}", item["input"], route)
                        require(
                            result["status"] == 422
                            and result["body"] == item["expected"],
                            f"Validation changed: {result}",
                        )
                for i, case in enumerate(cases):
                    body = copy.deepcopy(case["request"])
                    body.setdefault(
                        "collection_name", f"migration_{route.replace('/', '_')}_{i}"
                    )
                    call(route + "-" + case["name"], body, route, case=case)
                duplicate = copy.deepcopy(cases[0])
                body = {
                    "documentRefs": [duplicate["request"]["documentRef"]] * 3,
                    "collection_name": "migration_duplicates_"
                    + route.replace("/", "_"),
                }
                call(route + "-duplicates", body, route, case=duplicate)
                for mixed in [False, True]:
                    call(
                        route + ("-partial-batch" if mixed else "-multiple"),
                        {
                            "documentRefs": references
                            + (
                                [{**reference, "documentId": "foreign-document"}]
                                if mixed
                                else []
                            ),
                            "collection_name": f"multiple_{route.replace('/', '_')}_{mixed}",
                        },
                        route,
                        case=multiple,
                        extra_records=extra_records,
                    )
                print(f"Verified {image}: {route}", flush=True)
            results.append(
                disconnect_check(
                    fixture, peers, milvus, oracle, sequential, uri, native=native
                )
            )
            results.append(
                disconnect_check(
                    fixture,
                    peers,
                    milvus,
                    oracle,
                    sequential,
                    uri,
                    native=native,
                    streaming=False,
                )
            )
            print(f"Verified {image}: ingestion disconnect ownership", flush=True)
            if minimal:
                run(
                    "docker",
                    "exec",
                    fixture["container"],
                    "sh",
                    "-c",
                    "! command -v python && ! command -v python3",
                )
    return results


def main(args):
    args.report.parent.mkdir(parents=True, exist_ok=True)
    baseline = exercise(args.baseline, args.redis_image, args.baseline)
    args.report.with_name(args.report.stem + "-baseline.json").write_text(
        json.dumps(baseline, indent=2) + "\n"
    )
    profiles = [{"image": args.baseline, "native": False, "cases": len(baseline)}]
    candidates = [(args.image, True, True)]
    if args.full_image:
        candidates += [(args.full_image, False, False), (args.full_image, True, False)]
    for image, native, minimal in candidates:
        result = exercise(
            image, args.redis_image, args.baseline, native=native, minimal=minimal
        )
        for old, new in zip(baseline, result, strict=True):
            require(old == new, f"Ingestion mismatch: {old}\nActual: {new}")
        profiles.append({"image": image, "native": native, "cases": len(result)})
    operators = []
    for options in [
        {"DOCUMENT_INGEST_REQUEST_LIMIT": "1"},
        {"DOCUMENT_INGEST_REQUEST_LIMIT": "0"},
        {"DOCUMENT_INGEST_REQUEST_LIMIT": "-1"},
        {"DOCUMENT_INGEST_CHUNK_SIZE": "invalid"},
        {"DOCUMENT_INGEST_WORKER_POOL_SIZE": "0"},
        {"DOCUMENT_INGEST_MAX_RETRIES": "-1"},
        {"MINIO_BUCKET": ""},
        {"MINIO_BUCKET": " nv-ingest "},
        {
            "DOCUMENT_INGEST_BATCH_CONCURRENCY": "2",
            "DOCUMENT_INGEST_MAX_DOCUMENTS_PER_BATCH": "1",
        },
    ]:
        old = exercise(args.baseline, args.redis_image, args.baseline, options=options)
        new = exercise(
            args.image,
            args.redis_image,
            args.baseline,
            native=True,
            minimal=True,
            options=options,
        )
        require(
            old == new,
            f"Ingestion configuration mismatch {options}: {old}\nActual: {new}",
        )
        operators.append({"options": options, "results": old})
        print(f"Verified ingestion options: {options}", flush=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed",
                "profiles": profiles,
                "operators": operators,
                "image_ids": {
                    image: run(
                        "docker",
                        "image",
                        "inspect",
                        image,
                        "--format",
                        "{{.Id}}",
                        capture_output=True,
                        text=True,
                    ).stdout.strip()
                    for image in {
                        args.baseline,
                        args.image,
                        args.redis_image,
                        args.full_image,
                    }
                    if image
                },
                "oracle_sha256": hashlib.sha256(
                    json.dumps(baseline).encode()
                ).hexdigest(),
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in sorted(
                        {
                            *ROOT.glob("runtime/src/document*.rs"),
                            *ROOT.glob("runtime/src/milvus*.rs"),
                            ROOT / "runtime/src/collections.rs",
                            ROOT / "runtime/src/preparation.rs",
                            ROOT / "runtime/src/main.rs",
                            ROOT / "runtime/src/nv_ingest.rs",
                            ROOT / "document_ingest_api.py",
                            ROOT / "nat_nv_ingest/src/nat_nv_ingest/nat_nv_ingest.py",
                            ROOT / "migration/ingestion_check.py",
                            ROOT / "migration/milvus_peer.py",
                            ROOT / "migration/milvus_probe.py",
                            ROOT / "migration/document_runner_check.py",
                            ROOT / "migration/export_milvus_index.py",
                            ROOT
                            / "runtime/tests/fixtures/milvus-index-sequential.json",
                        }
                    )
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ["baseline", "image", "redis-image"]:
        parser.add_argument("--" + arg, required=True)
    parser.add_argument("--full-image")
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
