"""Redis object store for durable, user-isolated MCP OAuth tokens.

NAT's built-in Redis object store doesn't accept the connection URL used by
Daedalus, which carries Redis ACL credentials and verified TLS settings. This
provider keeps the upstream object-store contract while using ``REDIS_URL`` as
the single secret connection source.
"""

from __future__ import annotations

import re

from nat.builder.builder import Builder
from nat.cli.register_workflow import register_object_store
from nat.data_models.common import SerializableSecretStr, get_secret_value
from nat.data_models.object_store import (
    KeyAlreadyExistsError,
    NoSuchKeyError,
    ObjectStoreBaseConfig,
)
from nat.object_store.interfaces import ObjectStore
from nat.object_store.models import ObjectStoreItem
from nat.utils.type_utils import override
from nat_helpers.redis_url import close_redis_client
from pydantic import Field, field_validator

_SAFE_BUCKET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class DaedalusRedisObjectStoreClientConfig(
    ObjectStoreBaseConfig,
    name="daedalus_redis_object_store",
):
    """Redis object store configured by a secret URL with ACL/TLS support."""

    redis_url: SerializableSecretStr = Field(
        description="Redis URL containing the required ACL and TLS settings"
    )
    bucket_name: str = Field(description="Isolated object-store bucket name")
    ttl: int | None = Field(
        default=None,
        description="Optional object TTL in seconds; none keeps OAuth refresh tokens",
    )

    @field_validator("bucket_name")
    @classmethod
    def validate_bucket_name(cls, value: str) -> str:
        if not _SAFE_BUCKET_NAME.fullmatch(value):
            raise ValueError(
                "bucket_name must contain only letters, numbers, '.', '_', or '-'"
            )
        return value

    @field_validator("ttl")
    @classmethod
    def validate_ttl(cls, value: int | None) -> int | None:
        if value is not None and value <= 0:
            raise ValueError("ttl must be a positive integer")
        return value


class DaedalusRedisObjectStore(ObjectStore):
    """NAT object-store implementation over an established Redis client."""

    def __init__(self, client, *, bucket_name: str, ttl: int | None = None):
        self._client = client
        self._bucket_name = bucket_name
        self._ttl = ttl

    def _make_key(self, key: str) -> str:
        return f"nat/object_store/{self._bucket_name}/{key}"

    @override
    async def put_object(self, key: str, item: ObjectStoreItem) -> None:
        stored = await self._client.set(
            self._make_key(key),
            item.model_dump_json(),
            nx=True,
            ex=self._ttl,
        )
        if not stored:
            raise KeyAlreadyExistsError(key=key)

    @override
    async def upsert_object(self, key: str, item: ObjectStoreItem) -> None:
        await self._client.set(
            self._make_key(key),
            item.model_dump_json(),
            ex=self._ttl,
        )

    @override
    async def get_object(self, key: str) -> ObjectStoreItem:
        data = await self._client.get(self._make_key(key))
        if data is None:
            raise NoSuchKeyError(key=key)
        return ObjectStoreItem.model_validate_json(data)

    @override
    async def delete_object(self, key: str) -> None:
        if await self._client.delete(self._make_key(key)) == 0:
            raise NoSuchKeyError(key=key)


@register_object_store(config_type=DaedalusRedisObjectStoreClientConfig)
async def daedalus_redis_object_store_client(
    config: DaedalusRedisObjectStoreClientConfig,
    _builder: Builder,
):
    """Connect and yield a durable object store without logging its URL."""

    import redis.asyncio as redis

    client = redis.from_url(
        get_secret_value(config.redis_url),
        decode_responses=False,
        socket_timeout=5.0,
        socket_connect_timeout=5.0,
    )
    try:
        if not await client.ping():
            raise RuntimeError("Failed to connect to Redis OAuth token storage")
        yield DaedalusRedisObjectStore(
            client,
            bucket_name=config.bucket_name,
            ttl=config.ttl,
        )
    finally:
        await close_redis_client(client)
