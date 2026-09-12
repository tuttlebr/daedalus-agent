"""Session recovery isolation; real NAT/SDK behavior has a build-time contract."""

import asyncio
import sys
import types
from contextlib import asynccontextmanager

import mcp_patches
import pytest


@pytest.fixture
def group_type(monkeypatch):
    class Group:
        def __init__(self):
            self._sessions = {}
            self._session_rwlock = types.SimpleNamespace(writer=asyncio.Lock())
            self.created = 0
            self.fail_creation = False

        @asynccontextmanager
        async def _session_usage_context(self, session_id):
            if session_id not in self._sessions:
                if self.fail_creation:
                    raise ConnectionError("unavailable")
                self.created += 1
                await asyncio.sleep(0)
                self._sessions[session_id] = session_data()
            data = self._sessions[session_id]
            data.ref_count += 1
            try:
                yield data.client
            finally:
                data.ref_count -= 1

    module = types.ModuleType("nat.plugins.mcp.client.client_impl")
    module.MCPFunctionGroup = Group
    monkeypatch.setitem(sys.modules, module.__name__, module)
    mcp_patches._patch_mcp_session_recovery()
    wrapped = Group._session_usage_context
    mcp_patches._patch_mcp_session_recovery()
    assert Group._session_usage_context is wrapped
    return Group


def session_data(connected=True, ref_count=0):
    stop = asyncio.Event()
    task = asyncio.create_task(stop.wait())
    return types.SimpleNamespace(
        client=types.SimpleNamespace(is_connected=connected),
        ref_count=ref_count,
        stop_event=stop,
        lifetime_task=task,
    )


async def close_all(group):
    for data in group._sessions.values():
        data.stop_event.set()
        await data.lifetime_task


@pytest.mark.parametrize("stopped_lifetime", [False, True])
def test_concurrent_callers_share_one_replacement(group_type, stopped_lifetime):
    async def check():
        group = group_type()
        old = session_data(connected=stopped_lifetime)
        other = session_data()
        group._sessions.update(alice=old, bob=other)
        if stopped_lifetime:
            old.stop_event.set()
            await old.lifetime_task
        clients = []
        both_acquired = asyncio.Event()

        async def use():
            async with group._session_usage_context("alice") as client:
                clients.append(client)
                if len(clients) == 2:
                    both_acquired.set()
                await both_acquired.wait()
                assert group._sessions["alice"].ref_count > 0

        await asyncio.wait_for(asyncio.gather(use(), use()), timeout=1)
        assert group.created == 1
        assert clients[0] is clients[1]
        assert clients[0] is not old.client
        assert old.lifetime_task.done()
        assert group._sessions["alice"].ref_count == 0
        assert group._sessions["bob"] is other
        assert not other.lifetime_task.done()
        await close_all(group)

    asyncio.run(check())


def test_active_call_is_never_closed_or_replaced(group_type):
    async def check():
        group = group_type()
        old = session_data(connected=False, ref_count=1)
        group._sessions["alice"] = old
        async with group._session_usage_context("alice") as client:
            assert client is None
        assert group._sessions["alice"] is old
        assert old.ref_count == 1
        assert not old.stop_event.is_set()
        assert group.created == 0
        old.ref_count = 0
        async with group._session_usage_context("alice") as client:
            assert client is not old.client
        assert group.created == 1
        await close_all(group)

    asyncio.run(check())


def test_healthy_session_is_reused(group_type):
    async def check():
        group = group_type()
        old = session_data()
        group._sessions["alice"] = old
        async with group._session_usage_context("alice") as client:
            assert client is old.client
            assert old.ref_count == 1
        assert old.ref_count == 0
        assert group.created == 0
        await close_all(group)

    asyncio.run(check())


def test_failed_replacement_does_not_restore_stale_client(group_type):
    async def check():
        group = group_type()
        old = session_data(connected=False)
        group._sessions["alice"] = old
        group.fail_creation = True
        with pytest.raises(ConnectionError):
            async with group._session_usage_context("alice"):
                pytest.fail("failed connection was exposed to a caller")
        assert "alice" not in group._sessions
        assert old.lifetime_task.done()
        group.fail_creation = False
        async with group._session_usage_context("alice") as client:
            assert client.is_connected
        await close_all(group)

    asyncio.run(check())


def test_cancelled_call_releases_lease(group_type):
    async def check():
        group = group_type()
        entered = asyncio.Event()

        async def call():
            async with group._session_usage_context("alice"):
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(call())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert group._sessions["alice"].ref_count == 0
        assert not group._sessions["alice"].stop_event.is_set()
        await close_all(group)

    asyncio.run(check())


def test_cleanup_timeout_is_bounded(monkeypatch):
    async def check():
        data = session_data()
        data.lifetime_task.cancel()
        await asyncio.gather(data.lifetime_task, return_exceptions=True)
        data.lifetime_task = asyncio.create_task(asyncio.Event().wait())
        monkeypatch.setattr(mcp_patches, "_MCP_RECOVERY_TOTAL_TIMEOUT", 0.01)
        await asyncio.wait_for(mcp_patches._close_stopped_mcp_session(data), timeout=1)
        await asyncio.gather(data.lifetime_task, return_exceptions=True)
        assert data.lifetime_task.cancelled()

    asyncio.run(check())


def test_session_recovery_rejects_changed_abi(monkeypatch):
    class Group:
        async def _session_usage_context(self, session_id, changed):
            pass

    module = types.ModuleType("nat.plugins.mcp.client.client_impl")
    module.MCPFunctionGroup = Group
    monkeypatch.setitem(sys.modules, module.__name__, module)
    with pytest.raises(RuntimeError, match="Unexpected MCPFunctionGroup"):
        mcp_patches._patch_mcp_session_recovery()
