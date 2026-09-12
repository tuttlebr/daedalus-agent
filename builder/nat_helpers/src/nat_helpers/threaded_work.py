"""Keep collection ownership attached to blocking work, not its HTTP waiter."""

import asyncio
import logging

logger = logging.getLogger(__name__)
_PENDING: set[asyncio.Task] = set()


async def run_with_thread_ownership(function, *, lock: asyncio.Lock, timeout: float):
    """Timeout/cancel the waiter while keeping the lock until its thread settles.

    Python cannot safely kill a running thread. A cancelled request must neither
    claim the write was cancelled nor release the collection for overlapping
    local writes. Work waiting for the lock can still be cancelled immediately.
    """
    started = False

    async def owned_work():
        nonlocal started
        async with lock:
            started = True
            return await asyncio.to_thread(function)

    task = asyncio.create_task(owned_work())
    _PENDING.add(task)

    def settled(completed):
        _PENDING.discard(completed)
        if not completed.cancelled():
            exception = completed.exception()
            if exception is not None:
                logger.warning(
                    "Blocking ingestion finished with error_class=%s",
                    type(exception).__name__,
                )

    task.add_done_callback(settled)
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except (asyncio.CancelledError, TimeoutError):
        if not started:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        raise
