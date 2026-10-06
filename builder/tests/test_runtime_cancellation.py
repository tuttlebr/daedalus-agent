"""Cancellation must reach work before headers and during silent streams."""

import asyncio

import pytest
from daedalus_runtime.cancellation import CancelOnDisconnect


@pytest.mark.parametrize("path", sorted(CancelOnDisconnect.PATHS))
@pytest.mark.parametrize("started", [False, True])
def test_disconnect_cancels_work_and_preserves_body(path, started):
    async def check():
        incoming = asyncio.Queue()
        entered = asyncio.Event()
        cancelled = asyncio.Event()
        sent = []

        async def app(scope, receive, send):
            assert await receive() == {
                "type": "http.request",
                "body": b"first",
                "more_body": True,
            }
            assert await receive() == {
                "type": "http.request",
                "body": b"last",
                "more_body": False,
            }
            if started:
                await send({"type": "http.response.start", "status": 200})
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def send(message):
            sent.append(message)

        task = asyncio.create_task(
            CancelOnDisconnect(app)({"type": "http", "path": path}, incoming.get, send)
        )
        await incoming.put(
            {"type": "http.request", "body": b"first", "more_body": True}
        )
        await incoming.put(
            {"type": "http.request", "body": b"last", "more_body": False}
        )
        await asyncio.wait_for(entered.wait(), 1)
        await incoming.put({"type": "http.disconnect"})
        await asyncio.wait_for(task, 1)
        assert cancelled.is_set()
        assert len(sent) == int(started)

    asyncio.run(check())


def test_normal_completion_does_not_wait_for_disconnect():
    async def check():
        incoming = asyncio.Queue()

        async def app(scope, receive, send):
            await receive()

        await incoming.put({"type": "http.request", "body": b"", "more_body": False})
        await asyncio.wait_for(
            CancelOnDisconnect(app)(
                {"type": "http", "path": "/runtime/prepare"}, incoming.get, None
            ),
            1,
        )

    asyncio.run(check())
