"""Propagate HTTP disconnects into request work, including before headers."""

import asyncio

from daedalus_runtime.logging import log_event


class CancelOnDisconnect:
    """One receive owner preserves body backpressure and watches disconnects.

    ASGI does not cancel ordinary handlers on disconnect. StreamingResponse's
    handling also depends on the ASGI version. Cover both paths explicitly for
    model/image preparation and tool calls, without cancelling shared clients.
    """

    PATHS = {
        "/runtime/prepare",
        "/runtime/tools/call",
        "/v1/images/generate",
        "/v1/images/edit",
        "/v1/documents/ingest/stream",
    }

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") not in self.PATHS:
            return await self.app(scope, receive, send)
        messages = asyncio.Queue(maxsize=1)

        async def relay():
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                await messages.put(message)

        work = asyncio.create_task(self.app(scope, messages.get, send))
        disconnected = asyncio.create_task(relay())
        try:
            done, _ = await asyncio.wait(
                (work, disconnected), return_when=asyncio.FIRST_COMPLETED
            )
            if disconnected in done and not work.done():
                log_event("request_disconnected")
                work.cancel()
                await asyncio.gather(work, return_exceptions=True)
                return
            await work
        finally:
            work.cancel()
            disconnected.cancel()
            await asyncio.gather(work, disconnected, return_exceptions=True)
