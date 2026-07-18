"""Tests for durable MCP OAuth token object storage."""

import asyncio

import pytest
from nat.data_models.object_store import KeyAlreadyExistsError, NoSuchKeyError
from nat.object_store.models import ObjectStoreItem
from nat_helpers.secure_redis_object_store import (
    DaedalusRedisObjectStore,
    DaedalusRedisObjectStoreClientConfig,
)
from pydantic import ValidationError


class _FakeRedis:
    def __init__(self):
        self.values = {}

    async def set(self, key, value, *, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = (value, ex)
        return True

    async def get(self, key):
        value = self.values.get(key)
        return value[0] if value else None

    async def delete(self, key):
        return int(self.values.pop(key, None) is not None)


def run(coro):
    return asyncio.run(coro)


def test_config_masks_url_and_rejects_unsafe_bucket_names():
    config = DaedalusRedisObjectStoreClientConfig(
        redis_url="rediss://oauth-user:super-secret@redis.example:6379",
        bucket_name="gmail-mcp-oauth",
    )

    assert "super-secret" not in repr(config)
    with pytest.raises(ValidationError, match="bucket_name"):
        DaedalusRedisObjectStoreClientConfig(
            redis_url="redis://redis:6379",
            bucket_name="../shared",
        )
    with pytest.raises(ValidationError, match="positive"):
        DaedalusRedisObjectStoreClientConfig(
            redis_url="redis://redis:6379",
            bucket_name="gmail",
            ttl=0,
        )


def test_store_round_trip_is_bucket_isolated_and_honors_ttl():
    redis = _FakeRedis()
    gmail = DaedalusRedisObjectStore(redis, bucket_name="gmail", ttl=300)
    calendar = DaedalusRedisObjectStore(redis, bucket_name="calendar")
    item = ObjectStoreItem(data=b'{"access_token":"secret"}')

    run(gmail.put_object("tokens/user-hash", item))
    run(calendar.put_object("tokens/user-hash", item))

    assert set(redis.values) == {
        "nat/object_store/gmail/tokens/user-hash",
        "nat/object_store/calendar/tokens/user-hash",
    }
    assert redis.values["nat/object_store/gmail/tokens/user-hash"][1] == 300
    assert run(gmail.get_object("tokens/user-hash")) == item

    with pytest.raises(KeyAlreadyExistsError):
        run(gmail.put_object("tokens/user-hash", item))

    run(gmail.delete_object("tokens/user-hash"))
    with pytest.raises(NoSuchKeyError):
        run(gmail.get_object("tokens/user-hash"))
