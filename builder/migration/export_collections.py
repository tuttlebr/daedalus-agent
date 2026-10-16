"""Freeze collection namespaces, metadata responses, and Milvus protobuf fields."""

import argparse
import asyncio
import base64
import importlib
import json
import os
from pathlib import Path
from unittest.mock import patch

from export_authorization import BASELINE, fixture_strings


async def export(root):
    import collection_metadata_api as api
    import nat_nv_ingest.nat_nv_ingest as document
    import pymilvus
    from google.protobuf.json_format import ParseDict
    from pymilvus.grpc_gen import common_pb2 as common
    from pymilvus.grpc_gen import milvus_pb2 as milvus

    cases = []

    def freeze(kind, args, function):
        try:
            expected = {"ok": function(*args)}
        except Exception as error:
            expected = {"error": type(error).__name__, "message": str(error)}
        cases.append({"kind": kind, "args": args, "expected": expected})

    subjects = [
        None,
        "",
        "anonymous",
        "Alice",
        "alice",
        " a-b ",
        "a_b",
        "__",
        "123",
        "雪🌲",
        "é",
        "e\u0301",
        " A\u001c",
        "x" * 300,
    ]
    bases = [None, "", "user_uploads", "nvidia", " a-b ", "123", "__", "雪", "b" * 300]
    for subject in subjects:
        freeze("private_part", [subject], document.private_user_collection_part)
        for base in bases:
            freeze("user_name", [subject, base], document.user_upload_collection_name)
            for function, name in [
                (document.normalize_collection_part, "part"),
                (document.normalize_collection_name, "name"),
            ]:
                freeze(name, [subject, base or "anonymous"], function)
            for collection in [
                base,
                document.user_upload_collection_name(subject, base),
                document.legacy_user_upload_collection_name(subject, base),
            ]:
                freeze(
                    "resolve",
                    [collection, subject, base],
                    document.resolve_user_collection_name,
                )
    for collection in [
        *sorted(document.SHARED_COLLECTION_NAMES),
        " NVIDIA ",
        "nvidia_",
        "nvi-dia",
        "",
        "private",
        "雪",
        "x" * 260,
    ]:
        for scope in [
            None,
            "",
            "user",
            "shared",
            " SHARED ",
            "\u001cuser\u001f",
            "bad",
        ]:
            freeze("scope", [collection, scope], document.validate_collection_scope)
            freeze(
                "write_scope",
                [collection, scope],
                document.validate_user_collection_write_scope,
            )

    metadata = []
    for subject in subjects:
        if not subject or not subject.strip():
            continue
        for base in [None, "user_uploads", " Custom uploads "]:
            env = {"DAEDALUS_INTERNAL_API_TOKEN": "synthetic-token"}
            if base is not None:
                env["DOCUMENT_INGEST_DEFAULT_COLLECTION"] = base
            for existing in [
                [],
                ["nvidia", "foreign_private"],
                [document.user_upload_collection_name(subject, base or "user_uploads")],
            ]:

                async def listing(values=existing):
                    return values

                with patch.dict(os.environ, env, clear=True), patch.object(
                    api, "_list_collections", listing
                ):
                    expected = await api._collection_metadata(
                        subject, "synthetic-token"
                    )
                metadata.append(
                    {
                        "user": subject.strip(),
                        "env": env,
                        "existing": existing,
                        "expected": expected,
                    }
                )
    configs = []
    for env in [
        {},
        {"MILVUS_USER": " fallback ", "MILVUS_PASSWORD": " secret "},
        {
            "MILVUS_USERNAME": " preferred ",
            "MILVUS_USER": "fallback",
            "MILVUS_PASSWORD": "secret",
        },
        {"MILVUS_USERNAME": " ", "MILVUS_USER": "fallback"},
        {
            "MILVUS_USERNAME": "user",
            "MILVUS_PASSWORD": "secret",
            "MILVUS_TOKEN": " token ",
        },
        {"MILVUS_DATABASE": ""},
        {"MILVUS_DATABASE": " "},
        {"MILVUS_DATABASE": " default "},
        {"MILVUS_DATABASE": " custom "},
    ]:
        with patch.dict(os.environ, env, clear=True):
            configs.append({"env": env, "expected": api._milvus_kwargs()})
    timeouts = []
    for value in [
        None,
        "",
        " ",
        "0",
        "-1",
        "0.49",
        "0.5",
        "3",
        "10",
        "20",
        "NaN",
        "inf",
        "-inf",
        "１_０.０",
        "1_0.0_1e-2",
        "bad",
        "1__0",
    ]:
        env = {} if value is None else {"MILVUS_METADATA_TIMEOUT_SECONDS": value}
        with patch.dict(os.environ, env, clear=True):
            try:
                expected = {"ok": api._metadata_timeout_seconds()}
            except Exception as error:
                expected = {"error": type(error).__name__}
        timeouts.append({"value": value, "expected": expected})

    endpoints = []
    connection_module = importlib.import_module("pymilvus.orm.connections")

    class Handler:
        def __init__(self, **kwargs):
            self.settings = kwargs

        def _wait_for_channel_ready(self, **_kwargs):
            pass

        def get_server_type(self):
            return "milvus"

        def close(self):
            pass

    for uri, extra in [
        ("http://localhost", {}),
        ("http://localhost:80", {}),
        ("https://localhost", {}),
        ("tcp://localhost:19530", {}),
        ("grpc://localhost:19530", {}),
        ("http://localhost/db/second", {}),
        ("http://localhost?x=/fake", {}),
        ("http://localhost#x/fake", {}),
        ("http://localhost/../db", {}),
        ("http://localhost/db%20one?x=/fake", {}),
        ("http://uri-user:uri-pass@localhost/db", {}),
        ("http://uri%40user:uri%3Apass@localhost/db", {}),
        ("http://uri-user:@localhost/db", {}),
        ("http://:uri-pass@localhost/db", {}),
        ("http://localhost/db", {"MILVUS_DATABASE": "configured"}),
        ("http://localhost/db", {"MILVUS_DATABASE": "default"}),
        ("http://uri-user:uri-pass@localhost/db", {"MILVUS_TOKEN": "token"}),
        ("unix:/fixture/milvus.sock", {}),
        ("unix:///fixture/milvus.sock", {}),
        ("http://localhost:0", {}),
        ("http://localhost:65535", {}),
        ("http://localhost:bad", {}),
        ("http://[::1]:19530", {}),
        ("ftp://localhost:19530", {}),
        ("localhost:19530", {}),
    ]:
        env = {
            "MILVUS_URI": uri,
            "MILVUS_USERNAME": "env-user",
            "MILVUS_PASSWORD": "env-pass",
            **extra,
        }
        with patch.dict(os.environ, env, clear=True), patch.object(
            connection_module, "GrpcHandler", Handler
        ):
            try:
                client = pymilvus.MilvusClient(
                    **api._milvus_kwargs(), alias="frozen-settings"
                )
                try:
                    settings = client._get_connection().settings
                    address = settings["address"]
                    socket = address[5:] if address.startswith("unix:") else None
                    auth = settings.get("token") or (
                        settings["user"] + ":" + settings["password"]
                        if settings["user"] and settings["password"]
                        else None
                    )
                    expected = {
                        "ok": {
                            "endpoint": "http://localhost"
                            if socket is not None
                            else ("https://" if settings.get("secure") else "http://")
                            + address,
                            "socket": socket,
                            "database": client._db_name,
                            "user": settings["user"],
                            "authorization": base64.b64encode(auth.encode()).decode()
                            if auth
                            else None,
                        }
                    }
                finally:
                    client.close()
            except Exception as error:
                expected = {"error": type(error).__name__}
        endpoints.append({"env": env, "expected": expected})

    # Deliberate protobuf projections: fields used by metadata only. Unknown
    # fields remain compatible on the wire; indexing adds its consumed fields.
    projected = [
        (common.Status, ["error_code", "reason", "code", "retriable"]),
        (common.ClientInfo, ["sdk_type", "sdk_version", "local_time", "user", "host"]),
        (milvus.ConnectRequest, ["client_info"]),
        (milvus.ConnectResponse, ["status", "identifier"]),
        (milvus.ShowCollectionsRequest, []),
        (milvus.ShowCollectionsResponse, ["status", "collection_names"]),
        (milvus.DescribeCollectionRequest, ["collection_name"]),
        (milvus.DescribeCollectionResponse, ["status"]),
    ]
    source = [
        "//! Generated by export_collections.py from the retained PyMilvus descriptors.",
        "//! Only consumed fields are projected; protobuf skips unknown fields.",
    ]
    descriptor = []
    for message, names in projected:
        desc = message.DESCRIPTOR
        descriptor.append(
            {
                "name": desc.full_name,
                "fields": [
                    {
                        "name": f.name,
                        "tag": f.number,
                        "type": f.type,
                        "repeated": f.is_repeated,
                        "message": f.message_type.full_name if f.message_type else None,
                    }
                    for f in desc.fields
                ],
                "projected": names,
            }
        )
        source += [
            "#[derive(Clone, PartialEq, prost::Message)]",
            f"pub struct {desc.name} {{",
        ]
        for name in names:
            field = desc.fields_by_name[name]
            rust_type, proto_type = {
                3: ("i64", "int64"),
                5: ("i32", "int32"),
                8: ("bool", "bool"),
                9: ("String", "string"),
                14: ("i32", "int32"),
            }.get(field.type, (None, None))
            qualifier = ""
            if field.message_type:
                rust_type, proto_type, qualifier = (
                    f"Option<{field.message_type.name}>",
                    "message",
                    ", optional",
                )
            elif field.is_repeated:
                rust_type, qualifier = f"Vec<{rust_type}>", ", repeated"
            source += [
                f'    #[prost({proto_type}{qualifier}, tag = "{field.number}")]',
                f"    pub {name}: {rust_type},",
            ]
        source += ["}"]
    (root / "src/milvus_proto.rs").write_text("\n".join(source) + "\n")
    wire = []
    for message, inputs in [
        (
            milvus.ConnectRequest,
            [
                {
                    "client_info": {
                        "sdk_type": "Rust",
                        "sdk_version": "0.1.0",
                        "local_time": "2026-10-13 00:00:00",
                        "user": "synthetic-user",
                        "host": "synthetic-host",
                    }
                }
            ],
        ),
        (
            milvus.ConnectResponse,
            [
                {"identifier": "123", "status": {}},
                {
                    "identifier": "-1",
                    "status": {
                        "error_code": 1,
                        "reason": "synthetic failure",
                        "code": 8,
                    },
                },
            ],
        ),
        (milvus.ShowCollectionsRequest, [{}]),
        (
            milvus.ShowCollectionsResponse,
            [{"status": {}, "collection_names": ["nvidia", "雪", "private"]}],
        ),
        (
            milvus.DescribeCollectionRequest,
            [
                {"collection_name": "nvidia"},
                {"collection_name": "__daedalus_rag_readiness__"},
            ],
        ),
        (
            milvus.DescribeCollectionResponse,
            [
                {"status": {"error_code": 4, "code": 100, "reason": "not found"}},
                {"status": {}},
            ],
        ),
    ]:
        for value in inputs:
            encoded = ParseDict(value, message()).SerializeToString()
            wire.append(
                {
                    "type": message.DESCRIPTOR.name,
                    "input": value,
                    "base64": base64.b64encode(encoded).decode(),
                }
            )
    output = {
        "baseline_sha": BASELINE,
        "pymilvus": pymilvus.__version__,
        "shared": sorted(document.SHARED_COLLECTION_NAMES),
        "cases": cases,
        "metadata": metadata,
        "configs": configs,
        "timeouts": timeouts,
        "endpoints": endpoints,
        "descriptors": descriptor,
        "wire": wire,
    }
    (root / "tests/fixtures/collections.json").write_text(
        json.dumps(fixture_strings(output), ensure_ascii=False, indent=2) + "\n"
    )
    print(
        {
            key: len(output[key])
            for key in ["cases", "metadata", "configs", "timeouts", "endpoints", "wire"]
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
