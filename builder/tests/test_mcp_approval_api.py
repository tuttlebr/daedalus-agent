"""Direct approved calls retain their exact arguments and honest outcome."""

import asyncio
from types import SimpleNamespace

import pytest
from daedalus_runtime.executions import Executions


@pytest.mark.parametrize("failed", [True, False])
def test_direct_execution_is_exact_and_does_not_expose_remote_content(failed):
    async def run():
        observed = []

        class MCP:
            async def call(self, name, arguments, user, _emit):
                observed.append((name, arguments, user))
                return {"content": "private document", "is_error": failed}

        executions = Executions(MCP())
        body = SimpleNamespace(
            server_name="docs", tool_name="update_doc", arguments_sha256="a" * 64
        )
        record = executions.start(
            "alice", body, {"documentId": "document", "content": "exact text"}
        )
        await record.task
        assert observed == [
            (
                "docs__update_doc",
                {"documentId": "document", "content": "exact text"},
                "alice",
            )
        ]
        assert record.status == ("failed" if failed else "completed")
        assert "private document" not in str(record.payload())
        await executions.close()

    asyncio.run(run())


def test_direct_execution_oauth_handoff_remains_pending_until_completion():
    async def run():
        proceed = asyncio.Event()

        class MCP:
            async def call(self, _name, _arguments, _user, emit):
                await emit(
                    "oauth_required",
                    {
                        "auth_url": "https://accounts.google.com/fixture",
                        "oauth_state": "fixture-state",
                    },
                )
                await proceed.wait()
                return {"content": "done"}

        executions = Executions(MCP())
        body = SimpleNamespace(
            server_name="docs", tool_name="update_doc", arguments_sha256="a" * 64
        )
        record = executions.start("alice", body, {})
        await record.first_outcome.wait()
        assert record.payload(initial=True)["oauthState"] == "fixture-state"
        assert record.status == "oauth_required"
        proceed.set()
        await record.task
        assert record.status == "completed"
        assert "auth_url" not in record.payload()
        await executions.close()

    asyncio.run(run())
