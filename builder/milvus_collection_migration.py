"""Fail-closed operator migration for legacy private Milvus collections.

This module is intentionally separate from the NeMo Agent Toolkit tool surface.
It migrates one reviewed authenticated subject at a time and never drops,
truncates, renames, or aliases either collection.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import fcntl
import hashlib
import hmac
import json
import os
import stat
import sys
import time
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from nat_nv_ingest.nat_nv_ingest import (
    plan_user_collection_migrations,
    user_collection_migration_names,
)

_AUDIT_VERSION = 1
_RUNTIME_INDEX_FIELDS = {
    "state",
    "total_rows",
    "indexed_rows",
    "pending_index_rows",
    "index_state_fail_reason",
    "fail_reason",
    "index_id",
    "indexID",
    "build_id",
    "collection_name",
    "created_timestamp",
    "updated_timestamp",
}
_INDEX_IDENTITY_FIELDS = {"field_name", "index_name", "index_type", "metric_type"}
_FINISHED_INDEX_STATES = {"3", "finished", "indexstatefinished"}


class MigrationError(RuntimeError):
    """Base error for a collection migration that must stop fail-closed."""


class OperatorAuthenticationError(MigrationError):
    """Raised when the operator credential or identity isn't valid."""


class AmbiguousLegacyOwnershipError(MigrationError):
    """Raised when the supplied subject inventory can't prove one owner."""


class MigrationStateError(MigrationError):
    """Raised when a migration can't safely start or resume."""


class MigrationVerificationError(MigrationError):
    """Raised when counts, schema, or index state can't be proven."""


@dataclass(frozen=True)
class CollectionSnapshot:
    """Verification evidence for one Milvus collection."""

    count: int
    schema_fingerprint: str
    index_fingerprint: str
    indexes_ready: bool
    primary_field: str
    auto_id: bool
    allow_insert_auto_id: str


@dataclass(frozen=True)
class MigrationResult:
    """A non-secret operator result suitable for JSON output."""

    state: str
    migration_id: str
    subject: str
    legacy_collection: str
    current_collection: str
    source_count: int
    target_count: int
    already_complete: bool = False


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _as_plain_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        result = to_dict()
        if isinstance(result, Mapping):
            return dict(result)
    raise MigrationVerificationError(
        f"Milvus returned an unsupported entity type: {type(value).__name__}"
    )


def _normalize_field(field: Mapping[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {
        "name": str(field.get("name") or ""),
        "type": int(field.get("type", 0)),
        "params": copy.deepcopy(dict(field.get("params") or {})),
    }
    for key in (
        "description",
        "is_primary",
        "is_partition_key",
        "is_clustering_key",
        "nullable",
        "default_value",
        "auto_id",
        "element_type",
    ):
        if key in field:
            normalized[key] = copy.deepcopy(field[key])
    return normalized


def canonical_schema(description: Mapping[str, Any]) -> dict[str, Any]:
    """Return only portable schema properties, excluding server-assigned IDs."""

    functions = description.get("functions") or []
    if functions:
        raise MigrationStateError(
            "Milvus schema functions aren't supported by the private collection "
            "migration executor"
        )
    fields = description.get("fields")
    if not isinstance(fields, list) or not fields:
        raise MigrationVerificationError("Milvus collection has no readable fields")
    return {
        "auto_id": bool(description.get("auto_id", False)),
        "enable_dynamic_field": bool(description.get("enable_dynamic_field", False)),
        "fields": [_normalize_field(field) for field in fields],
    }


def _index_config(description: Mapping[str, Any]) -> dict[str, Any]:
    params = copy.deepcopy(dict(description.get("params") or {}))
    for key, value in description.items():
        if (
            key not in _RUNTIME_INDEX_FIELDS
            and key not in _INDEX_IDENTITY_FIELDS
            and key != "params"
        ):
            params[key] = copy.deepcopy(value)
    return {
        "field_name": str(description.get("field_name") or ""),
        "index_name": str(description.get("index_name") or ""),
        "index_type": str(description.get("index_type") or ""),
        "metric_type": str(description.get("metric_type") or ""),
        "params": params,
    }


def _index_is_ready(description: Mapping[str, Any]) -> bool:
    state = str(description.get("state", "")).replace("_", "").replace(".", "").lower()
    if state not in _FINISHED_INDEX_STATES and not state.endswith("finished"):
        return False
    fail_reason = description.get("index_state_fail_reason") or description.get(
        "fail_reason"
    )
    if fail_reason:
        return False
    pending = description.get("pending_index_rows")
    if pending is not None and int(pending) != 0:
        return False
    total = description.get("total_rows")
    indexed = description.get("indexed_rows")
    if total is not None and indexed is not None and int(total) != int(indexed):
        return False
    return True


def _describe_indexes(client: Any, collection_name: str) -> list[dict[str, Any]]:
    names = sorted(str(name) for name in client.list_indexes(collection_name))
    if not names:
        raise MigrationVerificationError(
            f"collection '{collection_name}' has no indexes to verify"
        )
    return [
        dict(
            client.describe_index(
                collection_name=collection_name,
                index_name=index_name,
            )
        )
        for index_name in names
    ]


def _strong_count(client: Any, collection_name: str) -> int:
    load = getattr(client, "load_collection", None)
    if callable(load):
        load(collection_name=collection_name)
    result = client.query(
        collection_name=collection_name,
        filter="",
        output_fields=["count(*)"],
        consistency_level="Strong",
    )
    if not isinstance(result, list) or len(result) != 1:
        raise MigrationVerificationError(
            f"collection '{collection_name}' didn't return one strong count result"
        )
    row = _as_plain_dict(result[0])
    for key in ("count(*)", "count", "row_count"):
        if key in row:
            count = int(row[key])
            if count < 0:
                break
            return count
    raise MigrationVerificationError(
        f"collection '{collection_name}' returned an invalid strong count"
    )


def inspect_collection(client: Any, collection_name: str) -> CollectionSnapshot:
    """Capture count, schema, and index evidence from one collection."""

    description = dict(client.describe_collection(collection_name=collection_name))
    schema = canonical_schema(description)
    primary = [field["name"] for field in schema["fields"] if field.get("is_primary")]
    if len(primary) != 1:
        raise MigrationVerificationError(
            f"collection '{collection_name}' must have exactly one primary field"
        )
    indexes = _describe_indexes(client, collection_name)
    configs = sorted(
        (_index_config(index) for index in indexes),
        key=lambda item: (item["field_name"], item["index_name"]),
    )
    return CollectionSnapshot(
        count=_strong_count(client, collection_name),
        schema_fingerprint=_fingerprint(schema),
        index_fingerprint=_fingerprint(configs),
        indexes_ready=all(_index_is_ready(index) for index in indexes),
        primary_field=primary[0],
        auto_id=bool(schema["auto_id"]),
        allow_insert_auto_id=_allow_insert_auto_id_value(description),
    )


def _wait_for_ready_snapshot(
    client: Any,
    collection_name: str,
    *,
    timeout_seconds: float,
) -> CollectionSnapshot:
    """Wait only for bounded Milvus index completion after a mutation."""

    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while True:
        try:
            snapshot = inspect_collection(client, collection_name)
            if snapshot.indexes_ready:
                return snapshot
            last_error = MigrationVerificationError(
                f"collection '{collection_name}' indexes aren't ready"
            )
        except Exception as exc:  # Milvus may reject load while an index builds.
            last_error = exc
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MigrationVerificationError(
                f"collection '{collection_name}' didn't become verification-ready "
                f"within {timeout_seconds:g} seconds: {last_error}"
            ) from last_error
        time.sleep(min(0.25, remaining))


def _wait_for_post_copy_verification(
    client: Any,
    *,
    source_name: str,
    target_name: str,
    expected_source: CollectionSnapshot,
    expected_target_allow_insert_auto_id: str,
    timeout_seconds: float,
) -> tuple[CollectionSnapshot, CollectionSnapshot]:
    """Bound visibility/index lag while rejecting structural drift immediately."""

    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while True:
        try:
            source = inspect_collection(client, source_name)
            target = inspect_collection(client, target_name)
            if source != expected_source:
                raise MigrationVerificationError(
                    "legacy source changed while the migration was running"
                )
            if (
                target.schema_fingerprint != expected_source.schema_fingerprint
                or target.index_fingerprint != expected_source.index_fingerprint
            ):
                raise MigrationVerificationError(
                    "target schema or index configuration changed during migration"
                )
            if target.allow_insert_auto_id != expected_target_allow_insert_auto_id:
                raise MigrationVerificationError(
                    "target allow_insert_auto_id policy wasn't restored"
                )
            if target.count > expected_source.count:
                raise MigrationVerificationError(
                    f"row-count verification failed: source={expected_source.count}, "
                    f"target={target.count}"
                )
            if target.count == expected_source.count and target.indexes_ready:
                return source, target
            last_error = MigrationVerificationError(
                f"row-count/index verification pending: source={expected_source.count}, "
                f"target={target.count}, indexes_ready={target.indexes_ready}"
            )
        except MigrationVerificationError as exc:
            if "pending:" not in str(exc):
                raise
            last_error = exc
        except Exception as exc:
            last_error = exc
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MigrationVerificationError(
                f"row-count verification failed within {timeout_seconds:g} seconds: "
                f"{last_error}"
            ) from last_error
        time.sleep(min(0.25, remaining))


def verify_operator(
    *, provided_token: str, expected_token: str, operator_id: str
) -> None:
    """Require a named operator and a distinct, strong migration credential."""

    if not operator_id.strip():
        raise OperatorAuthenticationError("operator_id is required")
    if len(expected_token) < 32:
        raise OperatorAuthenticationError(
            "MILVUS_MIGRATION_OPERATOR_TOKEN must contain at least 32 characters"
        )
    if not hmac.compare_digest(provided_token, expected_token):
        raise OperatorAuthenticationError("invalid migration operator credential")


def assert_unambiguous_owner(
    *, subject: str, known_subjects: Sequence[str], base_collection_name: str
) -> tuple[str, str]:
    """Prove that exactly one inventory subject maps to the legacy collection."""

    subject = subject.strip()
    inventory = [item.strip() for item in known_subjects if item.strip()]
    if not subject or inventory.count(subject) != 1:
        raise AmbiguousLegacyOwnershipError(
            "the subject must appear exactly once in the authenticated-subject inventory"
        )
    try:
        plan = plan_user_collection_migrations(inventory, base_collection_name)
    except ValueError as exc:
        raise AmbiguousLegacyOwnershipError(str(exc)) from exc
    legacy, current = user_collection_migration_names(subject, base_collection_name)
    if plan.get(legacy) != current:
        raise AmbiguousLegacyOwnershipError(
            f"legacy collection '{legacy}' isn't uniquely owned by '{subject}'"
        )
    return legacy, current


class AppendOnlyMigrationAudit:
    """A mode-0600, hash-chained JSONL audit marker store."""

    def __init__(self, path: Path):
        self.path = path

    @staticmethod
    def _validate(records: list[dict[str, Any]]) -> None:
        previous_hash = "0" * 64
        for sequence, record in enumerate(records, start=1):
            if int(record.get("sequence", -1)) != sequence:
                raise MigrationStateError("migration audit sequence is invalid")
            if record.get("previous_hash") != previous_hash:
                raise MigrationStateError("migration audit hash chain is invalid")
            claimed_hash = str(record.get("event_hash") or "")
            payload = dict(record)
            payload.pop("event_hash", None)
            actual_hash = _fingerprint(payload)
            if not hmac.compare_digest(claimed_hash, actual_hash):
                raise MigrationStateError("migration audit record was modified")
            previous_hash = claimed_hash

    @staticmethod
    def _decode(raw: bytes) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for line_number, line in enumerate(raw.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise MigrationStateError(
                    f"migration audit line {line_number} isn't valid JSON"
                ) from exc
            if not isinstance(value, dict):
                raise MigrationStateError(
                    f"migration audit line {line_number} isn't an object"
                )
            records.append(value)
        AppendOnlyMigrationAudit._validate(records)
        return records

    def read(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        if self.path.is_symlink():
            raise MigrationStateError("migration audit path must not be a symlink")
        return self._decode(self.path.read_bytes())

    @contextlib.contextmanager
    def operation_lock(self):
        """Refuse concurrent migration commands sharing this audit state."""

        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = Path(f"{self.path}.lock")
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(lock_path, flags, 0o600)
        try:
            os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise MigrationStateError(
                    "another migration command owns this audit-state lock"
                ) from exc
            yield
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def append(self, event: Mapping[str, Any]) -> dict[str, Any]:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT | os.O_APPEND
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(self.path, flags, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
            os.lseek(fd, 0, os.SEEK_SET)
            remaining = os.fstat(fd).st_size
            chunks: list[bytes] = []
            while remaining:
                chunk = os.read(fd, min(remaining, 1024 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            records = self._decode(b"".join(chunks))
            previous_hash = records[-1]["event_hash"] if records else "0" * 64
            record = {
                **copy.deepcopy(dict(event)),
                "audit_version": _AUDIT_VERSION,
                "sequence": len(records) + 1,
                "previous_hash": previous_hash,
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
            record["event_hash"] = _fingerprint(record)
            encoded = (_canonical_json(record) + "\n").encode("utf-8")
            os.write(fd, encoded)
            os.fsync(fd)
            return record
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def _matching_events(
    events: Iterable[Mapping[str, Any]], *, subject: str, legacy: str, current: str
) -> list[dict[str, Any]]:
    return [
        dict(event)
        for event in events
        if event.get("subject") == subject
        and event.get("legacy_collection") == legacy
        and event.get("current_collection") == current
    ]


def _inventory_fingerprint(known_subjects: Sequence[str]) -> str:
    return _fingerprint(sorted(item.strip() for item in known_subjects if item.strip()))


def _snapshot_matches_marker(
    snapshot: CollectionSnapshot,
    marker: Mapping[str, Any],
    prefix: str,
    *,
    allow_count_growth: bool = False,
) -> bool:
    expected_count = int(marker[f"{prefix}_count"])
    count_matches = (
        snapshot.count >= expected_count
        if allow_count_growth
        else snapshot.count == expected_count
    )
    return bool(
        count_matches
        and snapshot.schema_fingerprint == marker[f"{prefix}_schema_fingerprint"]
        and snapshot.index_fingerprint == marker[f"{prefix}_index_fingerprint"]
        and snapshot.allow_insert_auto_id == marker[f"{prefix}_allow_insert_auto_id"]
        and snapshot.indexes_ready
    )


def _clone_collection(
    client: Any,
    *,
    source_name: str,
    target_name: str,
) -> None:
    """Create the target with the source schema and index configuration."""

    from pymilvus import DataType

    description = dict(client.describe_collection(collection_name=source_name))
    source_schema = canonical_schema(description)
    schema = client.create_schema(
        auto_id=source_schema["auto_id"],
        enable_dynamic_field=source_schema["enable_dynamic_field"],
        description=str(description.get("description") or ""),
    )
    for field in source_schema["fields"]:
        kwargs = copy.deepcopy(dict(field.get("params") or {}))
        for key in (
            "description",
            "is_primary",
            "is_partition_key",
            "is_clustering_key",
            "nullable",
            "default_value",
            "auto_id",
        ):
            if key in field:
                kwargs[key] = copy.deepcopy(field[key])
        element_type = field.get("element_type")
        if element_type:
            kwargs["element_type"] = DataType(int(element_type))
        schema.add_field(
            field_name=field["name"],
            datatype=DataType(int(field["type"])),
            **kwargs,
        )

    index_params = client.prepare_index_params()
    for index in _describe_indexes(client, source_name):
        config = _index_config(index)
        add_kwargs: dict[str, Any] = {
            "field_name": config["field_name"],
            "index_name": config["index_name"],
            "index_type": config["index_type"],
        }
        if config["metric_type"]:
            add_kwargs["metric_type"] = config["metric_type"]
        if config["params"]:
            add_kwargs["params"] = config["params"]
        index_params.add_index(**add_kwargs)

    create_kwargs: dict[str, Any] = {
        "collection_name": target_name,
        "schema": schema,
        "index_params": index_params,
    }
    for source_key, target_key in (
        ("num_shards", "num_shards"),
        ("consistency_level", "consistency_level"),
        ("properties", "properties"),
    ):
        value = description.get(source_key)
        if value not in (None, {}, ""):
            create_kwargs[target_key] = copy.deepcopy(value)
    if any(field.get("is_partition_key") for field in source_schema["fields"]):
        partitions = description.get("num_partitions")
        if partitions:
            create_kwargs["num_partitions"] = int(partitions)
    client.create_collection(**create_kwargs)


def _allow_insert_auto_id_value(description: Mapping[str, Any]) -> str:
    properties = description.get("properties") or {}
    value = properties.get("allow_insert_auto_id", "false")
    return "true" if str(value).strip().lower() in {"1", "true", "yes"} else "false"


@contextlib.contextmanager
def _preserve_auto_ids(
    client: Any,
    collection_name: str,
    *,
    auto_id: bool,
    restore_value: str,
):
    """Temporarily allow existing AutoID values, then restore target policy."""

    if not auto_id:
        yield
        return
    description = dict(client.describe_collection(collection_name=collection_name))
    current = _allow_insert_auto_id_value(description)
    if current != "true":
        client.alter_collection_properties(
            collection_name=collection_name,
            properties={"allow_insert_auto_id": "true"},
        )
    try:
        yield
    finally:
        client.alter_collection_properties(
            collection_name=collection_name,
            properties={"allow_insert_auto_id": restore_value},
        )


def _copy_batches(
    client: Any,
    *,
    source_name: str,
    target_name: str,
    primary_field: str,
    batch_size: int,
) -> int:
    iterator = client.query_iterator(
        collection_name=source_name,
        batch_size=batch_size,
        filter="",
        output_fields=["*"],
        consistency_level="Strong",
    )
    copied = 0
    try:
        while True:
            batch = iterator.next()
            if not batch:
                break
            entities = [_as_plain_dict(entity) for entity in batch]
            if any(primary_field not in entity for entity in entities):
                raise MigrationVerificationError(
                    f"source batch omitted primary field '{primary_field}'"
                )
            client.upsert(collection_name=target_name, data=entities)
            copied += len(entities)
    finally:
        close = getattr(iterator, "close", None)
        if callable(close):
            with contextlib.suppress(Exception):
                close()
    return copied


class UserCollectionMigrationExecutor:
    """Authenticated, one-subject, non-destructive Milvus migration executor."""

    def __init__(
        self,
        *,
        client: Any,
        audit: AppendOnlyMigrationAudit,
        expected_operator_token: str,
    ):
        self.client = client
        self.audit = audit
        self.expected_operator_token = expected_operator_token

    def _authorize(
        self,
        *,
        subject: str,
        known_subjects: Sequence[str],
        base_collection_name: str,
        operator_id: str,
        provided_operator_token: str,
    ) -> tuple[str, str]:
        verify_operator(
            provided_token=provided_operator_token,
            expected_token=self.expected_operator_token,
            operator_id=operator_id,
        )
        return assert_unambiguous_owner(
            subject=subject,
            known_subjects=known_subjects,
            base_collection_name=base_collection_name,
        )

    def migrate(
        self,
        *,
        subject: str,
        known_subjects: Sequence[str],
        operator_id: str,
        provided_operator_token: str,
        base_collection_name: str = "user_uploads",
        batch_size: int = 500,
        verification_timeout_seconds: float = 120.0,
    ) -> MigrationResult:
        """Serialize one copy/verify/mark operation through the audit lock."""

        with self.audit.operation_lock():
            return self._migrate_locked(
                subject=subject,
                known_subjects=known_subjects,
                operator_id=operator_id,
                provided_operator_token=provided_operator_token,
                base_collection_name=base_collection_name,
                batch_size=batch_size,
                verification_timeout_seconds=verification_timeout_seconds,
            )

    def _migrate_locked(
        self,
        *,
        subject: str,
        known_subjects: Sequence[str],
        operator_id: str,
        provided_operator_token: str,
        base_collection_name: str = "user_uploads",
        batch_size: int = 500,
        verification_timeout_seconds: float = 120.0,
    ) -> MigrationResult:
        """Copy, verify, and mark one private collection migration."""

        if batch_size < 1 or batch_size > 5_000:
            raise MigrationStateError("batch_size must be between 1 and 5000")
        if not 0 < verification_timeout_seconds <= 1_800:
            raise MigrationStateError(
                "verification_timeout_seconds must be greater than 0 and at most 1800"
            )
        subject = subject.strip()
        legacy, current = self._authorize(
            subject=subject,
            known_subjects=known_subjects,
            base_collection_name=base_collection_name,
            operator_id=operator_id,
            provided_operator_token=provided_operator_token,
        )
        inventory_fingerprint = _inventory_fingerprint(known_subjects)
        events = _matching_events(
            self.audit.read(), subject=subject, legacy=legacy, current=current
        )
        latest = events[-1] if events else None
        if latest and latest["event"] == "migration_rolled_back":
            raise MigrationStateError(
                "migration was rolled back; a new migration requires an operator "
                "review and a separate audit log"
            )

        if latest and latest["event"] == "migration_verified":
            source = inspect_collection(self.client, legacy)
            target = inspect_collection(self.client, current)
            if not _snapshot_matches_marker(source, latest, "source"):
                raise MigrationVerificationError(
                    "verified legacy source changed after migration"
                )
            if not _snapshot_matches_marker(
                target, latest, "target", allow_count_growth=True
            ):
                raise MigrationVerificationError(
                    "verified target schema, index, or minimum count changed"
                )
            return MigrationResult(
                state="verified",
                migration_id=str(latest["migration_id"]),
                subject=subject,
                legacy_collection=legacy,
                current_collection=current,
                source_count=source.count,
                target_count=target.count,
                already_complete=True,
            )

        if not self.client.has_collection(collection_name=legacy):
            raise MigrationStateError(f"legacy collection '{legacy}' doesn't exist")
        source = inspect_collection(self.client, legacy)
        if not source.indexes_ready:
            raise MigrationVerificationError("legacy source indexes aren't ready")

        started = next(
            (
                event
                for event in reversed(events)
                if event["event"] == "migration_started"
                and (
                    latest is None
                    or event.get("migration_id") == latest.get("migration_id")
                )
            ),
            None,
        )
        if started:
            if started.get("subject_inventory_fingerprint") != inventory_fingerprint:
                raise MigrationStateError(
                    "an incomplete migration can resume only with its original "
                    "authenticated-subject inventory"
                )
            if not _snapshot_matches_marker(source, started, "source"):
                raise MigrationVerificationError(
                    "legacy source changed during an incomplete migration"
                )
            migration_id = str(started["migration_id"])
            target_allow_insert_auto_id = str(started["target_allow_insert_auto_id"])
        else:
            target_exists = self.client.has_collection(collection_name=current)
            if target_exists:
                target_before = inspect_collection(self.client, current)
                if target_before.count != 0:
                    raise MigrationStateError(
                        "hashed target already contains data and has no matching "
                        "migration marker"
                    )
                if (
                    target_before.schema_fingerprint != source.schema_fingerprint
                    or target_before.index_fingerprint != source.index_fingerprint
                    or not target_before.indexes_ready
                ):
                    raise MigrationVerificationError(
                        "empty hashed target doesn't match the legacy schema/index contract"
                    )
                target_allow_insert_auto_id = target_before.allow_insert_auto_id
            else:
                target_allow_insert_auto_id = source.allow_insert_auto_id
            migration_id = str(uuid.uuid4())
            started = self.audit.append(
                {
                    "event": "migration_started",
                    "migration_id": migration_id,
                    "operator_id": operator_id.strip(),
                    "subject": subject,
                    "legacy_collection": legacy,
                    "current_collection": current,
                    "target_existed": target_exists,
                    "source_count": source.count,
                    "source_schema_fingerprint": source.schema_fingerprint,
                    "source_index_fingerprint": source.index_fingerprint,
                    "source_allow_insert_auto_id": source.allow_insert_auto_id,
                    "target_allow_insert_auto_id": target_allow_insert_auto_id,
                    "subject_inventory_fingerprint": inventory_fingerprint,
                }
            )

        try:
            if not self.client.has_collection(collection_name=current):
                _clone_collection(self.client, source_name=legacy, target_name=current)
            target_before_copy = _wait_for_ready_snapshot(
                self.client,
                current,
                timeout_seconds=verification_timeout_seconds,
            )
            if (
                target_before_copy.schema_fingerprint != source.schema_fingerprint
                or target_before_copy.index_fingerprint != source.index_fingerprint
                or not target_before_copy.indexes_ready
            ):
                raise MigrationVerificationError(
                    "hashed target doesn't match the legacy schema/index contract"
                )
            if target_before_copy.count > source.count:
                raise MigrationVerificationError(
                    "hashed target contains more rows than the recorded legacy source"
                )
            with _preserve_auto_ids(
                self.client,
                current,
                auto_id=source.auto_id,
                restore_value=target_allow_insert_auto_id,
            ):
                rows_processed = _copy_batches(
                    self.client,
                    source_name=legacy,
                    target_name=current,
                    primary_field=source.primary_field,
                    batch_size=batch_size,
                )
            source_after, target_after = _wait_for_post_copy_verification(
                self.client,
                source_name=legacy,
                target_name=current,
                expected_source=source,
                expected_target_allow_insert_auto_id=target_allow_insert_auto_id,
                timeout_seconds=verification_timeout_seconds,
            )
        except Exception as exc:
            self.audit.append(
                {
                    "event": "migration_failed",
                    "migration_id": migration_id,
                    "operator_id": operator_id.strip(),
                    "subject": subject,
                    "legacy_collection": legacy,
                    "current_collection": current,
                    "subject_inventory_fingerprint": inventory_fingerprint,
                    "target_allow_insert_auto_id": target_allow_insert_auto_id,
                    "error_type": type(exc).__name__,
                    "error": str(exc)[:500],
                }
            )
            raise

        verified = self.audit.append(
            {
                "event": "migration_verified",
                "migration_id": migration_id,
                "operator_id": operator_id.strip(),
                "subject": subject,
                "legacy_collection": legacy,
                "current_collection": current,
                "subject_inventory_fingerprint": inventory_fingerprint,
                "source_count": source_after.count,
                "source_schema_fingerprint": source_after.schema_fingerprint,
                "source_index_fingerprint": source_after.index_fingerprint,
                "source_allow_insert_auto_id": source_after.allow_insert_auto_id,
                "target_count": target_after.count,
                "target_schema_fingerprint": target_after.schema_fingerprint,
                "target_index_fingerprint": target_after.index_fingerprint,
                "target_allow_insert_auto_id": target_after.allow_insert_auto_id,
                "copied_with": "primary-key-upsert",
                "rows_processed": rows_processed,
                "source_auto_id": source.auto_id,
            }
        )
        return MigrationResult(
            state="verified",
            migration_id=str(verified["migration_id"]),
            subject=subject,
            legacy_collection=legacy,
            current_collection=current,
            source_count=source_after.count,
            target_count=target_after.count,
        )

    def rollback(
        self,
        *,
        subject: str,
        known_subjects: Sequence[str],
        operator_id: str,
        provided_operator_token: str,
        reason: str,
        base_collection_name: str = "user_uploads",
    ) -> MigrationResult:
        """Serialize a logical rollback marker through the audit lock."""

        with self.audit.operation_lock():
            return self._rollback_locked(
                subject=subject,
                known_subjects=known_subjects,
                operator_id=operator_id,
                provided_operator_token=provided_operator_token,
                reason=reason,
                base_collection_name=base_collection_name,
            )

    def _rollback_locked(
        self,
        *,
        subject: str,
        known_subjects: Sequence[str],
        operator_id: str,
        provided_operator_token: str,
        reason: str,
        base_collection_name: str = "user_uploads",
    ) -> MigrationResult:
        """Record a verified logical rollback without changing either collection."""

        subject = subject.strip()
        inventory_fingerprint = _inventory_fingerprint(known_subjects)
        if len(reason.strip()) < 10:
            raise MigrationStateError(
                "rollback reason must contain at least 10 characters"
            )
        legacy, current = self._authorize(
            subject=subject,
            known_subjects=known_subjects,
            base_collection_name=base_collection_name,
            operator_id=operator_id,
            provided_operator_token=provided_operator_token,
        )
        events = _matching_events(
            self.audit.read(), subject=subject, legacy=legacy, current=current
        )
        if events and events[-1]["event"] == "migration_rolled_back":
            marker = events[-1]
            return MigrationResult(
                state="rolled_back",
                migration_id=str(marker["migration_id"]),
                subject=subject,
                legacy_collection=legacy,
                current_collection=current,
                source_count=int(marker["source_count"]),
                target_count=int(marker["target_count"]),
                already_complete=True,
            )
        verified = next(
            (
                event
                for event in reversed(events)
                if event["event"] == "migration_verified"
            ),
            None,
        )
        if verified is None or events[-1]["event"] != "migration_verified":
            raise MigrationStateError(
                "there is no active verified migration to roll back"
            )
        if not self.client.has_collection(
            collection_name=legacy
        ) or not self.client.has_collection(collection_name=current):
            raise MigrationVerificationError(
                "both legacy and hashed collections must exist for rollback"
            )
        source = inspect_collection(self.client, legacy)
        target = inspect_collection(self.client, current)
        if not _snapshot_matches_marker(source, verified, "source"):
            raise MigrationVerificationError(
                "legacy rollback source changed after migration"
            )
        if not _snapshot_matches_marker(
            target, verified, "target", allow_count_growth=True
        ):
            raise MigrationVerificationError(
                "hashed target isn't in a verified rollback-safe state"
            )
        marker = self.audit.append(
            {
                "event": "migration_rolled_back",
                "migration_id": str(verified["migration_id"]),
                "operator_id": operator_id.strip(),
                "subject": subject,
                "legacy_collection": legacy,
                "current_collection": current,
                "subject_inventory_fingerprint": inventory_fingerprint,
                "source_count": source.count,
                "source_schema_fingerprint": source.schema_fingerprint,
                "source_index_fingerprint": source.index_fingerprint,
                "source_allow_insert_auto_id": source.allow_insert_auto_id,
                "target_count": target.count,
                "target_schema_fingerprint": target.schema_fingerprint,
                "target_index_fingerprint": target.index_fingerprint,
                "target_allow_insert_auto_id": target.allow_insert_auto_id,
                "reason": reason.strip(),
                "data_action": "none",
            }
        )
        return MigrationResult(
            state="rolled_back",
            migration_id=str(marker["migration_id"]),
            subject=subject,
            legacy_collection=legacy,
            current_collection=current,
            source_count=source.count,
            target_count=target.count,
        )


def load_subject_inventory(path: Path) -> list[str]:
    """Load a required JSON array representing the full authenticated inventory."""

    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationStateError(f"can't read subject inventory: {exc}") from exc
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise MigrationStateError("subject inventory must be a JSON array of strings")
    if not value:
        raise MigrationStateError("subject inventory must not be empty")
    return value


def _milvus_client_from_env() -> Any:
    from pymilvus import MilvusClient

    uri = (os.getenv("MILVUS_URI") or "").strip()
    token = (os.getenv("MILVUS_TOKEN") or "").strip()
    username = (os.getenv("MILVUS_USERNAME") or os.getenv("MILVUS_USER") or "").strip()
    password = (os.getenv("MILVUS_PASSWORD") or "").strip()
    if not uri:
        raise MigrationStateError("MILVUS_URI is required")
    kwargs: dict[str, Any] = {"uri": uri}
    if token:
        kwargs["token"] = token
    elif username and password:
        kwargs.update({"user": username, "password": password})
    else:
        raise OperatorAuthenticationError(
            "authenticated Milvus credentials are required for migration"
        )
    database = (os.getenv("MILVUS_DATABASE") or "default").strip()
    if database and database != "default":
        kwargs["db_name"] = database
    return MilvusClient(**kwargs)


def _read_operator_token(path: Path) -> str:
    if path.is_symlink():
        raise OperatorAuthenticationError("operator token file must not be a symlink")
    try:
        file_stat = path.stat()
        if not stat.S_ISREG(file_stat.st_mode):
            raise OperatorAuthenticationError("operator token path must be a file")
        if stat.S_IMODE(file_stat.st_mode) & 0o077:
            raise OperatorAuthenticationError(
                "operator token file must not be accessible by group or others"
            )
        token = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise OperatorAuthenticationError(
            f"can't read operator token file: {exc}"
        ) from exc
    return token


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("migrate", "rollback"))
    parser.add_argument("--subject", required=True)
    parser.add_argument("--subject-inventory", type=Path, required=True)
    parser.add_argument("--operator-id", required=True)
    parser.add_argument("--operator-token-file", type=Path, required=True)
    parser.add_argument("--audit-log", type=Path, required=True)
    parser.add_argument("--base-collection", default="user_uploads")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--verification-timeout-seconds", type=float, default=120.0)
    parser.add_argument("--reason", help="Required for rollback")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    client: Any | None = None
    try:
        expected_token = (os.getenv("MILVUS_MIGRATION_OPERATOR_TOKEN") or "").strip()
        provided_token = _read_operator_token(args.operator_token_file)
        verify_operator(
            provided_token=provided_token,
            expected_token=expected_token,
            operator_id=args.operator_id,
        )
        inventory = load_subject_inventory(args.subject_inventory)
        client = _milvus_client_from_env()
        executor = UserCollectionMigrationExecutor(
            client=client,
            audit=AppendOnlyMigrationAudit(args.audit_log),
            expected_operator_token=expected_token,
        )
        common = {
            "subject": args.subject,
            "known_subjects": inventory,
            "operator_id": args.operator_id,
            "provided_operator_token": provided_token,
            "base_collection_name": args.base_collection,
        }
        if args.command == "migrate":
            result = executor.migrate(
                **common,
                batch_size=args.batch_size,
                verification_timeout_seconds=args.verification_timeout_seconds,
            )
        else:
            result = executor.rollback(**common, reason=args.reason or "")
        print(_canonical_json(asdict(result)))
        return 0
    except MigrationError as exc:
        print(f"migration refused: {exc}", file=sys.stderr)
        return 2
    finally:
        if client is not None:
            close = getattr(client, "close", None)
            if callable(close):
                with contextlib.suppress(Exception):
                    close()


if __name__ == "__main__":
    raise SystemExit(main())
