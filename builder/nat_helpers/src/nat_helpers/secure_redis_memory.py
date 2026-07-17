"""Redis memory provider with ACL username and verified TLS support.

NAT 1.7.0's built-in Redis memory provider accepts a password but doesn't
expose an ACL username or TLS settings. This narrow provider keeps the upstream
memory implementation and adds only those connection options. Remove it when
the pinned NAT provider exposes the same fields.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field

from nat.builder.builder import Builder
from nat.cli.register_workflow import register_memory
from nat.data_models.common import OptionalSecretStr, get_secret_value
from nat.data_models.component_ref import EmbedderRef
from nat.data_models.memory import MemoryBaseConfig


class DaedalusRedisMemoryClientConfig(
    MemoryBaseConfig,
    name="daedalus_redis_memory",
):
    """NAT Redis memory settings with production connection security."""

    host: str = Field(default="localhost", description="Redis server host")
    db: int = Field(default=0, description="Redis database index")
    port: int = Field(default=6379, description="Redis server port")
    username: str | None = Field(default=None, description="Redis ACL username")
    password: OptionalSecretStr = Field(default=None, description="Redis ACL password")
    key_prefix: str = Field(default="nat", description="Redis key prefix")
    ssl: bool = Field(default=False, description="Use verified TLS for Redis")
    ssl_ca_certs: str | None = Field(
        default=None,
        description="CA bundle used to verify the Redis server certificate",
    )
    embedder: EmbedderRef = Field(description="Embedder used for memory vectors")


@register_memory(config_type=DaedalusRedisMemoryClientConfig)
async def daedalus_redis_memory_client(
    config: DaedalusRedisMemoryClientConfig,
    builder: Builder,
):
    """Build the standard NAT Redis editor over an ACL and TLS connection."""

    import redis.asyncio as redis

    from nat.builder.framework_enum import LLMFrameworkEnum
    from nat.plugins.redis.redis_editor import RedisEditor
    from nat.plugins.redis.schema import ensure_index_exists

    if config.ssl:
        if not config.ssl_ca_certs:
            raise ValueError("ssl_ca_certs is required when Redis TLS is enabled")
        if not Path(config.ssl_ca_certs).is_file():
            raise ValueError(f"Redis CA bundle doesn't exist: {config.ssl_ca_certs}")

    redis_client = redis.Redis(
        host=config.host,
        port=config.port,
        db=config.db,
        username=config.username,
        password=get_secret_value(config.password),
        decode_responses=True,
        socket_timeout=5.0,
        socket_connect_timeout=5.0,
        ssl=config.ssl,
        ssl_ca_certs=config.ssl_ca_certs if config.ssl else None,
        ssl_cert_reqs="required" if config.ssl else None,
    )

    try:
        embedder = await builder.get_embedder(
            config.embedder,
            wrapper_type=LLMFrameworkEnum.LANGCHAIN,
        )
        test_embedding = await embedder.aembed_query("test")
        await ensure_index_exists(
            client=redis_client,
            key_prefix=config.key_prefix,
            embedding_dim=len(test_embedding),
        )
        yield RedisEditor(
            redis_client=redis_client,
            key_prefix=config.key_prefix,
            embedder=embedder,
        )
    finally:
        await redis_client.aclose()
