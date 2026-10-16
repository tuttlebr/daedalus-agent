#!/usr/bin/env python3
"""Compare named collection listing and owned Milvus reads with the retained tool."""

import argparse
import copy
from pathlib import Path

from document_runner_check import COLLECTION, scenarios
from document_tool_ingestion_check import main
from leaf_check import PRIVATE_COLLECTIONS


def cases(oracle):
    original = scenarios(oracle)[0]
    results = []
    collections = [
        "foreign_collection",
        PRIVATE_COLLECTIONS["synthetic-bob"],
        "nvidia",
        "vetpartner",
        COLLECTION,
        "user_uploads_synthetic_alice",
        "kubernetes",
        "semianalysis",
        "mentalhealth",
        "NVIDIA",
        "nvidia_meta",
        "synthetic-db.nvidia",
    ]

    def add(name, *, names=None, tool_config=None, settings=None, **extra):
        case = copy.deepcopy(original)
        case.update(
            {
                "name": name,
                "input": {"operation": "list_collections"},
                "tool_call": True,
                "capture_milvus": True,
                "invocations": 2,
                "invalid_global_redis": True,
                "tool_config": {
                    "redis_url": "invalid-unused-redis",
                    "worker_pool_size": 0,
                    **(tool_config or {}),
                },
                "headers": {
                    "x-user-id": "synthetic-alice",
                    "x-daedalus-internal-token": "synthetic-internal",
                },
                "settings": {
                    "collections": collections if names is None else names,
                    **(settings or {}),
                },
                **extra,
            }
        )
        results.append(case)
        return case

    add("visible")
    add("empty", names=[])
    add("foreign-only", names=["foreign", PRIVATE_COLLECTIONS["synthetic-bob"]])
    add("duplicates", names=[COLLECTION, "nvidia", COLLECTION, "nvidia"])
    add(
        "shared-connection-users",
        invocations=3,
        users=["synthetic-alice", "synthetic-bob", "synthetic-alice"],
    )
    add(
        "custom-base",
        names=[
            COLLECTION,
            "custom_base" + COLLECTION.removeprefix("user_uploads"),
            "nvidia",
        ],
        tool_config={"default_collection_name": " Custom Base "},
    )
    add("missing-user", users=["", "synthetic-alice"])
    add(
        "request-collection-ignored",
        input={
            "operation": "list_collections",
            "collection_name": "foreign_collection",
            "collection_scope": "shared",
        },
    )
    add("token", tool_config={"milvus_token": " synthetic-token "})
    add(
        "username-only",
        tool_config={"milvus_username": " synthetic-user ", "milvus_password": None},
    )
    add(
        "password-only",
        tool_config={
            "milvus_username": None,
            "milvus_password": " synthetic-password ",
        },
    )
    add("no-auth", tool_config={"milvus_username": None, "milvus_password": None})
    add("config-database-ignored", tool_config={"database_name": "synthetic-config-db"})
    add("uri-database", milvus_transport="database")
    add("tls", milvus_transport="tls")
    add("unix", milvus_transport="unix")
    add("gzip", settings={"gzip": True})
    add("invalid-uri", tool_config={"milvus_uri": "invalid"})
    for method in ["Connect", "ShowCollections"]:
        for code in [
            "PERMISSION_DENIED",
            "UNAUTHENTICATED",
            "INVALID_ARGUMENT",
            "UNIMPLEMENTED",
            "UNAVAILABLE",
        ]:
            add(f"{method}-{code}", settings={"faults": {method: {"grpc": code}}})
        for name, status in [
            ("rate-limit", {"code": 8}),
            ("legacy-rate-limit", {"error_code": 49}),
            ("denied", {"code": 1800}),
        ]:
            add(
                f"{method}-{name}",
                settings={"faults": {method: {"application": status}}},
            )
    add("slow-list", settings={"delay": {"ShowCollections": {"seconds": 1.1}}})
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(
        parser.parse_args(),
        scenario_factory=cases,
        native_test="actual_listing_adapter",
    )
