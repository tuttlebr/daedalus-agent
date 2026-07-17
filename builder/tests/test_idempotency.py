"""Tests for autonomous local-write idempotency reservations."""

import asyncio
import json


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.closed = False

    async def set(self, key, value, *, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    async def get(self, key):
        return self.values.get(key)

    async def eval(self, _script, _count, key, owner, completed, _ttl):
        current = json.loads(self.values[key])
        if current.get("state") != "in_progress" or current.get("owner") != owner:
            return 0
        self.values[key] = completed
        return 1

    async def aclose(self):
        self.closed = True


def run(coro):
    return asyncio.run(coro)


def test_operation_key_is_stable_and_does_not_expose_inputs():
    from nat_helpers.idempotency import canonical_arguments_sha256, operation_key

    args_hash = canonical_arguments_sha256({"b": 2, "a": "secret-value"})
    reordered_hash = canonical_arguments_sha256({"a": "secret-value", "b": 2})
    key = operation_key(
        user_id="private-user",
        execution_id="request-123",
        operation="add_memory",
        arguments_sha256=args_hash,
    )

    assert args_hash == reordered_hash
    assert "private-user" not in key
    assert "request-123" not in key
    assert "secret-value" not in key


def test_first_writer_completes_and_replay_returns_stored_result(monkeypatch):
    from nat_helpers import idempotency

    redis = FakeRedis()
    monkeypatch.setattr(idempotency, "_redis_client", lambda: _async_value(redis))

    async def scenario():
        first = await idempotency.reserve_operation(
            user_id="alice",
            execution_id="request-1",
            operation="add_memory",
            arguments={"memory": "Remember this"},
        )
        assert first.acquired
        assert await idempotency.complete_operation(first, "stored")

        replay = await idempotency.reserve_operation(
            user_id="alice",
            execution_id="request-1",
            operation="add_memory",
            arguments={"memory": "Remember this"},
        )
        assert not replay.acquired
        assert replay.state == "completed"
        assert replay.stored_result == "stored"

    run(scenario())


def test_in_progress_replay_fails_closed_without_reacquiring(monkeypatch):
    from nat_helpers import idempotency

    redis = FakeRedis()
    monkeypatch.setattr(idempotency, "_redis_client", lambda: _async_value(redis))

    async def scenario():
        first = await idempotency.reserve_operation(
            user_id="alice",
            execution_id="request-2",
            operation="add_memory",
            arguments={"memory": "Remember this"},
        )
        replay = await idempotency.reserve_operation(
            user_id="alice",
            execution_id="request-2",
            operation="add_memory",
            arguments={"memory": "Remember this"},
        )
        assert first.acquired
        assert not replay.acquired
        assert replay.state == "in_progress"

    run(scenario())


async def _async_value(value):
    return value
