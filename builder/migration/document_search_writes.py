"""Search after real retained indexing operations, including partial failures."""

import copy
import json
from pathlib import Path

from leaf_check import PRIVATE_COLLECTIONS
from profile_import_check import expand


def scenarios(base):
    oracle = expand(
        json.loads(
            (
                Path(__file__).resolve().parents[1]
                / "runtime/tests/fixtures/milvus-index.json"
            ).read_text()
        )
    )
    uri = base["configuration"]["functions"]["documents"]["milvus_uri"]
    collection = PRIVATE_COLLECTIONS["synthetic-alice"]

    def write(timestamp, *, source=0, target=collection, endpoint=uri):
        captured = oracle["cases"][source]
        return {
            "uri": endpoint,
            "collection": target,
            "records": captured["records"],
            "recreate": captured["recreate"],
            "success": "error" not in captured["expected"],
            "settings": {
                "phase": "write",
                "uri": endpoint,
                "rename_collections": {"private_collection": target},
                "allow_cached_schema_reads": True,
                "script": [c for c in captured["calls"] if c["method"] != "Connect"],
                "mutation_timestamps": {"meta": 9999999, target: timestamp},
            },
        }

    def invocation(*writes, tool="documents", user=None):
        value = {
            "tool": tool,
            "input": {"operation": "search", "query": "Synthetic acknowledged write"},
            "writes": list(writes),
        }
        if user:
            value["headers"] = {"x-user-id": user}
        return value

    cases = []

    def add(name, invocations, timestamps, **alias):
        case = copy.deepcopy(base)
        case.update(
            name="mutation-" + name,
            invocations=invocations,
            expected_timestamps=timestamps,
        )
        if alias:
            case["configuration"]["functions"]["other"] = {
                **case["configuration"]["functions"]["documents"],
                **alias,
            }
        cases.append(case)

    add(
        "monotonic",
        [
            invocation(),
            invocation(write(1234)),
            invocation(write(50)),
            invocation(write(0)),
        ],
        [1, 1234, 1234, 1234],
    )
    add(
        "aliases",
        [invocation(write(1234)), invocation(tool="other")],
        [1234, 1234],
        milvus_uri=uri,
    )
    bob = "synthetic-bob"
    add(
        "collections",
        [
            invocation(write(1234, target=PRIVATE_COLLECTIONS[bob])),
            invocation(user=bob),
        ],
        [1, 1234],
    )
    add(
        "databases",
        [
            invocation(write(1234, endpoint=uri + "/synthetic-db")),
            invocation(tool="other"),
        ],
        [1, 1234],
        milvus_uri=uri + "/synthetic-db",
    )
    add(
        "default-database", [invocation(write(1234, endpoint=uri + "/default"))], [1234]
    )
    localhost = uri.replace("127.0.0.1", "localhost")
    add(
        "endpoints",
        [invocation(write(1234, endpoint=localhost)), invocation(tool="other")],
        [1, 1234],
        milvus_uri=localhost,
    )
    add(
        "recreated",
        [invocation(write(1234)), invocation(write(50, source=3))],
        [1234, 1234],
    )
    add(
        "rejected",
        [
            invocation(write(999999, source=19)),
            invocation(write(1234)),
            invocation(write(999999, source=19)),
        ],
        [1, 1234, 1234],
    )
    add("flush-failed", [invocation(write(1234, source=20))], [1234])
    add("empty", [invocation(write(1234, source=5))], [1])
    return cases
