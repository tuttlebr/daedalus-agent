"""Integration test: real Redis JSON round-trip (F-007).

Skipped by default. Run via ``make test-integration`` (sets
``PYTEST_USE_REAL_REDIS=1``), which disables the conftest ``redis`` mock so the
real client is exercised, closing the gap where unit tests only ever talk to
``MagicMock``/``_FakeRedis`` and never validate real serialization/encoding.

Requires a reachable Redis; the CI ``builder-integration`` job starts one as a
service container. Once explicitly enabled, missing dependencies, configuration,
or an unreachable Redis must fail the integration gate.
"""

import asyncio
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import redis

pytestmark = pytest.mark.integration


def test_approval_expiry_identity_and_single_consumer_in_real_redis():
    from user_interaction.approval_tokens import (
        ApprovalRequest,
        approval_token_key,
        issue_approval_token,
        validate_approval_token,
    )

    client = redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    user_id = f"approval-itest-{uuid.uuid4().hex}"
    request = ApprovalRequest(user_id=user_id, action_type="delete", target="record-a")
    keys = []

    def issue():
        token = issue_approval_token(client, request, ttl_seconds=60)
        keys.append(approval_token_key(user_id, token))
        return token

    def validate(token, **overrides):
        return validate_approval_token(
            client,
            **{
                "user_id": user_id,
                "token": token,
                "action_type": "delete",
                "target": "record-a",
                **overrides,
            },
        )[0]

    try:
        # A different user has no authority even to consume Alice's credential.
        token = issue()
        assert not validate(token, user_id=f"{user_id}-other")
        assert validate(token)
        assert not validate(token)

        # A mismatched action by the bound user intentionally burns it.
        token = issue()
        assert not validate(token, target="record-b")
        assert not validate(token)

        token = issue()
        assert validate(token, consume=False)
        client.pexpire(approval_token_key(user_id, token), 0)
        assert not validate(token)

        token = issue()
        with ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(lambda _: validate(token), range(8)))
        assert sum(outcomes) == 1
    finally:
        if keys:
            client.delete(*keys)
        client.close()


def test_redis_json_round_trip():
    url = os.environ["REDIS_URL"]
    client = redis.from_url(url, decode_responses=True)
    key = f"daedalus:itest:roundtrip:{uuid.uuid4().hex}"
    payload = {"user": "alice", "n": 3, "nested": {"ok": True}, "unicode": "café"}
    try:
        client.set(key, json.dumps(payload), ex=60)
        raw = client.get(key)
        assert raw is not None
        assert json.loads(raw) == payload
    finally:
        try:
            client.delete(key)
        finally:
            client.close()


def test_autonomous_local_write_idempotency_is_atomic_in_real_redis(monkeypatch):
    from nat_helpers.idempotency import complete_operation, reserve_operation

    url = os.environ["REDIS_URL"]
    client = redis.from_url(url, decode_responses=True)
    monkeypatch.setenv("REDIS_URL", url)
    execution_id = f"idempotency-itest-{uuid.uuid4().hex}"

    async def scenario():
        first, concurrent = await asyncio.gather(
            reserve_operation(
                user_id="alice",
                execution_id=execution_id,
                operation="add_memory",
                arguments={"memory": "one exact write"},
            ),
            reserve_operation(
                user_id="alice",
                execution_id=execution_id,
                operation="add_memory",
                arguments={"memory": "one exact write"},
            ),
        )
        owners = [
            reservation for reservation in (first, concurrent) if reservation.acquired
        ]
        assert len(owners) == 1
        assert await complete_operation(owners[0], "applied")
        replay = await reserve_operation(
            user_id="alice",
            execution_id=execution_id,
            operation="add_memory",
            arguments={"memory": "one exact write"},
        )
        assert replay.state == "completed"
        assert replay.stored_result == "applied"
        return owners[0].key

    try:
        key = asyncio.run(scenario())
        client.delete(key)
    finally:
        client.close()


def test_expired_idempotency_owner_cannot_complete_successor_reservation(monkeypatch):
    from nat_helpers.idempotency import complete_operation, reserve_operation

    url = os.environ["REDIS_URL"]
    client = redis.from_url(url, decode_responses=True)
    monkeypatch.setenv("REDIS_URL", url)
    request = {
        "user_id": "alice",
        "execution_id": f"idempotency-expiry-itest-{uuid.uuid4().hex}",
        "operation": "add_memory",
        "arguments": {"memory": "one exact write"},
    }
    keys = []

    async def scenario():
        expired = await reserve_operation(**request)
        assert expired.acquired
        keys.append(expired.key)
        # The first owner's reservation expires while its write is still running.
        client.pexpire(expired.key, 0)
        successor = await reserve_operation(**request)
        assert successor.acquired
        assert not await complete_operation(expired, "stale result")
        assert json.loads(client.get(successor.key))["state"] == "in_progress"
        assert await complete_operation(successor, "applied")
        replay = await reserve_operation(**request)
        assert replay.stored_result == "applied"

    try:
        asyncio.run(scenario())
    finally:
        if keys:
            client.delete(*keys)
        client.close()


@pytest.mark.parametrize("stored", ["pending", "completed", "invalid", "empty"])
def test_corrected_document_overlap_preserves_old_receipts(stored):
    from nat_helpers.idempotency import (
        canonical_arguments_sha256,
        operation_key,
        reserve_operation,
    )

    client = redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    identity = {
        "user_id": "alice",
        "execution_id": f"overlap-itest-{uuid.uuid4().hex}",
        "operation": "ingest_user_documents",
    }
    legacy = {"documents": ["immutable-document"], "chunkOverlap": 150}
    corrected = {**legacy, "chunkOverlap": 0}
    keys = [
        operation_key(**identity, arguments_sha256=canonical_arguments_sha256(args))
        for args in [legacy, corrected]
    ]
    raw = {
        "pending": '{"state":"in_progress","owner":"old-owner"}',
        "completed": json.dumps({"state": "completed", "result": "old receipt \ud800"}),
        "invalid": "broken",
        "empty": "",
    }[stored]
    try:
        client.set(keys[0], raw, ex=60)
        reservation = asyncio.run(
            reserve_operation(
                **identity,
                arguments=corrected,
                contract="document-overlap-v2",
                legacy_arguments=legacy,
            )
        )
        assert not reservation.acquired
        if stored == "completed":
            assert reservation.stored_result == "old receipt \ud800"
        assert client.get(keys[0]) == raw
        assert not client.exists(keys[1])
    finally:
        client.delete(*keys)
        client.close()


@pytest.mark.parametrize("zero_first", [False, True])
def test_corrected_document_overlap_has_distinct_atomic_receipts(zero_first):
    from nat_helpers.idempotency import complete_operation, reserve_operation

    client = redis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    identity = {
        "user_id": "alice",
        "execution_id": f"overlap-itest-{uuid.uuid4().hex}",
        "operation": "ingest_user_documents",
        "contract": "document-overlap-v2",
    }
    legacy = {"documents": ["immutable-document"], "chunkOverlap": 150}
    keys = []

    async def scenario():
        for overlap in [0, 150] if zero_first else [150, 0]:
            request = {
                **identity,
                "arguments": {**legacy, "chunkOverlap": overlap},
                "legacy_arguments": legacy if overlap == 0 else None,
            }
            contenders = await asyncio.gather(
                reserve_operation(**request), reserve_operation(**request)
            )
            owners = [item for item in contenders if item.acquired]
            keys.extend(item.key for item in contenders)
            assert len(owners) == 1
            receipt = f"overlap {overlap} \ud800"
            assert await complete_operation(owners[0], receipt)
            replay = await reserve_operation(**request)
            assert not replay.acquired
            assert replay.stored_result == receipt
            assert (
                json.loads(client.get(replay.key))["contract"] == identity["contract"]
            )
        assert len(set(keys)) == 2

    try:
        asyncio.run(scenario())
    finally:
        if keys:
            client.delete(*keys)
        client.close()


@pytest.mark.parametrize("clear_other_user", [False, True])
def test_memory_clear_fences_an_inflight_reflection(clear_other_user):
    from nat_helpers.hindsight_client import derive_bank_id
    from nat_helpers.hindsight_memory_context import (
        _digest,
        _session_brief,
        clear_user_memory_caches,
    )

    user = f"memory-clear-itest-{uuid.uuid4().hex}"
    other = f"{user}-other"
    key = (
        f"daedalus:memory:session:v1:{_digest(derive_bank_id(user))}:"
        f"{_digest('conversation')}"
    )
    client = redis.from_url(os.environ["REDIS_URL"], decode_responses=True)

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        class Hindsight:
            async def reflect(self, **_kwargs):
                started.set()
                await release.wait()
                return "Summary of memories that were cleared"

        pending = asyncio.create_task(
            _session_brief(
                Hindsight(),
                user_id=user,
                conversation_id="conversation",
                query="Summarize my memory",
            )
        )
        try:
            await asyncio.wait_for(started.wait(), 2)
            await clear_user_memory_caches(other if clear_other_user else user)
        finally:
            release.set()
        result = await asyncio.wait_for(pending, 2)
        cached = client.get(key)
        if clear_other_user:
            assert result == "Summary of memories that were cleared"
            assert json.loads(cached)["text"] == result
        else:
            assert result == ""
            assert cached is None

    try:
        asyncio.run(scenario())
    finally:
        for owner in (user, other):
            owner_digest = _digest(derive_bank_id(owner))
            for stored_key in client.scan_iter(
                match=f"daedalus:memory:*{owner_digest}*"
            ):
                client.delete(stored_key)
        client.close()


@pytest.mark.parametrize("phase", ["bootstrap", "reflection"])
@pytest.mark.parametrize("replacement_owner", [False, True])
def test_memory_context_releases_only_its_own_lock(phase, replacement_owner):
    from nat_helpers import hindsight_memory_context as context
    from nat_helpers.hindsight_client import derive_bank_id

    user = f"memory-lease-itest-{uuid.uuid4().hex}"
    bootstrap_id = context._bootstrap_cache_id(user)
    user_digest = context._digest(derive_bank_id(user))
    if phase == "bootstrap":
        lock_key = f"daedalus:memory:bootstrap-lock:{bootstrap_id}"
    else:
        lock_key = (
            f"daedalus:memory:session-lock:v1:{user_digest}:"
            f"{context._digest('conversation')}"
        )
    client = redis.from_url(os.environ["REDIS_URL"], decode_responses=True)

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        class Hindsight:
            async def get_bank_config(self, **_kwargs):
                started.set()
                await release.wait()
                return {"overrides": context._BANK_DEFAULTS}

            async def knowledge_tree(self, **_kwargs):
                return [
                    {"kind": "page", "name": name}
                    for name, _ in context._KNOWLEDGE_PAGES
                ]

            async def reflect(self, **_kwargs):
                started.set()
                await release.wait()
                return "Current session brief"

        operation = (
            context.ensure_bank_initialized(Hindsight(), user)
            if phase == "bootstrap"
            else context._session_brief(
                Hindsight(),
                user_id=user,
                conversation_id="conversation",
                query="Summarize my memory",
            )
        )
        pending = asyncio.create_task(operation)
        try:
            await asyncio.wait_for(started.wait(), 2)
            assert client.exists(lock_key)
            if replacement_owner:
                # Expire the live Redis lease without a wall-clock wait, then
                # let another process acquire it while the first call is stalled.
                client.pexpire(lock_key, 0)
                assert client.set(lock_key, "replacement-owner", nx=True, ex=60)
        finally:
            release.set()
        await asyncio.wait_for(pending, 2)
        assert client.get(lock_key) == (
            "replacement-owner" if replacement_owner else None
        )

    try:
        asyncio.run(scenario())
    finally:
        for digest in (bootstrap_id, user_digest):
            for stored_key in client.scan_iter(match=f"daedalus:memory:*{digest}*"):
                client.delete(stored_key)
        context._process_bootstrap_cache.pop(bootstrap_id, None)
        context._process_bootstrap_locks.pop(bootstrap_id, None)
        client.close()
