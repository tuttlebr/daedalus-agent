"""Tests for Redis URL and lifecycle compatibility helpers."""

import asyncio

import pytest
from nat_helpers.redis_url import close_redis_client, redis_url_from_env


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ("redis://cache", "redis://cache:6380"),
        ("redis://cache/", "redis://cache:6380/"),
        ("redis://cache/2", "redis://cache:6380/2"),
        (
            "rediss://user:p%40ss@cache/2?socket_timeout=5",
            "rediss://user:p%40ss@cache:6380/2?socket_timeout=5",
        ),
        ("redis://[::1]/2", "redis://[::1]:6380/2"),
        ("redis://cache:6379/2", "redis://cache:6379/2"),
        ("unix:///tmp/redis.sock?db=2", "unix:///tmp/redis.sock?db=2"),
    ],
)
def test_redis_port_is_added_to_authority_only(monkeypatch, configured, expected):
    monkeypatch.setenv("REDIS_URL", configured)
    monkeypatch.setenv("REDIS_PORT", "6380")

    assert redis_url_from_env() == expected


def test_redis_url_without_port_override_is_preserved(monkeypatch):
    monkeypatch.setenv("REDIS_URL", " redis://cache/2?socket_timeout=5 ")
    monkeypatch.delenv("REDIS_PORT", raising=False)

    assert redis_url_from_env() == "redis://cache/2?socket_timeout=5"


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
