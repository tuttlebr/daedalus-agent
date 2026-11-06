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
    state = {"valid": True, "read_only": False, "consumable": True}

    def validate(_client, **kwargs):
        validations.append(kwargs)
        if kwargs["consume"]:
            return state["valid"] and state["consumable"], "reason"
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
            # The task inherits this context: the consumed call is authorized.
            state["scope"] = api.approval._consumed_execution.get()
            record = Record()
            record.status = state.get("record_status", "completed")
            record.first_outcome = asyncio.Event()
            record.first_outcome.set()
            return record

    def call(body, *, request_id="approval-1", token="credential"):
        request = SimpleNamespace(
            headers={"x-daedalus-approval-token": token},
            app=SimpleNamespace(
                state=SimpleNamespace(
                    executions=Executions(),
                    mcp=SimpleNamespace(groups={"docs_mcp_server": {}}),
                )
            ),
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
    # A non-consuming check rejects a mismatch first; exact execution then
    # always spends the credential before the call starts, as Rust does.
    check, consume = approval_route.validations
    for validation in (check, consume):
        assert validation["user_id"] == "alice"
        assert validation["token"] == "credential"
        assert (
            validation["arguments_sha256"]
            == hashlib.sha256(b'{"documentId":"doc-1"}').hexdigest()
        )
    assert (check["consume"], consume["consume"]) == (False, True)
    # Only the exact consumed call is authorized for the started task, and the
    # scope does not outlive the route.
    assert approval_route.state["scope"][0] == "alice"
    assert approval_route.state["scope"][1:3] == ("docs_mcp_server", "update_doc")
    assert approval_route.api.approval._consumed_execution.get() is None


@pytest.mark.parametrize(
    ("record_status", "status"),
    [("completed", 200), ("failed", 422), ("cancelled", 202), ("oauth_required", 202)],
)
def test_execute_status_mapping_matches_the_rust_route(
    approval_route, record_status, status
):
    approval_route.state["record_status"] = record_status
    assert approval_route.call(_approval_body(approval_route.api))[0] == status


@pytest.mark.parametrize(
    ("case", "status"),
    [
        ("hash_mismatch", 409),
        ("not_object", 400),
        ("invalid_json", 400),
        ("read_only", 409),
        ("invalid_credential", 409),
        ("already_consumed", 409),
        ("separator_in_server", 409),
        ("connect", 409),
        ("unowned_server", 409),
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
    elif case == "already_consumed":
        # A concurrent duplicate spent the credential after the first check.
        approval_route.state["consumable"] = False
    elif case in {"separator_in_server", "connect", "unowned_server"}:
        server, tool = {
            "separator_in_server": ("docs_mcp_server__x", "update_doc"),
            "connect": ("docs_mcp_server", "connect"),
            "unowned_server": ("other_server", "update_doc"),
        }[case]
        body = api.ExecuteMcpApprovalRequest(
            server_name=server,
            tool_name=tool,
            canonical_arguments=body.canonical_arguments,
            arguments_sha256=body.arguments_sha256,
        )
    elif case == "request_id":
        request_id = "x" * 129

    with pytest.raises(_HTTPError) as raised:
        approval_route.call(body, request_id=request_id)

    assert raised.value.status_code == status
    assert approval_route.started == []


@pytest.mark.parametrize("failed", [True, False])
def test_direct_execution_returns_successful_output_to_its_owner(failed):
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
        if failed:
            assert "private document" not in str(record.payload())
        else:
            assert record.payload()["result"]["content"] == "private document"
            assert (
                record.payload(initial=True)["result"]["content"] == "private document"
            )
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
        # Shutdown cancels the task; that is a cancellation, not a confirmed
        # failure, and the operation's state is still unknown to the caller.
        assert record.status == "cancelled"
        assert "cancelled before it confirmed success" in record.payload()["error"]

    asyncio.run(run())


def test_auto_approved_operation_cannot_replay_its_credential(monkeypatch):
    """A credential issued before a policy became auto_approve executes once."""
    import mcp_approval_api as api
    import user_interaction.approval_tokens as tokens
    from user_interaction.approval_tokens import ApprovalRequest, issue_approval_token

    class Redis:
        def __init__(self):
            self.store = {}

        def setex(self, key, _ttl, value):
            self.store[key] = value

        def get(self, key):
            return self.store.get(key)

        def getdel(self, key):
            return self.store.pop(key, None)

    redis = Redis()
    arguments = '{"documentId":"doc-1"}'
    digest = hashlib.sha256(arguments.encode()).hexdigest()
    credential = issue_approval_token(
        redis,
        ApprovalRequest(
            user_id="alice",
            action_type="mcp_mutation",
            target="doc-1",
            server_name="docs_mcp_server",
            tool_name="update_doc",
            arguments_sha256=digest,
            canonical_arguments=arguments,
        ),
    )
    monkeypatch.setattr(api, "APIRouter", _Router)
    monkeypatch.setattr(api, "HTTPException", _HTTPError)
    monkeypatch.setattr(
        api, "JSONResponse", lambda body, status_code: (status_code, body)
    )
    monkeypatch.setattr(api, "authenticated_user_id_from_context", lambda: "alice")
    monkeypatch.setattr(api.approval, "_has_local_read_only_evidence", lambda *_: False)
    monkeypatch.setattr(tokens, "make_redis_client", lambda _url=None: redis)
    execute = api.create_mcp_approval_router().routes[
        ("POST", "/v1/mcp-approvals/{request_id}/execute")
    ]
    calls = []

    class MCP:
        groups = {"docs_mcp_server": {}}

        async def call(self, name, payload, user, _emit):
            # An auto-approved policy never reaches the credential check.
            calls.append((name, payload, user))
            return {"content": "updated"}

    async def run():
        executions = Executions(MCP())
        request = SimpleNamespace(
            headers={"x-daedalus-approval-token": credential},
            app=SimpleNamespace(
                state=SimpleNamespace(executions=executions, mcp=MCP())
            ),
        )
        body = api.ExecuteMcpApprovalRequest(
            server_name="docs_mcp_server",
            tool_name="update_doc",
            canonical_arguments=arguments,
            arguments_sha256=digest,
        )
        try:
            first = await execute("approval-1", body, request)
            with pytest.raises(_HTTPError) as replay:
                await execute("approval-1", body, request)
            return first, replay.value.status_code
        finally:
            await executions.close()

    first, replay_status = asyncio.run(run())
    assert first[0] == 200
    assert replay_status == 409
    assert calls == [("docs_mcp_server__update_doc", {"documentId": "doc-1"}, "alice")]
