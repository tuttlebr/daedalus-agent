"""Tests for direct button-approved MCP execution."""

import asyncio
import hashlib
from contextlib import asynccontextmanager
from types import SimpleNamespace

from mcp_approval_api import ExecuteMcpApprovalRequest, _run_exact_mcp_call


class _Store:
    def __init__(self):
        self.record = None

    async def create_execution(self):
        self.record = SimpleNamespace(
            execution_id="execution-1",
            status="running",
            result=None,
            error=None,
            pending_oauth=None,
            first_outcome=asyncio.Event(),
            task=None,
        )
        return self.record

    async def set_completed(self, _execution_id, result):
        self.record.status = "completed"
        self.record.result = result
        self.record.first_outcome.set()

    async def set_failed(self, _execution_id, error):
        self.record.status = "failed"
        self.record.error = error
        self.record.first_outcome.set()


class _FlowHandler:
    cleared = False

    @staticmethod
    def set_execution_context(*_args):
        return None

    @staticmethod
    async def authenticate(*_args):
        raise AssertionError("authentication should not be needed")

    def clear_execution_context(self):
        self.cleared = True


def test_direct_executor_invokes_exact_cached_mcp_function(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "internal-token")
    observed = {}

    class _Function:
        async def ainvoke(self, arguments):
            observed.update(arguments)
            return "updated"

    class _Group:
        async def get_accessible_functions(self):
            return {"docs_mcp_server__update_doc": _Function()}

    class _Builder:
        async def get_function_group(self, name):
            assert name == "docs_mcp_server"
            return _Group()

    manager = SimpleNamespace(
        _is_workflow_per_user=True,
        _per_user_builders={"opaque-user": SimpleNamespace(builder=_Builder())},
    )

    @asynccontextmanager
    async def session(**_kwargs):
        yield SimpleNamespace(user_id="opaque-user")

    manager.session = session
    store = _Store()
    flow_handler = _FlowHandler()
    canonical_arguments = '{"documentId":"doc-1","requests":[]}'
    digest = hashlib.sha256(canonical_arguments.encode()).hexdigest()
    request = SimpleNamespace()

    record = asyncio.run(store.create_execution())
    asyncio.run(
        _run_exact_mcp_call(
            manager=manager,
            request=request,
            body=ExecuteMcpApprovalRequest(
                server_name="docs_mcp_server",
                tool_name="update_doc",
                canonical_arguments=canonical_arguments,
                arguments_sha256=digest,
            ),
            record=record,
            execution_store=store,
            http_flow_handler=flow_handler,
            request_id="request-123456",
            user_id="alice",
        )
    )

    assert record.status == "completed"
    assert observed == {"documentId": "doc-1", "requests": []}
    assert flow_handler.cleared is True
