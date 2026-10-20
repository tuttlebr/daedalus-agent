#!/usr/bin/env python3
"""Scripted Milvus gRPC service; runs inside the immutable SDK image."""

import argparse
import base64
import copy
import datetime
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import grpc
from google.protobuf.json_format import MessageToDict, ParseDict
from google.protobuf.message_factory import GetMessageClass
from milvus_probe import ProbeScripts
from pymilvus.grpc_gen import common_pb2, milvus_pb2, schema_pb2
from pymilvus.milvus_client.base import BaseMilvusClient

SERVICE = milvus_pb2.DESCRIPTOR.services_by_name["MilvusService"]


def receipt_clock(body, expected):
    """Validate the live receipt clock without weakening any other request field."""
    body = copy.deepcopy(body)
    actual_field = next(
        field for field in body["fields_data"] if field["field_name"] == "timestamp"
    )
    expected_field = next(
        field for field in expected["fields_data"] if field["field_name"] == "timestamp"
    )
    values = actual_field["scalars"]["string_data"]["data"]
    if len(values) != 1 or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{6})?", values[0]
    ):
        raise ValueError("Invalid receipt timestamp")
    datetime.datetime.fromisoformat(values[0])
    actual_field["scalars"]["string_data"]["data"] = expected_field["scalars"][
        "string_data"
    ]["data"]
    return body


def rename_script(script, names):
    """Bind retained RPCs to the runner's actual tenant-scoped collection name."""

    def rename(value):
        if isinstance(value, str):
            return names.get(value, value)
        if isinstance(value, list):
            return [rename(item) for item in value]
        if isinstance(value, dict):
            return {names.get(key, key): rename(item) for key, item in value.items()}
        return value

    result = copy.deepcopy(script)
    for call in result:
        method = SERVICE.methods_by_name[call["method"]]
        for key, descriptor in [
            ("base64", method.input_type),
            ("response_base64", method.output_type),
        ]:
            message_type = GetMessageClass(descriptor)
            message = message_type.FromString(base64.b64decode(call[key]))
            if key == "base64" and call["method"] == "CreateCollection":
                schema = schema_pb2.CollectionSchema.FromString(message.schema)
                schema.name = names.get(schema.name, schema.name)
                message.schema = schema.SerializeToString()
            body = rename(
                MessageToDict(
                    message,
                    preserving_proto_field_name=True,
                    use_integers_for_enums=True,
                )
            )
            message = ParseDict(body, message_type())
            call[key] = base64.b64encode(message.SerializeToString()).decode()
            if key == "base64":
                call["body"] = body
    return result


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = []
        self.settings = {}
        self.counts = {}
        self.sessions = {}
        self.serial = 0
        self.release = threading.Event()
        self.script_index = 0
        self.script_errors = []
        self.probes = None

    def probe(self, method, identifier, settings):
        """Claim one exact read-only preflight per owned connection."""
        if "probe_scripts" not in settings:
            return None
        with self.lock:
            return self.probes.claim(method, identifier)

    def dispatch(self, method, request, context):
        metadata = {
            k: v
            for k, v in context.invocation_metadata()
            if k
            in {
                "authorization",
                "identifier",
                "dbname",
                "client-request-id",
                "client-request-unixmsec",
            }
        }
        remaining = context.time_remaining()
        call = {
            "method": method,
            "body": MessageToDict(
                request, preserving_proto_field_name=True, use_integers_for_enums=True
            ),
            "metadata": metadata,
            "deadline": remaining is not None and remaining < 100,
            "cancelled": False,
        }
        with self.lock:
            self.calls.append(call)
            count = self.counts.get(method, 0)
            self.counts[method] = count + 1
            settings = copy.deepcopy(self.settings)
            if settings.get("phase"):
                call["phase"] = settings["phase"]
        delay = settings.get("delay", {}).get(method, 0)
        if isinstance(delay, dict):
            delay = delay["seconds"] if count < delay.get("count", 1) else 0
        elif isinstance(delay, list):
            delay = delay[count] if count < len(delay) else 0
        until = time.monotonic() + delay
        while time.monotonic() < until and not self.release.is_set():
            if not context.is_active():
                with self.lock:
                    call["cancelled"] = True
                break
            time.sleep(0.01)
        if settings.get("observe_wait_completion"):
            with self.lock:
                call["wait_completed"] = True
        fault = settings.get("faults", {}).get(method, {})
        if count < fault.get("count", 1) and "grpc" in fault:
            context.abort(
                getattr(grpc.StatusCode, fault["grpc"]),
                "Synthetic private Milvus failure",
            )
        status = common_pb2.Status(
            **(fault.get("application", {}) if count < fault.get("count", 1) else {})
        )
        if settings.get("gzip"):
            context.set_compression(grpc.Compression.Gzip)
        if method == "Connect":
            with self.lock:
                self.serial += 1
                identifier = self.serial
                self.sessions[str(identifier)] = metadata.get("authorization")
            return milvus_pb2.ConnectResponse(status=status, identifier=identifier)
        with self.lock:
            identifier = metadata.get("identifier")
            valid = identifier in self.sessions and self.sessions[
                identifier
            ] == metadata.get("authorization")
        if not valid:
            context.abort(
                grpc.StatusCode.UNAUTHENTICATED, "Missing owned handshake identifier"
            )
        if method in settings.get("replies", {}):
            replies = settings["replies"][method]
            body = (
                replies[min(count, len(replies) - 1)]
                if isinstance(replies, list)
                else replies
            )
            response_type = GetMessageClass(SERVICE.methods_by_name[method].output_type)
            response = ParseDict(body, response_type())
            if status.code or status.error_code:
                response.status.CopyFrom(status)
            return response
        if method == "Search" and "search_retry" in settings:
            retry = settings["search_retry"]
            expected = milvus_pb2.SearchRequest.FromString(
                base64.b64decode(retry["request"])
            )
            database = BaseMilvusClient._extract_db_name_from_uri(settings["uri"], "")
            if (
                request != expected
                or metadata.get("authorization") is not None
                or metadata.get("dbname") != database
                or metadata.get("client-request-id") != ""
            ):
                with self.lock:
                    self.script_errors.append(
                        "Search retry changed request or metadata"
                    )
                context.abort(
                    grpc.StatusCode.INVALID_ARGUMENT, "Search retry contract mismatch"
                )
            response = milvus_pb2.SearchResults()
            if count < retry["failures"]:
                if retry["grpc"]:
                    context.abort(
                        grpc.StatusCode.UNAVAILABLE, "Synthetic exhausted retry"
                    )
                if retry["legacy"]:
                    response.status.error_code = 49
                else:
                    response.status.code = 8
            else:
                response.results.topks.append(0)
            return response
        # Browser metadata uses a distinct read credential. These reads may
        # accompany the independently scripted ingestion writer at any time.
        # They never consume, reorder or relax the writer's RPC contract.
        if (
            settings.get("reader_authorization") == metadata.get("authorization")
            and settings.get("reader_authorization")
            and settings.get("reader_database") == metadata.get("dbname")
        ):
            if method == "ShowCollections":
                return milvus_pb2.ShowCollectionsResponse(
                    status=status, collection_names=settings.get("collections", [])
                )
            if method == "DescribeCollection":
                return milvus_pb2.DescribeCollectionResponse(status=status)
        probe = self.probe(method, identifier, settings)
        if probe is not None:
            with self.lock:
                call["phase"] = "probe"
        if "script" in settings:
            with self.lock:
                index = self.script_index
                script = settings["script"]
                # PyMilvus may reuse its cached insert schema across HTTP
                # requests. Only this read directly before the same collection's
                # insert is optional; mutation order and bodies remain exact.
                if (
                    probe is None
                    and settings.get("allow_cached_schema_reads")
                    and method == "Insert"
                    and index + 1 < len(script)
                    and script[index]["method"] == "DescribeCollection"
                    and script[index + 1]["method"] == "Insert"
                    and script[index]["body"].get("collection_name")
                    == request.collection_name
                    and script[index + 1]["body"].get("collection_name")
                    == request.collection_name
                ):
                    index += 1
                    self.script_index = index
                if probe is None:
                    self.script_index += 1
                expected = probe or (script[index] if index < len(script) else None)
                error = None
                if expected is None or expected["method"] != method:
                    error = f"Unexpected RPC at {index}: {method}"
                else:
                    body = call["body"]
                    if (
                        settings.get("live_receipt_clock")
                        and method == "Insert"
                        and body.get("collection_name") == "meta"
                    ):
                        try:
                            body = receipt_clock(body, expected["body"])
                        except (KeyError, StopIteration, ValueError):
                            error = f"Invalid receipt timestamp at {index}"
                    if body != expected["body"]:
                        error = f"Request mismatch at {index}: {method}"
                    for key in ["authorization", "dbname", "client-request-id"]:
                        value = expected["metadata"].get(key)
                        if key == "dbname" and value == "" and "uri" in settings:
                            value = BaseMilvusClient._extract_db_name_from_uri(
                                settings["uri"], ""
                            )
                        if metadata.get(key) != value:
                            error = f"Metadata mismatch at {index}: {method} {key}"
                            break
                if error:
                    self.script_errors.append(error)
            if error:
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, error)
            response_type = GetMessageClass(SERVICE.methods_by_name[method].output_type)
            response = response_type.FromString(
                base64.b64decode(expected["response_base64"])
            )
            if method == "Insert" and "mutation_timestamps" in settings:
                response.timestamp = settings["mutation_timestamps"].get(
                    request.collection_name, 0
                )
            return response
        if method == "ShowCollections":
            return milvus_pb2.ShowCollectionsResponse(
                status=status, collection_names=settings.get("collections", [])
            )
        if method == "DescribeCollection":
            return milvus_pb2.DescribeCollectionResponse(status=status)
        context.abort(grpc.StatusCode.UNIMPLEMENTED, "Unscripted RPC: " + method)


def main(args):
    state = State()

    class Control(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, value):
            data = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            with state.lock:
                calls = copy.deepcopy(state.calls)
                script = {
                    "remaining": len(state.settings.get("script", []))
                    - state.script_index,
                    "errors": state.script_errors.copy(),
                }
                if "probe_scripts" in state.settings:
                    script["probe_remaining"] = state.probes.remaining
            self.reply(
                calls
                if self.path == "/calls"
                else script
                if self.path == "/script"
                else {"ready": True}
            )

        def do_POST(self):
            if self.path == "/release":
                state.release.set()
            else:
                settings = json.loads(
                    self.rfile.read(int(self.headers.get("Content-Length", "0")))
                )
                if settings.get("rename_collections"):
                    settings["script"] = rename_script(
                        settings["script"], settings["rename_collections"]
                    )
                    if "probe_scripts" in settings:
                        settings["probe_scripts"] = [
                            rename_script(probe, settings["rename_collections"])
                            for probe in settings["probe_scripts"]
                        ]
                with state.lock:
                    state.settings = settings
                    if self.path != "/configure":
                        state.calls = []
                    state.counts = {}
                    state.script_index = 0
                    state.script_errors = []
                    state.probes = (
                        ProbeScripts(settings["probe_scripts"])
                        if "probe_scripts" in settings
                        else None
                    )
                    state.release.clear()
            self.reply({"ok": True})

    server = grpc.server(
        ThreadPoolExecutor(max_workers=12), options=[("grpc.so_reuseport", 0)]
    )
    handlers = {}
    for method in SERVICE.methods:
        request_type = GetMessageClass(method.input_type)
        response_type = GetMessageClass(method.output_type)
        handlers[method.name] = grpc.unary_unary_rpc_method_handler(
            lambda request, context, name=method.name: state.dispatch(
                name, request, context
            ),
            request_deserializer=request_type.FromString,
            response_serializer=response_type.SerializeToString,
        )
    server.add_generic_rpc_handlers(
        (grpc.method_handlers_generic_handler(SERVICE.full_name, handlers),)
    )
    server.add_insecure_port(f"127.0.0.1:{args.port}")
    credentials = grpc.ssl_server_credentials(
        [(args.key.read_bytes(), args.certificate.read_bytes())]
    )
    server.add_secure_port(f"127.0.0.1:{args.tls_port}", credentials)
    if args.mtls_port is not None:
        credentials = grpc.ssl_server_credentials(
            [(args.key.read_bytes(), args.certificate.read_bytes())],
            root_certificates=args.client_ca.read_bytes(),
            require_client_auth=True,
        )
        server.add_secure_port(f"127.0.0.1:{args.mtls_port}", credentials)
    server.add_insecure_port("unix:" + str(args.socket))
    server.start()
    os.chmod(args.socket, 0o777)  # nosec B103 - disposable loopback protocol fixture
    control = ThreadingHTTPServer(("127.0.0.1", args.control_port), Control)
    try:
        control.serve_forever()
    finally:
        state.release.set()
        server.stop(0).wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["port", "tls-port", "control-port"]:
        parser.add_argument("--" + name, type=int, required=True)
    for name in ["certificate", "key", "socket"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--mtls-port", type=int)
    parser.add_argument("--client-ca", type=Path)
    main(parser.parse_args())
