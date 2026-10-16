"""Capture nested search retry exhaustion without waiting through the backoff."""

import argparse
import base64
import hashlib
import inspect
import json
import logging
import signal
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from export_authorization import fixture_strings


def export(root, revision):
    import grpc
    import pymilvus
    import pymilvus.decorators as decorators
    from pymilvus import MilvusClient
    from pymilvus.client.grpc_handler import GrpcHandler
    from pymilvus.grpc_gen import milvus_pb2

    logging.disable(logging.CRITICAL)
    state = {}

    def connect(_request, _context):
        return milvus_pb2.ConnectResponse(identifier=1)

    def search(request, context):
        state["calls"] += 1
        wire = base64.b64encode(request.SerializeToString()).decode()
        if "request" not in state:
            state["request"] = wire
        elif wire != state["request"]:
            state["changed_request"] = True
        response = milvus_pb2.SearchResults()
        if state["calls"] <= state["failures"]:
            if state["grpc"]:
                context.abort(grpc.StatusCode.UNAVAILABLE, "Synthetic exhausted retry")
            if state["legacy"]:
                response.status.error_code = 49
            else:
                response.status.code = 8
        else:
            response.results.topks.append(0)
        return response

    server = grpc.server(ThreadPoolExecutor(max_workers=4))
    handlers = {}
    for name, function, request_type in [
        ("Connect", connect, milvus_pb2.ConnectRequest),
        ("Search", search, milvus_pb2.SearchRequest),
    ]:
        handlers[name] = grpc.unary_unary_rpc_method_handler(
            function,
            request_deserializer=request_type.FromString,
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
    client = MilvusClient(uri=f"http://127.0.0.1:{port}")
    cases = []
    try:
        for failures, legacy, rpc in [
            (76, False, False),
            (10000, False, False),
            (76, True, False),
            (10000, True, False),
            (76, False, True),
        ]:
            state.clear()
            state.update(
                calls=0,
                failures=failures,
                legacy=legacy,
                grpc=rpc,
                changed_request=False,
            )
            delays = []
            # Every RPC still crosses a real loopback gRPC connection. Record
            # the SDK's requested sleeps instead of spending hours waiting.
            with patch("pymilvus.decorators.time.sleep", side_effect=delays.append):
                try:
                    client.search(
                        collection_name="synthetic",
                        data=[[0.1]],
                        limit=1,
                        anns_field="vector",
                    )
                    outcome = "success"
                except Exception as error:
                    outcome = type(error).__name__
            if state["changed_request"]:
                raise RuntimeError("SDK changed the search request during retry")
            cases.append(
                {
                    **state,
                    "outcome": outcome,
                    "sleep_ms": [round(d * 1000) for d in delays],
                }
            )
    finally:
        client.close()
        server.stop(0).wait()
    output = {
        "revision": revision,
        "pymilvus_version": pymilvus.__version__,
        "source_sha256": {
            item.__name__: hashlib.sha256(
                Path(inspect.getfile(item)).read_bytes()
            ).hexdigest()
            for item in [GrpcHandler, decorators]
        },
        "timing": "Requested backoff recorded; wall-clock sleeps skipped",
        "cases": cases,
    }
    (root / "tests/fixtures/milvus-search-retries.json").write_text(
        json.dumps(fixture_strings(output), indent=2) + "\n"
    )
    print(
        [
            {
                key: value
                for key, value in case.items()
                if key not in {"request", "sleep_ms"}
            }
            for case in cases
        ]
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()

    def expired(*_args):
        raise TimeoutError("Search retry oracle exceeded 90 seconds")

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(90)
    export(args.root, args.revision)
