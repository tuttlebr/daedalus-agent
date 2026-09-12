"""Real thread lifecycle regression for the ingestion collection lock."""

import asyncio
import threading

import pytest
from nat_helpers.threaded_work import run_with_thread_ownership


@pytest.mark.parametrize("cancel", [False, True])
def test_abandoned_waiter_does_not_release_running_collection_write(cancel):
    started, release = threading.Event(), threading.Event()
    calls = []

    def first():
        started.set()
        release.wait(3)
        calls.append("first")

    async def scenario():
        lock = asyncio.Lock()
        task = asyncio.create_task(
            run_with_thread_ownership(first, lock=lock, timeout=3 if cancel else 0.1)
        )
        try:
            async with asyncio.timeout(1):
                while not started.is_set():
                    await asyncio.sleep(0.005)
            if cancel:
                task.cancel()
            with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
                await task
            assert lock.locked()
            successor = asyncio.create_task(
                run_with_thread_ownership(
                    lambda: calls.append("second"), lock=lock, timeout=2
                )
            )
            await asyncio.sleep(0.05)
            assert calls == []
            release.set()
            await successor
            assert calls == ["first", "second"]
            assert not lock.locked()
        finally:
            release.set()

    asyncio.run(scenario())
