"""Capture the document boundary after retained-SDK search result decoding."""

import argparse
import base64
import copy
import hashlib
import inspect
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

from export_authorization import fixture_strings


def expand(value):
    if isinstance(value, dict):
        if set(value) == {"$string_parts"}:
            return "".join(value["$string_parts"])
        return {key: expand(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item) for item in value]
    return value


@contextmanager
def search_peer():
    import grpc
    from google.protobuf.json_format import MessageToDict
    from pymilvus import MilvusClient
    from pymilvus.grpc_gen import milvus_pb2

    state = {"calls": 0}

    def search(request, context):
        state["calls"] += 1
        call = {
            "method": "Search",
            "body": MessageToDict(
                request, preserving_proto_field_name=True, use_integers_for_enums=True
            ),
            "base64": base64.b64encode(request.SerializeToString()).decode(),
            "metadata": {
                key: value
                for key, value in context.invocation_metadata()
                if key in ["authorization", "dbname", "client-request-id"]
            },
        }
        if "call" not in state:
            state["call"] = call
        elif call != state["call"]:
            raise RuntimeError("SDK changed the document search request")
        return state["response"]

    server = grpc.server(ThreadPoolExecutor(max_workers=4))
    handlers = {}
    for name, function, request in [
        (
            "Connect",
            lambda _request, _context: milvus_pb2.ConnectResponse(identifier=1),
            milvus_pb2.ConnectRequest,
        ),
        ("Search", search, milvus_pb2.SearchRequest),
    ]:
        handlers[name] = grpc.unary_unary_rpc_method_handler(
            function,
            request_deserializer=request.FromString,
            response_serializer=lambda value: value.SerializeToString(),
        )
    server.add_generic_rpc_handlers(
        (
            grpc.method_handlers_generic_handler(
                "milvus.proto.milvus.MilvusService", handlers
            ),
        )
    )
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        client = MilvusClient(uri=f"http://127.0.0.1:{port}")
        try:
            yield client, state
        finally:
            client.close()
    finally:
        server.stop(0).wait()


def export(root, revision, client, state):
    import numpy
    import pymilvus
    from daedalus_runtime.retrieval import Document
    from nat_nv_ingest.nat_nv_ingest import format_user_document_search_results
    from pydantic import ValidationError
    from pymilvus import MilvusClient
    from pymilvus.client.abstract import SearchResult
    from pymilvus.client.grpc_handler import GrpcHandler
    from pymilvus.grpc_gen import milvus_pb2
    from smart_milvus.smart_milvus_function import _wrap_milvus_results

    logging.disable(logging.CRITICAL)
    source = root / "tests/fixtures/milvus-search.json"
    retained = expand(json.loads(source.read_text()))
    cases = []
    seen = set()

    def capture(name, response, content_field="content", cutoff=None):
        wire = base64.b64encode(response.SerializeToString()).decode()
        state["response"] = response
        previous_calls = state["calls"]
        try:
            # Construction errors pass through the SDK retry decorators;
            # lazy materialization and Document errors happen after it returns.
            results = client.search(
                collection_name="synthetic",
                data=[[0.1]],
                limit=5,
                anns_field="vector",
            )
            hits = results[0]
            if cutoff is not None:
                hits = [
                    hit
                    for hit in hits
                    if getattr(hit, "distance", None) is not None
                    and hit.distance <= cutoff
                ]
            documents = _wrap_milvus_results(hits, content_field=content_field)
            expected = {
                "ok": format_user_document_search_results(documents, "synthetic")
            }
        except Exception as error:
            expected = {"error": type(error).__name__}
            if isinstance(error, ValidationError):
                expected["validation"] = error.errors(
                    include_input=False, include_url=False
                )
        cases.append(
            {
                "name": name,
                "response": wire,
                "content_field": content_field,
                "distance_cutoff": cutoff,
                "search_rpcs": state["calls"] - previous_calls,
                "expected": expected,
            }
        )

    for case in retained["cases"]:
        if case["fault"] or not case["calls"]:
            continue
        wire = case["calls"][-1]["response_base64"]
        if wire in seen:
            continue
        seen.add(wire)
        response = milvus_pb2.SearchResults.FromString(base64.b64decode(wire))
        capture(case["name"], response)
        for field in response.results.fields_data:
            if field.field_name != "content":
                continue
            for mode in ["empty", "null", "missing"]:
                changed = copy.deepcopy(response)
                content = next(
                    f for f in changed.results.fields_data if f.field_name == "content"
                )
                if mode == "missing":
                    changed.results.fields_data.remove(content)
                elif mode == "empty":
                    for index in range(len(content.scalars.string_data.data)):
                        content.scalars.string_data.data[index] = ""
                else:
                    del content.valid_data[:]
                    content.valid_data.extend(
                        False for _ in content.scalars.string_data.data
                    )
                capture(f"{case['name']}-{mode}", changed)
            break
        # Selecting each returned field as content also captures Document's
        # validation of numbers, vectors, JSON, UTF-8 bytes and missing values.
        for field in response.results.fields_data:
            if field.field_name not in {"content", "$meta"}:
                capture(
                    f"{case['name']}-content-{field.field_name}",
                    response,
                    content_field=field.field_name,
                )
        if case["name"] == "default":
            # JSON result fields use orjson's depth and numeric conversion,
            # independently of the schema metadata decoder.
            for label, raw in [
                ("signed-boundary", str(-(2**63))),
                ("unsigned-boundary", str(2**64 - 1)),
                ("large-positive", str(2**64)),
                ("large-negative", str(-(2**63) - 1)),
                ("large-integer", "9" * 300),
                ("integer-overflow", "9" * 400),
                ("exponent-overflow", "1e400"),
                ("negative-zero", "-0.0"),
                *[
                    (f"depth-{depth}", "[" * depth + "0" + "]" * depth)
                    for depth in [128, 256, 1024, 1025]
                ],
            ]:
                changed = copy.deepcopy(response)
                field = changed.results.fields_data[1]
                field.ClearField("scalars")
                field.type = 23
                if label.startswith("depth-"):
                    field.field_name = "payload"
                field.scalars.json_data.data.extend([raw.encode()] * 2)
                capture("json-result-" + label, changed)
            for cutoff in [0, -1, 0.125, 0.126, 2.5]:
                capture(f"distance-cutoff-{cutoff}", response, cutoff=cutoff)
            for score in [float("nan"), float("inf"), -float("inf"), -0.0]:
                changed = copy.deepcopy(response)
                changed.results.scores[0] = score
                capture(f"score-{score}", changed)
                capture(f"score-{score}-cutoff", changed, cutoff=2.5)

    # All binary16 values are finite in number. Hash the complete scalar text
    # space, retaining representative values to make mismatches reviewable.
    halves = numpy.arange(65536, dtype=numpy.uint16).view(numpy.float16)
    half_strings = [str(value) for value in halves]
    half_reprs = [repr(value) for value in halves]
    half_samples = sorted(
        set(range(65))
        | {
            1023,
            1024,
            1025,
            9216,
            31743,
            31744,
            32767,
            32768,
            41984,
            64511,
            64512,
            65535,
        }
        | {index * 127 for index in range(512)}
    )
    byte_values = [
        b"",
        bytes(range(256)),
        b"'",
        b'"',
        b"'\"\\\n\r\t",
        b"Synthetic \xe9\x9b\xaa",
    ]

    output = {
        "revision": revision,
        "pymilvus_version": pymilvus.__version__,
        "numpy_version": numpy.__version__,
        "search_call": state["call"],
        "wire_fixture_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source_sha256": {
            item.__name__: hashlib.sha256(
                Path(inspect.getfile(item)).read_bytes()
            ).hexdigest()
            for item in [
                SearchResult,
                MilvusClient,
                GrpcHandler,
                Document,
                _wrap_milvus_results,
                format_user_document_search_results,
            ]
        },
        "float16": {
            "str_sha256": hashlib.sha256(
                ("\n".join(half_strings) + "\n").encode()
            ).hexdigest(),
            "repr_sha256": hashlib.sha256(
                ("\n".join(half_reprs) + "\n").encode()
            ).hexdigest(),
            "samples": [
                {"bits": bits, "str": half_strings[bits], "repr": half_reprs[bits]}
                for bits in half_samples
            ],
        },
        "bytes": [
            {
                "value": base64.b64encode(value).decode(),
                # JSON doubles the repr's backslashes. Shorter chunks keep
                # escaped synthetic bytes below the secret scanner's key size.
                "str": {
                    "$string_parts": [
                        str(value)[index : index + 40]
                        for index in range(0, len(str(value)), 40)
                    ]
                },
            }
            for value in byte_values
        ],
        "cases": cases,
    }
    (root / "tests/fixtures/document-search-results.json").write_text(
        json.dumps(fixture_strings(output), ensure_ascii=True, indent=2) + "\n"
    )
    print(f"Captured {len(cases)} document search result cases")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    with search_peer() as (client, state):
        export(args.root, args.revision, client, state)
