"""Capture dense document retrieval through the retained PyMilvus transport."""

import argparse
import base64
import copy
import hashlib
import inspect
import json
import math
import signal
import struct
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from export_authorization import fixture_strings
from export_milvus_index import generate_types


def observed(value):
    if (
        type(value).__module__.startswith("numpy")
        and hasattr(value, "dtype")
        and not isinstance(value, Iterable)
    ):
        return {"$numpy": str(value.dtype), "value": observed(value.item())}
    if isinstance(value, bytes):
        return {"$bytes": base64.b64encode(value).decode()}
    if isinstance(value, float) and not math.isfinite(value):
        return {"$float": value.hex()}
    if isinstance(value, dict):
        return {str(key): observed(item) for key, item in value.items()}
    if isinstance(value, Iterable) and not isinstance(value, str):
        return [observed(item) for item in value]
    return value


def response():
    def strings(name, values):
        return {
            "type": 21,
            "field_name": name,
            "scalars": {"string_data": {"data": values}},
        }

    def jsons(name, values, dynamic=False):
        return {
            "type": 23,
            "field_name": name,
            "is_dynamic": dynamic,
            "scalars": {
                "json_data": {
                    "data": [
                        base64.b64encode(json.dumps(v).encode()).decode()
                        for v in values
                    ]
                }
            },
        }

    return {
        "results": {
            "num_queries": "1",
            "top_k": "2",
            "topks": ["2"],
            "ids": {"int_id": {"data": ["11", "12"]}},
            "scores": [0.125, 2.5],
            "fields_data": [
                strings("content", ["Synthetic content 雪🌲", "Second document"]),
                strings("source", ["a.txt", "b.pdf"]),
                {
                    "type": 5,
                    "field_name": "page",
                    "scalars": {"long_data": {"data": ["1", "2"]}},
                },
                jsons(
                    "metadata",
                    [{"source_name": "a", "page": 1}, {"source_name": "b", "page": 2}],
                ),
                jsons(
                    "$meta",
                    [{"tag": "first", "ignored": 1}, {"tag": "second", "ignored": 2}],
                    True,
                ),
            ],
            "output_fields": ["content", "source", "page", "metadata", "tag"],
        }
    }


def export(root, revision):
    import grpc
    import pymilvus
    from google.protobuf.json_format import MessageToDict, ParseDict
    from google.protobuf.message_factory import GetMessageClass
    from pymilvus import MilvusClient
    from pymilvus.client import abstract, prepare
    from pymilvus.grpc_gen import milvus_pb2

    service = milvus_pb2.DESCRIPTOR.services_by_name["MilvusService"]

    class Peer:
        def __init__(self):
            self.calls = []
            self.response = response()
            self.fault = None

        def dispatch(self, method, request, context):
            value = GetMessageClass(service.methods_by_name[method].output_type)()
            if method == "Connect":
                value.identifier = 41
            elif method == "Search":
                ParseDict(self.response, value)
            else:
                context.abort(grpc.StatusCode.UNIMPLEMENTED, "Unexpected retrieval RPC")
            body = MessageToDict(
                request, preserving_proto_field_name=True, use_integers_for_enums=True
            )
            wire = base64.b64encode(request.SerializeToString()).decode()
            if method == "Connect":
                body["client_info"]["local_time"] = "<time>"
                body["client_info"]["host"] = "<host>"
                wire = None
            metadata = {
                key: val
                for key, val in context.invocation_metadata()
                if key in ["authorization", "dbname", "identifier", "client-request-id"]
            }
            if "identifier" in metadata:
                metadata["identifier"] = "<session>"
            active = (
                self.fault
                if self.fault and len(self.calls) < self.fault.get("count", 1)
                else None
            )
            if active and "application" in active:
                ParseDict(active["application"], value.status)
            self.calls.append(
                {
                    "method": method,
                    "body": body,
                    "base64": wire,
                    "metadata": metadata,
                    "response": MessageToDict(
                        value,
                        preserving_proto_field_name=True,
                        use_integers_for_enums=True,
                    ),
                    "response_base64": base64.b64encode(
                        value.SerializeToString()
                    ).decode(),
                }
            )
            if active and "grpc" in active:
                self.calls[-1]["response"] = None
                self.calls[-1]["response_base64"] = None
                self.calls[-1]["grpc"] = active["grpc"]
                context.abort(
                    getattr(grpc.StatusCode, active["grpc"]),
                    "Synthetic retrieval failure",
                )
            return value

    peer = Peer()
    server = grpc.server(ThreadPoolExecutor(max_workers=8))
    handlers = {}
    for method in [service.methods_by_name[name] for name in ["Connect", "Search"]]:
        handlers[method.name] = grpc.unary_unary_rpc_method_handler(
            lambda request, context, name=method.name: peer.dispatch(
                name, request, context
            ),
            request_deserializer=GetMessageClass(method.input_type).FromString,
            response_serializer=GetMessageClass(method.output_type).SerializeToString,
        )
    server.add_generic_rpc_handlers(
        (grpc.method_handlers_generic_handler(service.full_name, handlers),)
    )
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    cases = []
    client = MilvusClient(  # nosec B106 - synthetic loopback credential
        uri=f"http://127.0.0.1:{port}", token="synthetic-search-token"
    )

    def add(name, *, changes=None, result=None, fault=None):
        peer.calls = []
        peer.fault = fault
        peer.response = result if result is not None else response()
        arguments = {
            "collection_name": "private_collection",
            "data": [[0.25, -0.0, 1.5]],
            "filter": None,
            "limit": 5,
            "output_fields": ["content", "source", "metadata"],
            "search_params": {"metric_type": "L2"},
            "anns_field": "vector",
            **(changes or {}),
        }
        try:
            result = client.search(**arguments)
            result.materialize()
            expected = {"ok": observed(result)}
        except Exception as error:
            expected = {"error": type(error).__name__}
        cases.append(
            {
                "name": name,
                "arguments": observed(arguments),
                "calls": copy.deepcopy(peer.calls),
                "expected": expected,
                "fault": fault,
            }
        )

    try:
        add("default")
        for code in [
            "UNAVAILABLE",
            "INTERNAL",
            "PERMISSION_DENIED",
            "UNAUTHENTICATED",
            "DEADLINE_EXCEEDED",
            "INVALID_ARGUMENT",
            "RESOURCE_EXHAUSTED",
            "UNIMPLEMENTED",
        ]:
            add("grpc-" + code.lower(), fault={"grpc": code, "count": 1})
        for name, status in [
            ("rate-limit", {"code": 8}),
            ("legacy-rate-limit", {"error_code": 49}),
            ("rejected", {"code": 1}),
            ("legacy-rejected", {"error_code": 1}),
        ]:
            add(name, fault={"application": status, "count": 1})
        for name, change in [
            ("filter", {"filter": 'source == "雪.txt"'}),
            ("blank-filter", {"filter": ""}),
            ("fields-none", {"output_fields": None}),
            ("fields-empty", {"output_fields": []}),
            ("fields-wildcard", {"output_fields": ["*"]}),
            ("alternate-vector", {"anns_field": "embedding"}),
            ("empty-vector", {"data": [[]]}),
            ("multiple-vectors", {"data": [[0.5, 0.25], [1.0, -0.5]]}),
            (
                "nonfinite-vector",
                {"data": [[float("nan"), float("inf"), -float("inf")]]},
            ),
            ("overflow-vector", {"data": [[1e308]]}),
        ]:
            add(name, changes=change)
        for value in [0, -1, 1, 16384, 16385, 2**63, True, "5"]:
            add(f"limit-{value}", changes={"limit": value})
        for index, params in enumerate(
            [
                {},
                None,
                {"metric_type": "COSINE", "params": {"ef": 20}},
                {"metric_type": "IP", "ef": 16},
                {"params": {"ef": 20}, "ef": 20},
                {"params": {"ef": 20}, "ef": 21},
                {"params": []},
                {"params": None},
                {"offset": 0},
                {"offset": 2},
                {"offset": -1},
                {"offset": True},
                {"offset": "2"},
                {"ignore_growing": True},
                {"ignore_growing": "false"},
                {"metric_type": None},
                {"metric_type": {"kind": "L2"}},
                {"hints": "iterative_filter"},
                {"analyzer_name": "synthetic"},
                {"page_retain_order": True},
                {"page_retain_order": False},
                {"page_retain_order": "yes"},
                {"params": {"nested": [1, True, None, "雪"]}},
                {"params": {"huge": 2**65}},
            ]
        ):
            add(f"params-{index}", changes={"search_params": params})
        for name, result in [
            ("no-query-results", {"results": {}}),
            ("empty-hits", {"results": {"num_queries": "1", "topks": ["0"]}}),
        ]:
            add(name, result=result)
        for name, changes in [
            ("custom-primary", {"primary_field_name": "pk"}),
            ("string-primary", {"ids": {"str_id": {"data": ["a", "b"]}}}),
            ("missing-primary", {"ids": {}}),
            ("short-primary", {"ids": {"int_id": {"data": ["11"]}}}),
            ("short-scores", {"scores": [0.1]}),
            ("dynamic-all", {"output_fields": []}),
            ("dynamic-none-selected", {"output_fields": ["unknown"]}),
            ("separate-query-results", {"topks": ["1", "1"], "num_queries": "2"}),
        ]:
            result = response()
            result["results"].update(changes)
            add(name, result=result)
        for name, field in [
            ("bool", {"type": 1, "scalars": {"bool_data": {"data": [True, False]}}}),
            ("int", {"type": 4, "scalars": {"int_data": {"data": [-3, 4]}}}),
            ("float", {"type": 10, "scalars": {"float_data": {"data": [0.1, -0.0]}}}),
            (
                "double",
                {"type": 11, "scalars": {"double_data": {"data": [0.1, 1e100]}}},
            ),
            (
                "nullable",
                {
                    "type": 5,
                    "valid_data": [False, True],
                    "scalars": {"long_data": {"data": ["17"]}},
                },
            ),
            ("short-scalar", {"type": 5, "scalars": {"long_data": {"data": ["17"]}}}),
            (
                "array",
                {
                    "type": 22,
                    "scalars": {
                        "array_data": {
                            "element_type": 5,
                            "data": [
                                {"long_data": {"data": ["1", "2"]}},
                                {"long_data": {"data": []}},
                            ],
                        }
                    },
                },
            ),
            (
                "dense-vector",
                {
                    "type": 101,
                    "vectors": {
                        "dim": "2",
                        "float_vector": {"data": [0.1, 0.2, 0.3, 0.4]},
                    },
                },
            ),
            (
                "nullable-vector",
                {
                    "type": 101,
                    "valid_data": [False, True],
                    "vectors": {"dim": "2", "float_vector": {"data": [0.1, 0.2]}},
                },
            ),
            (
                "binary-vector",
                {"type": 100, "vectors": {"dim": "8", "binary_vector": "AQI="}},
            ),
            (
                "invalid-json",
                {"type": 23, "scalars": {"json_data": {"data": ["eA==", "e30="]}}},
            ),
            ("unknown-type", {"type": 999}),
            (
                "unsupported-string",
                {"type": 20, "scalars": {"string_data": {"data": ["a", "b"]}}},
            ),
        ]:
            result = response()
            result["results"]["fields_data"].append({"field_name": "extra", **field})
            add(name, result=result)

        def encoded(value):
            return base64.b64encode(value).decode()

        names = {
            "field_name": "name",
            "type": 22,
            "scalars": {
                "array_data": {
                    "element_type": 21,
                    "data": [
                        {"string_data": {"data": ["A", "B"]}},
                        {"string_data": {"data": ["C"]}},
                    ],
                }
            },
        }
        dense = {"dim": "2", "float_vector": {"data": [0.1, 0.2, 0.3, 0.4]}}
        small = {"dim": "2", "float_vector": {"data": [0.5, 0.6]}}
        array_vector = {
            "type": 106,
            "vectors": {"vector_array": {"element_type": 101, "data": [dense, small]}},
        }
        additional = [
            (
                "geometry",
                {
                    "type": 24,
                    "scalars": {
                        "geometry_wkt_data": {"data": ["POINT (1 2)", "POINT (3 4)"]}
                    },
                },
            ),
            (
                "timestamp",
                {
                    "type": 26,
                    "scalars": {
                        "string_data": {
                            "data": ["2026-10-14T12:00:00Z", "2026-10-14T12:01:00Z"]
                        }
                    },
                },
            ),
            (
                "sparse-vector",
                {
                    "type": 104,
                    "vectors": {
                        "sparse_float_vector": {
                            "contents": [
                                encoded(struct.pack("<IfIf", 1, 0.25, 7, -0.5)),
                                encoded(struct.pack("<If", 3, 0.1)),
                            ]
                        }
                    },
                },
            ),
            ("array-vector", array_vector),
            ("array-vector-valid-flags", {**array_vector, "valid_data": [False, True]}),
            ("empty-vector-data", {"type": 101}),
            (
                "unsupported-array-element",
                {
                    "type": 22,
                    "scalars": {"array_data": {"element_type": 23, "data": [{}, {}]}},
                },
            ),
            ("empty-struct", {"type": 200}),
            ("struct-scalar", {"type": 200, "struct_arrays": {"fields": [names]}}),
            (
                "struct-dense",
                {
                    "type": 200,
                    "struct_arrays": {
                        "fields": [names, {"field_name": "vector", **array_vector}]
                    },
                },
            ),
        ]
        for kind, key, first, second, dim in [
            (
                102,
                "float16_vector",
                struct.pack("<4e", 1, -0.5, 2, 3),
                struct.pack("<2e", 4, 5),
                2,
            ),
            (
                103,
                "bfloat16_vector",
                struct.pack("<4H", 16256, 16384, 16448, 16512),
                struct.pack("<2H", 16544, 16576),
                2,
            ),
            (
                105,
                "int8_vector",
                struct.pack("<4b", -1, 2, 3, 4),
                struct.pack("<2b", 5, -6),
                2,
            ),
            (100, "binary_vector", bytes([1, 2]), bytes([3]), 8),
        ]:
            column = {
                "field_name": "vector",
                "type": 106,
                "vectors": {
                    "vector_array": {
                        "element_type": kind,
                        "data": [
                            {"dim": str(dim), key: encoded(first)},
                            {"dim": str(dim), key: encoded(second)},
                        ],
                    }
                },
            }
            additional.append(
                (
                    "struct-" + key,
                    {"type": 200, "struct_arrays": {"fields": [names, column]}},
                )
            )
            additional.append(
                (key, {"type": kind, "vectors": {"dim": str(dim), key: encoded(first)}})
            )
        for name, field in additional:
            result = response()
            result["results"]["fields_data"].append({"field_name": "extra", **field})
            add(name, result=result)
    finally:
        client.close()
        server.stop(0).wait()

    output = {
        "revision": revision,
        "pymilvus_version": pymilvus.__version__,
        "source_sha256": {
            v.__name__: hashlib.sha256(
                Path(inspect.getfile(v)).read_bytes()
            ).hexdigest()
            for v in [MilvusClient, abstract.SearchResult, prepare.Prepare]
        },
        "cases": cases,
    }
    (root / "tests/fixtures/milvus-search.json").write_text(
        json.dumps(fixture_strings(output), ensure_ascii=False, indent=2) + "\n"
    )
    indexed = json.loads((root / "tests/fixtures/milvus-index.json").read_text())
    methods = {
        call["method"] for case in indexed["cases"] for call in case["calls"]
    } | {"Search"}
    generate_types(root, service, sorted(methods))
    print(
        {
            "cases": len(cases),
            "search_requests": sum(len(case["calls"]) for case in cases),
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()

    def expired(*_args):
        raise TimeoutError("Search oracle exceeded 90 seconds")

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(90)
    export(args.root, args.revision)
