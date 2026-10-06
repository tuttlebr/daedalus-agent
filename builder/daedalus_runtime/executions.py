"""Bounded, user-scoped status for directly approved MCP operations."""

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from nat_helpers.approval_context import approval_marker_scope


@dataclass
class Execution:
    user: str
    execution_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "running"
    created: float = field(default_factory=time.monotonic)
    auth_url: str | None = None
    oauth_state: str | None = None
    result: dict | None = None
    error: str | None = None
    task: asyncio.Task | None = None
    first_outcome: asyncio.Event = field(default_factory=asyncio.Event)

    def payload(self, *, initial=False):
        payload = {"executionId": self.execution_id, "status": self.status}
        if self.status == "oauth_required":
            payload.update(
                {
                    "authUrl" if initial else "auth_url": self.auth_url,
                    "oauthState" if initial else "oauth_state": self.oauth_state,
                }
            )
        if self.result is not None:
            payload["result"] = self.result
        if self.error:
            payload["error"] = self.error
        return payload


class Executions:
    def __init__(self, mcp):
        self.mcp = mcp
        self.records: dict[str, Execution] = {}

    def start(self, user, body, arguments):
        now = time.monotonic()
        self.records = {
            key: record
            for key, record in self.records.items()
            if record.task and (not record.task.done() or now - record.created < 3600)
        }
        if len(self.records) >= 1024:
            raise RuntimeError("Execution capacity reached")
        record = Execution(user)
        self.records[record.execution_id] = record
        record.task = asyncio.create_task(self._run(record, body, arguments))
        return record

    async def _run(self, record, body, arguments):
        async def emit(event, data):
            if event == "oauth_required":
                record.status = "oauth_required"
                record.auth_url, record.oauth_state = (
                    data["auth_url"],
                    data["oauth_state"],
                )
                record.first_outcome.set()

        try:
            with approval_marker_scope(new_request=True):
                outcome = await self.mcp.call(
                    f"{body.server_name}__{body.tool_name}",
                    arguments,
                    record.user,
                    emit,
                )
            if outcome.get("is_error") or outcome.get("terminal"):
                raise RuntimeError("Approved MCP call did not confirm success")
            record.status = "completed"
            record.result = {
                "status": "completed",
                "serverName": body.server_name,
                "toolName": body.tool_name,
                "argumentsSha256": body.arguments_sha256,
            }
        except (Exception, asyncio.CancelledError):
            record.status = "failed"
            record.error = "The approved MCP operation did not confirm success. Check its current state before retrying."
        finally:
            record.first_outcome.set()

    async def close(self):
        tasks = [record.task for record in self.records.values() if record.task]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
