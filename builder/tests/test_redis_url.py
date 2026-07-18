"""Tests for Redis URL and lifecycle compatibility helpers."""

import asyncio

from nat_helpers.redis_url import close_redis_client


class _ModernClient:
    def __init__(self):
        self.closed = False

    async def aclose(self):
        self.closed = True


class _RedisFourClient:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class _SyncClient:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def test_close_redis_client_supports_modern_and_pinned_clients():
    clients = [_ModernClient(), _RedisFourClient(), _SyncClient()]

    async def scenario():
        for client in clients:
            await close_redis_client(client)

    asyncio.run(scenario())

    assert all(client.closed for client in clients)
