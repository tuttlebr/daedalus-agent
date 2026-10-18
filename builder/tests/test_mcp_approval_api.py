"""Direct approved calls retain their exact arguments and honest outcome."""

import asyncio
import hashlib
import json
from types import SimpleNamespace

import pytest
from daedalus_runtime.executions import Executions


class _HTTPError(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code


class _Router:
    """Record decorated handlers; conftest replaces FastAPI with a MagicMock."""

    def __init__(self, **_kwargs):
        self.routes = {}

    def post(self, path):
        return lambda handler: self.routes.setdefault(("POST", path), handler)

    def get(self, path):
        return lambda handler: self.routes.setdefault(("GET", path), handler)


@pytest.fixture
def approval_route(monkeypatch):
    import mcp_approval_api as api
    import user_interaction.approval_tokens as tokens

    validations = []
    state = {"valid": True, "read_only": False}

    def validate(_client, **kwargs):
        validations.append(kwargs)
        return state["valid"], "reason"

    monkeypatch.setattr(api, "APIRouter", _Router)
    monkeypatch.setattr(api, "HTTPException", _HTTPError)
    monkeypatch.setattr(
        api, "JSONResponse", lambda body, status_code: (status_code, body)
    )
    monkeypatch.setattr(api, "authenticated_user_id_from_context", lambda: "alice")
    monkeypatch.setattr(
        api.approval,
        "_has_local_read_only_evidence",
        lambda _server, _tool: state["read_only"],
    )
    monkeypatch.setattr(tokens, "make_redis_client", lambda _url=None: object())
    monkeypatch.setattr(tokens, "validate_approval_token", validate)
    router = api.create_mcp_approval_router()
    execute = router.routes[("POST", "/v1/mcp-approvals/{request_id}/execute")]
    started = []

    class Record:
        status = "completed"
        first_outcome = asyncio.Event

        def payload(self, *, initial=False):
            return {"status": self.status, "initial": initial}

    class Executions:
        def start(self, user, body, arguments):
            started.append((user, body.server_name, body.tool_name, arguments))
            record = Record()
            record.first_outcome = asyncio.Event()
            record.first_outcome.set()
            return record

    def call(body, *, request_id="approval-1", token="credential"):
        request = SimpleNamespace(
            headers={"x-daedalus-approval-token": token},
            app=SimpleNamespace(state=SimpleNamespace(executions=Executions())),
        )
        return asyncio.run(execute(request_id, body, request))

    return SimpleNamespace(
        api=api, call=call, started=started, validations=validations, state=state
    )


def _approval_body(api, arguments='{"documentId":"doc-1"}', digest=None):
    return api.ExecuteMcpApprovalRequest(
        server_name="docs_mcp_server",
        tool_name="update_doc",
        canonical_arguments=arguments,
        arguments_sha256=digest or hashlib.sha256(arguments.encode()).hexdigest(),
    )


def test_approved_execution_route_starts_only_the_exact_validated_call(
    approval_route,
):
    status, payload = approval_route.call(_approval_body(approval_route.api))

    assert status == 200 and payload == {"status": "completed", "initial": True}
    assert approval_route.started == [
        ("alice", "docs_mcp_server", "update_doc", {"documentId": "doc-1"})
    ]
    # Pre-execution validation must not consume the one-use credential; the
    # gate consumes it exactly once when the call is dispatched.
    (validation,) = approval_route.validations
    assert validation["user_id"] == "alice"
    assert validation["token"] == "credential"
    assert validation["consume"] is False
    assert (
        validation["arguments_sha256"]
        == hashlib.sha256(b'{"documentId":"doc-1"}').hexdigest()
    )


@pytest.mark.parametrize(
    ("case", "status"),
    [
        ("hash_mismatch", 409),
        ("not_object", 400),
        ("invalid_json", 400),
        ("read_only", 409),
        ("invalid_credential", 409),
        ("request_id", 400),
    ],
)
def test_approved_execution_route_rejects_before_starting_work(
    approval_route, case, status
):
    api = approval_route.api
    body = _approval_body(api)
    request_id = "approval-1"
    if case == "hash_mismatch":
        body = _approval_body(api, digest="0" * 64)
    elif case == "not_object":
        body = _approval_body(api, arguments=json.dumps(["documentId"]))
    elif case == "invalid_json":
        body = _approval_body(api, arguments="{not json")
    elif case == "read_only":
        approval_route.state["read_only"] = True
    elif case == "invalid_credential":
        approval_route.state["valid"] = False
    elif case == "request_id":
        request_id = "x" * 129

    with pytest.raises(_HTTPError) as raised:
        approval_route.call(body, request_id=request_id)

    assert raised.value.status_code == status
    assert approval_route.started == []


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


def test_direct_execution_records_are_bounded_and_unfinished_work_is_retained():
    async def run():
        release = asyncio.Event()

        class MCP:
            async def call(self, *_args):
                await release.wait()
                return {"content": "done"}

        executions = Executions(MCP())
        body = SimpleNamespace(
            server_name="docs", tool_name="update_doc", arguments_sha256="a" * 64
        )
        running = [executions.start("alice", body, {}) for _ in range(1024)]
        for record in running:
            record.created -= 3601
        # Running approved operations are never evicted to make room, however
        # long an OAuth handoff or remote call has been outstanding.
        with pytest.raises(RuntimeError, match="capacity"):
            executions.start("alice", body, {})
        release.set()
        await asyncio.gather(*(record.task for record in running))
        for record in running[:512]:
            record.created += 3601
        # Finished records stay readable for an hour; only expired ones are
        # removed, so the recent half still occupies its capacity.
        fresh = executions.start("alice", body, {})
        assert len(executions.records) == 513
        assert all(
            record.execution_id in executions.records for record in running[:512]
        )
        await fresh.task
        await executions.close()

    asyncio.run(run())


def test_close_reports_cancelled_execution_as_unconfirmed():
    async def run():
        started = asyncio.Event()

        class MCP:
            async def call(self, *_args):
                started.set()
                await asyncio.Event().wait()

        executions = Executions(MCP())
        record = executions.start(
            "alice",
            SimpleNamespace(
                server_name="docs", tool_name="update_doc", arguments_sha256="a" * 64
            ),
            {},
        )
        await started.wait()
        await executions.close()
        assert record.status == "failed"
        assert "did not confirm success" in record.payload()["error"]

    asyncio.run(run())
