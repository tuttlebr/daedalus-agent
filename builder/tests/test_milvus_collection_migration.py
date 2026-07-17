"""Operator migration tests with a stateful, in-memory Milvus double."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest
from milvus_collection_migration import (
    AmbiguousLegacyOwnershipError,
    AppendOnlyMigrationAudit,
    MigrationVerificationError,
    OperatorAuthenticationError,
    UserCollectionMigrationExecutor,
)
from nat_nv_ingest.nat_nv_ingest import user_collection_migration_names

_TOKEN = "migration-operator-token-with-at-least-32-characters"
_INDEX = {
    "field_name": "embedding",
    "index_name": "embedding_idx",
    "index_type": "HNSW",
    "metric_type": "COSINE",
    "params": {"M": 16, "efConstruction": 200},
    "state": 3,
    "total_rows": 2,
    "indexed_rows": 2,
    "pending_index_rows": 0,
}


class _FakeSchema:
    def __init__(self, *, auto_id: bool, enable_dynamic_field: bool, description: str):
        self.auto_id = auto_id
        self.enable_dynamic_field = enable_dynamic_field
        self.description = description
        self.fields: list[dict[str, Any]] = []

    def add_field(self, *, field_name: str, datatype: Any, **kwargs: Any) -> None:
        params = {
            key: value
            for key, value in kwargs.items()
            if key not in {"description", "is_primary", "is_partition_key", "auto_id"}
        }
        field: dict[str, Any] = {
            "name": field_name,
            "type": int(datatype),
            "params": params,
        }
        for key in ("description", "is_primary", "is_partition_key", "auto_id"):
            if key in kwargs:
                field[key] = kwargs[key]
        self.fields.append(field)


class _FakeIndexParams:
    def __init__(self):
        self.indexes: list[dict[str, Any]] = []

    def add_index(self, **kwargs: Any) -> None:
        self.indexes.append(copy.deepcopy(kwargs))


class _FakeIterator:
    def __init__(self, entities: list[dict[str, Any]], batch_size: int):
        self.entities = copy.deepcopy(entities)
        self.batch_size = batch_size
        self.offset = 0
        self.closed = False

    def next(self) -> list[dict[str, Any]]:
        batch = self.entities[self.offset : self.offset + self.batch_size]
        self.offset += len(batch)
        return batch

    def close(self) -> None:
        self.closed = True


class FakeMilvusClient:
    def __init__(
        self,
        *,
        verification_count_offset: int = 0,
        fail_upsert_call: int | None = None,
    ):
        legacy, _ = user_collection_migration_names("alice")
        self.descriptions = {
            legacy: {
                "collection_name": legacy,
                "auto_id": True,
                "enable_dynamic_field": True,
                "description": "private uploads",
                "num_shards": 1,
                "consistency_level": 2,
                "properties": {},
                "fields": [
                    {
                        "field_id": 100,
                        "name": "id",
                        "type": 5,
                        "params": {},
                        "is_primary": True,
                        "auto_id": True,
                    },
                    {
                        "field_id": 101,
                        "name": "embedding",
                        "type": 101,
                        "params": {"dim": 2},
                    },
                    {
                        "field_id": 102,
                        "name": "text",
                        "type": 21,
                        "params": {"max_length": 2048},
                    },
                ],
                "functions": [],
            }
        }
        self.indexes = {legacy: {"embedding_idx": copy.deepcopy(_INDEX)}}
        self.entities = {
            legacy: {
                1: {"id": 1, "embedding": [0.1, 0.2], "text": "first"},
                2: {"id": 2, "embedding": [0.3, 0.4], "text": "second"},
            }
        }
        self.upsert_calls = 0
        self.verification_count_offset = verification_count_offset
        self.target_query_count = 0
        self.calls = 0
        self.fail_upsert_call = fail_upsert_call

    def has_collection(self, *, collection_name: str) -> bool:
        self.calls += 1
        return collection_name in self.descriptions

    def describe_collection(self, *, collection_name: str) -> dict[str, Any]:
        return copy.deepcopy(self.descriptions[collection_name])

    def list_indexes(self, collection_name: str) -> list[str]:
        return list(self.indexes[collection_name])

    def describe_index(
        self, *, collection_name: str, index_name: str
    ) -> dict[str, Any]:
        result = copy.deepcopy(self.indexes[collection_name][index_name])
        count = len(self.entities[collection_name])
        result["total_rows"] = count
        result["indexed_rows"] = count
        return result

    def load_collection(self, *, collection_name: str) -> None:
        assert collection_name in self.descriptions

    def query(
        self,
        *,
        collection_name: str,
        filter: str,
        output_fields: list[str],
        consistency_level: str,
    ) -> list[dict[str, int]]:
        assert filter == ""
        assert output_fields == ["count(*)"]
        assert consistency_level == "Strong"
        _, target = user_collection_migration_names("alice")
        count = len(self.entities[collection_name])
        if collection_name == target:
            self.target_query_count += 1
            if self.target_query_count >= 2:
                count += self.verification_count_offset
        return [{"count(*)": count}]

    def create_schema(
        self, *, auto_id: bool, enable_dynamic_field: bool, description: str
    ) -> _FakeSchema:
        return _FakeSchema(
            auto_id=auto_id,
            enable_dynamic_field=enable_dynamic_field,
            description=description,
        )

    def prepare_index_params(self) -> _FakeIndexParams:
        return _FakeIndexParams()

    def create_collection(
        self,
        *,
        collection_name: str,
        schema: _FakeSchema,
        index_params: _FakeIndexParams,
        **kwargs: Any,
    ) -> None:
        self.descriptions[collection_name] = {
            "collection_name": collection_name,
            "auto_id": schema.auto_id,
            "enable_dynamic_field": schema.enable_dynamic_field,
            "description": schema.description,
            "fields": copy.deepcopy(schema.fields),
            "functions": [],
            **kwargs,
        }
        self.indexes[collection_name] = {}
        for config in index_params.indexes:
            params = copy.deepcopy(config.pop("params", {}))
            self.indexes[collection_name][config["index_name"]] = {
                **config,
                "params": params,
                "state": 3,
                "total_rows": 0,
                "indexed_rows": 0,
                "pending_index_rows": 0,
            }
        self.entities[collection_name] = {}

    def query_iterator(
        self,
        *,
        collection_name: str,
        batch_size: int,
        filter: str,
        output_fields: list[str],
        consistency_level: str,
    ) -> _FakeIterator:
        assert filter == ""
        assert output_fields == ["*"]
        assert consistency_level == "Strong"
        return _FakeIterator(list(self.entities[collection_name].values()), batch_size)

    def alter_collection_properties(
        self, *, collection_name: str, properties: dict[str, Any]
    ) -> None:
        self.descriptions[collection_name].setdefault("properties", {}).update(
            copy.deepcopy(properties)
        )

    def upsert(self, *, collection_name: str, data: list[dict[str, Any]]) -> None:
        self.upsert_calls += 1
        if self.upsert_calls == self.fail_upsert_call:
            self.fail_upsert_call = None
            raise RuntimeError("simulated interrupted batch")
        description = self.descriptions[collection_name]
        if description["auto_id"]:
            assert (
                description.get("properties", {}).get("allow_insert_auto_id") == "true"
            )
        for entity in data:
            self.entities[collection_name][entity["id"]] = copy.deepcopy(entity)


@pytest.fixture(autouse=True)
def _fake_data_type(monkeypatch):
    import pymilvus

    monkeypatch.setattr(pymilvus, "DataType", lambda value: value)


def _executor(client: FakeMilvusClient, audit_path: Path):
    return UserCollectionMigrationExecutor(
        client=client,
        audit=AppendOnlyMigrationAudit(audit_path),
        expected_operator_token=_TOKEN,
    )


def _migrate(executor: UserCollectionMigrationExecutor):
    return executor.migrate(
        subject="alice",
        known_subjects=["alice", "bob"],
        operator_id="operator@example.com",
        provided_operator_token=_TOKEN,
        batch_size=1,
        verification_timeout_seconds=0.02,
    )


def test_migration_copies_then_verifies_and_records_marker(tmp_path):
    client = FakeMilvusClient()
    audit = tmp_path / "migration.jsonl"

    result = _migrate(_executor(client, audit))

    legacy, current = user_collection_migration_names("alice")
    assert result.state == "verified"
    assert result.source_count == result.target_count == 2
    assert client.entities[current] == client.entities[legacy]
    assert client.descriptions[current]["auto_id"] is True
    assert client.descriptions[current]["properties"]["allow_insert_auto_id"] == "false"
    assert client.upsert_calls == 2
    records = AppendOnlyMigrationAudit(audit).read()
    assert [record["event"] for record in records] == [
        "migration_started",
        "migration_verified",
    ]
    assert records[-1]["copied_with"] == "primary-key-upsert"
    assert stat_mode(audit) == 0o600


def test_ambiguous_legacy_ownership_is_refused_before_milvus_access(tmp_path):
    client = FakeMilvusClient()
    executor = _executor(client, tmp_path / "migration.jsonl")

    with pytest.raises(AmbiguousLegacyOwnershipError, match="multiple subjects"):
        executor.migrate(
            subject="a-b",
            known_subjects=["a-b", "a_b"],
            operator_id="operator@example.com",
            provided_operator_token=_TOKEN,
        )

    assert client.calls == 0


def test_invalid_operator_credential_is_refused_before_milvus_access(tmp_path):
    client = FakeMilvusClient()
    executor = _executor(client, tmp_path / "migration.jsonl")

    with pytest.raises(OperatorAuthenticationError, match="invalid"):
        executor.migrate(
            subject="alice",
            known_subjects=["alice", "bob"],
            operator_id="operator@example.com",
            provided_operator_token="wrong-token-that-is-still-never-accepted",
        )

    assert client.calls == 0


def test_verified_retry_rechecks_evidence_without_copying_again(tmp_path):
    client = FakeMilvusClient()
    executor = _executor(client, tmp_path / "migration.jsonl")
    first = _migrate(executor)
    upserts_after_first = client.upsert_calls

    second = _migrate(executor)

    assert second.migration_id == first.migration_id
    assert second.already_complete is True
    assert client.upsert_calls == upserts_after_first
    assert len(executor.audit.read()) == 2


def test_interrupted_batch_retry_resumes_with_idempotent_upserts(tmp_path):
    client = FakeMilvusClient(fail_upsert_call=2)
    executor = _executor(client, tmp_path / "migration.jsonl")

    with pytest.raises(RuntimeError, match="interrupted batch"):
        _migrate(executor)
    _, current = user_collection_migration_names("alice")
    # Simulate a hard process exit that left the temporary Milvus property on.
    client.descriptions[current]["properties"]["allow_insert_auto_id"] = "true"
    result = _migrate(executor)

    legacy, current = user_collection_migration_names("alice")
    assert result.state == "verified"
    assert client.entities[current] == client.entities[legacy]
    assert client.descriptions[current]["properties"]["allow_insert_auto_id"] == "false"
    assert [record["event"] for record in executor.audit.read()] == [
        "migration_started",
        "migration_failed",
        "migration_verified",
    ]


def test_count_verification_failure_records_failure_without_cutover_marker(tmp_path):
    client = FakeMilvusClient(verification_count_offset=-1)
    executor = _executor(client, tmp_path / "migration.jsonl")

    with pytest.raises(MigrationVerificationError, match="row-count verification"):
        _migrate(executor)

    events = [record["event"] for record in executor.audit.read()]
    assert events == ["migration_started", "migration_failed"]
    _, current = user_collection_migration_names("alice")
    assert current in client.descriptions
    assert len(client.entities[current]) == 2


def test_rollback_is_idempotent_and_keeps_both_collections_and_rows(tmp_path):
    client = FakeMilvusClient()
    executor = _executor(client, tmp_path / "migration.jsonl")
    migrated = _migrate(executor)
    legacy, current = user_collection_migration_names("alice")
    before = copy.deepcopy(client.entities)

    rolled_back = executor.rollback(
        subject="alice",
        known_subjects=["alice", "bob"],
        operator_id="operator@example.com",
        provided_operator_token=_TOKEN,
        reason="Rollback requested after application smoke-test failure",
    )
    repeated = executor.rollback(
        subject="alice",
        known_subjects=["alice", "bob"],
        operator_id="operator@example.com",
        provided_operator_token=_TOKEN,
        reason="Rollback requested after application smoke-test failure",
    )

    assert rolled_back.state == "rolled_back"
    assert rolled_back.migration_id == migrated.migration_id
    assert repeated.already_complete is True
    assert client.entities == before
    assert legacy in client.descriptions and current in client.descriptions
    records = executor.audit.read()
    assert records[-1]["event"] == "migration_rolled_back"
    assert records[-1]["data_action"] == "none"
    assert len(records) == 3


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777
