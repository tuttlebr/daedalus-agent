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
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import redis
from autonomous_agent.store import RedisStore
from autonomous_agent.store import key as autonomy_key

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


def test_autonomous_lease_fences_live_reclaim_and_recovers_after_expiry():
    url = os.environ["REDIS_URL"]
    worker_a = RedisStore(url)
    worker_b = RedisStore(url)

    user_id = f"lease-itest-{uuid.uuid4().hex}"
    queue_key = autonomy_key(user_id, "queue")
    processing_key = autonomy_key(user_id, "processing")
    lease_key = autonomy_key(user_id, "lease")
    try:
        assert worker_a.acquire_lease(user_id, ttl_seconds=1)
        stale_token = worker_a._lease_tokens[user_id]
        worker_a.redis.lpush(queue_key, json.dumps({"id": "request-1"}))
        assert worker_a.dequeue(user_id, timeout=0) == {"id": "request-1"}
        worker_a.upsert_run(user_id, {"id": "interrupted", "status": "running"})

        assert worker_b.acquire_lease(user_id, ttl_seconds=5) is False
        with pytest.raises(RuntimeError, match="owning the lease"):
            worker_b.reclaim_processing(user_id)
        assert worker_a.redis.llen(processing_key) == 1
        assert worker_a.list_runs(user_id)[0]["status"] == "running"

        deadline = time.monotonic() + 3
        while worker_a.redis.exists(lease_key) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not worker_a.redis.exists(lease_key)

        assert worker_b.acquire_lease(user_id, ttl_seconds=5)
        assert worker_b.reclaim_processing(user_id) == 1
        # The stopped owner's record no longer appears to be the live run.
        assert worker_b.list_runs(user_id)[0]["status"] == "aborted"
        assert worker_b.reclaim_processing(user_id) == 0
        assert worker_a.refresh_lease(user_id, ttl_seconds=5) is False
        assert worker_b.dequeue(user_id, timeout=0) == {"id": "request-1"}
        # A worker paused past expiry still holds its old token and in-flight
        # copy. The Redis-side fences, not local state, must stop it from
        # acknowledging or requeueing the replacement's claimed work.
        worker_a._lease_tokens[user_id] = stale_token
        assert worker_a.complete(user_id) is False
        with pytest.raises(RuntimeError, match="after losing the lease"):
            worker_a.reclaim_processing(user_id)
        assert worker_b.redis.llen(processing_key) == 1
        assert worker_b.redis.llen(queue_key) == 0
        assert worker_b.complete(user_id) is True
        assert worker_b.redis.llen(processing_key) == 0
    finally:
        try:
            for redis_key in worker_a.redis.scan_iter(match=f"autonomy:{user_id}:*"):
                worker_a.redis.delete(redis_key)
        finally:
            worker_a.redis.close()
            worker_b.redis.close()


def test_autonomous_reclaim_returns_interrupted_requests_to_the_front():
    """Real LMOVE semantics: reclaimed claims run first, oldest claim first."""
    url = os.environ["REDIS_URL"]
    store = RedisStore(url)
    user_id = f"reclaim-order-itest-{uuid.uuid4().hex}"
    queue_key = autonomy_key(user_id, "queue")
    try:
        assert store.acquire_lease(user_id, ttl_seconds=30)
        for request_id in ("r1", "r2", "r3"):
            store.redis.lpush(queue_key, json.dumps({"id": request_id}))
        # Two claims left in processing by interrupted runs, r1 claimed first.
        assert store.dequeue(user_id, timeout=0) == {"id": "r1"}
        assert store.dequeue(user_id, timeout=0) == {"id": "r2"}

        assert store.reclaim_processing(user_id) == 2

        order = []
        for _ in range(3):
            order.append(store.dequeue(user_id, timeout=0)["id"])
            assert store.complete(user_id) is True
        assert order == ["r1", "r2", "r3"]
        assert store.queue_length(user_id) == 0
    finally:
        try:
            for redis_key in store.redis.scan_iter(match=f"autonomy:{user_id}:*"):
                store.redis.delete(redis_key)
        finally:
            store.redis.close()


@pytest.mark.parametrize("storage", ["string", "json"])
def test_autonomous_schedule_merges_dashboard_writes_atomically(storage):
    url = os.environ["REDIS_URL"]
    admin = redis.from_url(url, decode_responses=True)
    store = RedisStore(url)
    user_id = f"schedule-itest-{uuid.uuid4().hex}"
    config_key = autonomy_key(user_id, "config")

    def dashboard_write(config):
        # The dashboard keeps an existing record's storage type.
        if storage == "json":
            admin.execute_command("JSON.SET", config_key, "$", json.dumps(config))
        else:
            admin.set(config_key, json.dumps(config))

    def stored():
        if storage == "json":
            return json.loads(admin.execute_command("JSON.GET", config_key))
        return json.loads(admin.get(config_key))

    try:
        dashboard_write({"enabled": True, "maxFeedItems": 200})
        # A dashboard save lands after the worker's first read...
        original_get = store.json_get
        state = {"read": False, "watched": False}

        def get_then_dashboard_save(redis_key, fallback=None):
            value = original_get(redis_key, fallback)
            if redis_key == config_key and not state["read"]:
                state["read"] = True
                dashboard_write({"enabled": True, "maxFeedItems": 7})
            return value

        store.json_get = get_then_dashboard_save
        # ...and another inside the worker's WATCH window, forcing a retry.
        original_pipeline = store.redis.pipeline

        def pipeline():
            pipe = original_pipeline()
            original_type = pipe.type

            def type_then_dashboard_save(redis_key):
                result = original_type(redis_key)
                if redis_key == config_key and not state["watched"]:
                    state["watched"] = True
                    dashboard_write(
                        {"enabled": True, "maxFeedItems": 9, "intervalSeconds": 7200}
                    )
                return result

            pipe.type = type_then_dashboard_save
            return pipe

        store.redis.pipeline = pipeline

        request = store.maybe_enqueue_scheduled(user_id)

        assert request is not None
        config = stored()
        assert config["maxFeedItems"] == 9
        assert config["intervalSeconds"] == 7200
        assert config["lastScheduledRunAt"] == request["createdAt"]
        assert state == {"read": True, "watched": True}
        expected_type = "ReJSON-RL" if storage == "json" else "string"
        assert admin.type(config_key) == expected_type
        assert admin.lrange(autonomy_key(user_id, "queue"), 0, -1) == [
            json.dumps(request)
        ]
        assert store.maybe_enqueue_scheduled(user_id) is None
        assert admin.llen(autonomy_key(user_id, "queue")) == 1
    finally:
        for redis_key in admin.scan_iter(match=f"autonomy:{user_id}:*"):
            admin.delete(redis_key)
        store.redis.close()
        admin.close()


def test_autonomous_scoped_acl_reads_json_and_preserves_workspace():
    from autonomous_agent.prompt import load_workspace, workspace_key

    url = os.environ["REDIS_URL"]
    admin = redis.from_url(url, decode_responses=True)
    user_id = f"acl-itest-{uuid.uuid4().hex}"
    acl_username = f"autonomy-itest-{uuid.uuid4().hex}"
    password = uuid.uuid4().hex
    config_key = autonomy_key(user_id, "config")
    identity_key = workspace_key(user_id, "identity")
    store = RedisStore(url)
    options = dict(admin.connection_pool.connection_kwargs)
    options.update(username=acl_username, password=password)
    store.redis = redis.Redis(connection_pool=redis.ConnectionPool(**options))
    try:
        admin.acl_setuser(
            acl_username,
            enabled=True,
            passwords=[f"+{password}"],
            keys=[f"autonomy:{user_id}:*", f"autonomous:{user_id}:workspace:*"],
            commands=["+@all", "-@dangerous", "+info"],
        )
        admin.execute_command("JSON.SET", config_key, ".", '{"enabled":false}')
        admin.set(identity_key, "Preserved workspace identity")

        with pytest.raises(redis.exceptions.NoPermissionError):
            store.redis.execute_command("JSON.GET", "__autonomy_probe__")
        assert store.get_config(user_id)["enabled"] is False
        assert store._json_supported is True
        assert store.acquire_lease(user_id)
        workspace = load_workspace(store, user_id, require_lease=True)
        assert workspace["identity"] == "Preserved workspace identity"
        assert workspace["interests"]
        store.json_set(config_key, {"enabled": False, "intervalSeconds": 7200})
        assert store.get_config(user_id)["intervalSeconds"] == 7200
        store.atomic_update(
            autonomy_key(user_id, "runs"),
            lambda current: (current + [{"id": "verified"}], None),
            lease_user=user_id,
        )
        assert store.list_runs(user_id) == [{"id": "verified"}]

        from autonomous_agent.store import WorkerLeaseLost

        admin.pexpire(autonomy_key(user_id, "lease"), 0)
        with pytest.raises(WorkerLeaseLost):
            store.set_text(identity_key, "stale seed", lease_user=user_id)
        assert store.get_text(identity_key) == "Preserved workspace identity"

        for denied_key in ["session:fixture", f"autonomous:{user_id}:unrelated"]:
            with pytest.raises(redis.exceptions.NoPermissionError):
                store.redis.get(denied_key)
    finally:
        store.redis.close()
        for pattern in [f"autonomy:{user_id}:*", f"autonomous:{user_id}:workspace:*"]:
            for redis_key in admin.scan_iter(match=pattern):
                admin.delete(redis_key)
        admin.acl_deluser(acl_username)
        admin.close()


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


@pytest.mark.parametrize("phase", ["workspace", "feed", "feed_commit"])
@pytest.mark.parametrize("storage", ["string", "json"])
def test_autonomous_output_cannot_write_after_lease_transfer(
    monkeypatch, phase, storage
):
    import threading

    from autonomous_agent.prompt import workspace_key
    from autonomous_agent.worker import run_once

    url = os.environ["REDIS_URL"]
    stale = RedisStore(url)
    current = RedisStore(url)
    user_id = f"output-lease-itest-{uuid.uuid4().hex}"
    lease_key = autonomy_key(user_id, "lease")
    feed_key = autonomy_key(user_id, "feed")
    notes_key = workspace_key(user_id, "inner_state")
    new_item = {"id": "current-owner", "title": "Current finding", "createdAt": 1}
    transferred = False

    def transfer():
        nonlocal transferred
        assert not transferred
        transferred = True
        stale.redis.pexpire(lease_key, 0)
        assert current.acquire_lease(user_id, ttl_seconds=60)
        current.set_text(notes_key, "Current owner's notes")
        current.json_set(feed_key, [new_item])

    class Backend:
        def call(self, *_args, **_kwargs):
            return json.dumps(
                {
                    "summary": "Stale completed work",
                    "workspace_updates": {"inner_state": "Stale notes"}
                    if phase == "workspace"
                    else {},
                    "feed_items": [
                        {"title": "Stale finding", "bluf": "Stale evidence"}
                    ],
                }
            )

    try:
        assert stale.acquire_lease(user_id, ttl_seconds=60)
        if storage == "json":
            stale.redis.execute_command("JSON.SET", feed_key, "$", "[]")
        else:
            stale.redis.set(feed_key, "[]")
        if phase == "feed_commit":
            original_pipeline = stale.redis.pipeline

            def pipeline():
                pipe = original_pipeline()
                execute = pipe.execute

                def execute_after_transfer(*args, **kwargs):
                    if not transferred and any(
                        len(command) > 1 and command[1] == feed_key
                        for command, _options in pipe.command_stack
                    ):
                        transfer()
                    return execute(*args, **kwargs)

                pipe.execute = execute_after_transfer
                return pipe

            monkeypatch.setattr(stale.redis, "pipeline", pipeline)
        else:
            # This read follows the worker's successful owns_lease check.
            def cancel_requested(_user_id, _run_id):
                transfer()
                return False

            monkeypatch.setattr(stale, "cancel_requested", cancel_requested)

        run = run_once(
            store=stale,
            backend=Backend(),
            user_id=user_id,
            request={"trigger": "manual"},
            abort=threading.Event(),
        )

        assert transferred
        assert current.get_text(notes_key) == "Current owner's notes"
        assert current.list_feed(user_id) == [new_item]
        assert run["status"] == "aborted"
        assert current.owns_lease(user_id)
    finally:
        for pattern in (f"autonomy:{user_id}:*", f"autonomous:{user_id}:*"):
            keys = list(current.redis.scan_iter(match=pattern))
            if keys:
                current.redis.delete(*keys)
        stale.redis.close()
        current.redis.close()
