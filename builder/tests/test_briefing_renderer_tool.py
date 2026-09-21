"""Exercise actual canonical briefing gates through a local sandbox adapter."""

import asyncio
import base64
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from nat_helpers.agent_loop_guard import agent_run_scope
from nat_helpers.briefing_renderer import (
    BriefingRendererConfig,
    BriefingRendererInput,
    _build_briefing_runner,
)
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills/daily-summary"
FIXTURE = Path(__file__).parent / "fixtures/daily_summary_dense_edition.json"


def edition():
    return json.loads(FIXTURE.read_text())


class Sandbox:
    """Actual LLM sandbox adapter against a deterministic capability-aware peer."""

    def __init__(self, path, *, python=True, workspace=True, service_max_timeout=60):
        self.path = path
        self.calls = []
        self.http_calls = []
        self.command_timeouts = []
        self.truncate_html = False
        self.python = python
        self.workspace = workspace
        self.service_max_timeout = service_max_timeout
        self.generator = None
        self.adapter = None

    def handle(self, request):
        self.http_calls.append((request.method, request.url.path))
        if request.url.path == "/readyz":
            return httpx.Response(200, json={"status": "ready"})
        if request.url.path == "/v1/commands":
            return httpx.Response(
                200,
                json={
                    "isolation": "bubblewrap",
                    "networkMode": "isolated",
                    "shellEnabled": False,
                    "stateless": True,
                    "path": "/usr/bin:/bin",
                    "commands": ["true", *(["python3"] if self.python else [])],
                    "limits": {
                        "defaultTimeoutSeconds": 30,
                        "maxTimeoutSeconds": self.service_max_timeout,
                        "inputBytes": 1_000_000,
                    },
                    "workspacePersistence": {
                        "supported": self.workspace,
                        "mode": "opt-in",
                        "storage": "pod-local",
                        "ttlSeconds": 3600,
                    },
                },
            )
        assert request.url.path == "/v1/execute"
        payload = json.loads(request.content)
        assert payload["workspaceId"]
        stdout, code, files = "", 0, []
        for staged in payload.get("files", []):
            path = self.path / staged["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(staged["content"], encoding="utf-8")
        argv = payload["argv"]
        if argv != ["true"]:
            self.command_timeouts.append(payload["timeoutSeconds"])
            assert self.python
            assert argv[:2] in (
                ["python3", "render_daybook.py"],
                ["python3", "validate_daybook.py"],
            )
            process = subprocess.run(
                [sys.executable, *argv[1:]],
                cwd=self.path / payload["workingDirectory"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            stdout, code = process.stdout, process.returncode
        for name in payload.get("collect", []):
            content = (self.path / name).read_bytes()
            files.append(
                {
                    "path": name,
                    "size": len(content),
                    "mode": "644",
                    "contentBase64": base64.b64encode(content).decode(),
                    "truncated": self.truncate_html,
                }
            )
        return httpx.Response(
            200,
            json={
                "requestId": "synthetic-renderer",
                "exitCode": code,
                "stdout": stdout,
                "stderr": "",
                "durationMs": 1,
                "timedOut": False,
                "truncated": False,
                "workspacePersisted": self.workspace,
                "files": files,
            },
        )

    async def __call__(self, **args):
        import llm_sandbox.llm_sandbox_function as sandbox_module

        self.calls.append(args)
        if self.adapter is None:
            self.generator = sandbox_module.llm_sandbox_function(
                sandbox_module.LlmSandboxConfig(
                    api_key="synthetic", base_url="https://sandbox.test"
                ),
                object(),
            )
            self.adapter = (await self.generator.__anext__()).single_fn
        real_client = httpx.AsyncClient

        def client(*args, **kwargs):
            return real_client(
                *args, **kwargs, transport=httpx.MockTransport(self.handle)
            )

        with (
            patch.object(sandbox_module.httpx, "AsyncClient", client),
            patch.object(
                sandbox_module,
                "_trusted_scope_from_context",
                return_value=("synthetic-user", "synthetic-conversation"),
            ),
        ):
            return await self.adapter(**args)


def runner(sandbox):
    return _build_briefing_runner(
        BriefingRendererConfig(skill_directory=str(SKILL)), sandbox
    )


def test_structured_input_rejects_double_encoded_or_malformed_json_strings():
    for text in (
        '{"departments":[{"stories":[]}',
        '{"coverage":[{"desk" "sports"}]}',
        json.dumps(edition()),
    ):
        with pytest.raises(ValidationError):
            BriefingRendererInput(edition=text)


def test_canonical_transfer_both_gates_and_exact_html_delivery(tmp_path):
    sandbox = Sandbox(tmp_path)

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=edition()))
            )
            assert result["passed"] is True
            assert run.terminal_reason == "validated_artifact"
            html = next(tmp_path.glob("briefing-*/daily-daedalus.html")).read_text()
            assert run.terminal_content == f"```html\n{html}\n```"
            assert 'id="sources"' not in html
            assert 'id="coverage"' not in html
            for name in ("render_daybook.py", "validate_daybook.py"):
                assert (
                    next(tmp_path.glob(f"briefing-*/{name}")).read_bytes()
                    == (SKILL / "scripts" / name).read_bytes()
                )
            assert len(sandbox.calls) == 11
            assert sandbox.calls[0]["operation"] == "list_commands"
            assert result["execution_path"] == "sandbox"
            assert result["recovery_reason"] is None

    asyncio.run(scenario())


def test_renderer_deadline_does_not_override_adapter_command_timeout(tmp_path):
    sandbox = Sandbox(tmp_path, service_max_timeout=120)
    render = _build_briefing_runner(
        BriefingRendererConfig(skill_directory=str(SKILL), timeout_seconds=90),
        sandbox,
    )

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(await render(BriefingRendererInput(edition=edition())))
            assert result["passed"] is True
            assert result["execution_path"] == "sandbox"
            assert result["recovery_reason"] is None
            assert sandbox.command_timeouts == [30, 30]
            assert run.terminal_reason == "validated_artifact"

    asyncio.run(scenario())


def test_one_correction_then_success(tmp_path):
    sandbox = Sandbox(tmp_path)
    invalid = edition()
    invalid["editors_note"] = []

    async def scenario():
        with agent_run_scope() as run:
            render = runner(sandbox)
            first = json.loads(await render(BriefingRendererInput(edition=invalid)))
            assert first["attempts_remaining"] == 1
            assert "editors_note" in first["errors"][0]
            assert first["edition"] == invalid
            assert first["terminal"] is False
            assert run.terminal_content is None
            second = json.loads(await render(BriefingRendererInput(edition=edition())))
            assert second["passed"]
            assert run.attempts["briefing"] == 2

    asyncio.run(scenario())


def test_parallel_failures_preserve_edition_and_only_stop_further_rendering(tmp_path):
    sandbox = Sandbox(tmp_path)
    invalid = edition()
    invalid["editors_note"] = []

    async def scenario():
        with agent_run_scope() as run:
            render = runner(sandbox)
            results = await asyncio.gather(
                *(render(BriefingRendererInput(edition=invalid)) for _ in range(4))
            )
            results = [json.loads(result) for result in results]
            assert run.attempts["briefing"] == 2
            assert run.terminal_reason is None
            assert run.terminal_content is None
            assert run.stop_reason is None
            assert all(not result["passed"] for result in results)
            assert all(not result["terminal"] for result in results)
            assert all(result["edition"] == invalid for result in results)
            assert [result["attempts_remaining"] for result in results] == [1, 0, 0, 0]
            calls = len(sandbox.calls)
            final = json.loads(await render(BriefingRendererInput(edition=edition())))
            assert len(sandbox.calls) == calls
            assert final["edition"] == edition()
            assert "Do not retry" in final["next_step"]

    asyncio.run(scenario())


def test_truncated_collected_file_recovers_complete_canonical_html(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.truncate_html = True

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=edition()))
            )
            assert result["passed"]
            assert result["rendering"] == "local_recovery"
            complete = next(tmp_path.glob("briefing-*/daily-daedalus.html")).read_text()
            assert run.terminal_content == f"```html\n{complete}\n```"

    asyncio.run(scenario())


def test_malformed_sandbox_envelope_recovers_content_without_weakening_schema():
    async def malformed(**_args):
        return "The sandbox response was unavailable."

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(malformed)(BriefingRendererInput(edition=edition()))
            )
            assert result["passed"]
            assert edition()["lead"]["headline"] in run.terminal_content
        with agent_run_scope() as run:
            invalid = edition()
            invalid["lead"]["source"]["kind"] = "invented"
            result = json.loads(
                await runner(malformed)(BriefingRendererInput(edition=invalid))
            )
            assert not result["passed"]
            assert run.terminal_content is None
            assert any("source" in error for error in result["errors"])

    asyncio.run(scenario())


def test_missing_resources_preserve_research_and_next_run_has_fresh_budget(tmp_path):
    sandbox = Sandbox(tmp_path)

    async def scenario():
        render = _build_briefing_runner(
            BriefingRendererConfig(skill_directory=str(tmp_path / "missing")), sandbox
        )
        for _ in range(2):
            with agent_run_scope() as run:
                result = json.loads(
                    await render(BriefingRendererInput(edition=edition()))
                )
                assert not result["passed"]
                assert result["terminal"] is False
                assert result["edition"] == edition()
                assert result["attempts_remaining"] == 1
                assert run.attempts["briefing"] == 1
                assert run.terminal_content is None
                assert run.terminal_reason is None
        assert not sandbox.calls

    asyncio.run(scenario())


def test_unexpected_transport_errors_preserve_edition_and_bound_recovery(monkeypatch):
    calls = []

    async def unavailable(**_args):
        calls.append("sandbox")
        raise RuntimeError("transport unavailable")

    async def unavailable_locally(*_args):
        calls.append("local")
        raise RuntimeError("renderer unavailable")

    monkeypatch.setattr(
        "nat_helpers.briefing_renderer._render_locally", unavailable_locally
    )

    async def scenario():
        with agent_run_scope() as run:
            render = runner(unavailable)
            for _ in range(4):
                result = json.loads(
                    await render(BriefingRendererInput(edition=edition()))
                )
                assert not result["passed"]
                assert result["terminal"] is False
                assert result["edition"] == edition()
                assert run.terminal_content is None
            assert run.attempts["briefing"] == 2
            assert calls == ["sandbox", "local", "sandbox", "local"]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "invalid", [{"unsupported": float("nan")}, {"large": "x" * 200_000}]
)
def test_unrenderable_inputs_return_bounded_errors_without_execution(tmp_path, invalid):
    sandbox = Sandbox(tmp_path)

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=invalid))
            )
            assert not result["passed"]
            assert result["edition"] is None
            assert result["terminal"] is False
            assert len(json.dumps(result)) < 1000
            assert run.terminal_content is None
            assert not run.attempts["briefing"]
            assert not sandbox.calls

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "python,workspace,reason",
    [
        (False, True, "sandbox_python3_unavailable"),
        (True, False, "sandbox_workspace_unavailable"),
    ],
)
def test_missing_advertised_capability_recovers_before_any_staging(
    tmp_path, python, workspace, reason
):
    sandbox = Sandbox(tmp_path, python=python, workspace=workspace)

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=edition()))
            )
            assert result["passed"] is True
            assert result["execution_path"] == "local_recovery"
            assert result["recovery_reason"] == reason
            assert result["failure_type"] is None
            assert [call["operation"] for call in sandbox.calls] == ["list_commands"]
            assert not any(method == "POST" for method, _ in sandbox.http_calls)
            assert not list(tmp_path.iterdir())
            assert run.outcome_metadata("completed")["artifact_validated"] is True

    asyncio.run(scenario())


def test_schema_failure_reports_all_errors_without_transport_recovery(
    tmp_path, monkeypatch
):
    from unittest.mock import AsyncMock

    sandbox = Sandbox(tmp_path)
    invalid = edition()
    invalid["editors_note"] = []
    invalid["lead"]["unexpected"] = "not allowed"
    local = AsyncMock(
        side_effect=AssertionError("Schema errors must not rerun locally")
    )
    monkeypatch.setattr("nat_helpers.briefing_renderer._render_locally", local)

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=invalid))
            )
            assert result["passed"] is False
            assert result["execution_path"] == "sandbox"
            assert result["failure_type"] == "validation"
            assert result["recovery_reason"] is None
            assert result["stage"] == "render_daybook.py"
            assert result["error_count"] >= 2
            assert result["errors_truncated"] is False
            assert any("editors_note" in error for error in result["errors"])
            assert any("unexpected" in error for error in result["errors"])
            assert (
                run.outcome_metadata("completed")["fallback_reason"]
                == "validation_failed"
            )
            local.assert_not_awaited()

    asyncio.run(scenario())


def test_local_validation_failure_retains_capability_recovery_reason(tmp_path):
    sandbox = Sandbox(tmp_path, python=False)
    invalid = edition()
    invalid["editors_note"] = []

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=invalid))
            )
            assert result["passed"] is False
            assert result["failure_type"] == "validation"
            assert result["execution_path"] == "local_recovery"
            assert result["recovery_reason"] == "sandbox_python3_unavailable"
            assert result["sandbox_failure_stage"] == "sandbox_capability_check"
            assert run.terminal_content is None

    asyncio.run(scenario())


@pytest.mark.parametrize("python", [True, False])
def test_large_error_report_retains_count_and_truncation_without_recovery_failure(
    tmp_path, python
):
    sandbox = Sandbox(tmp_path, python=python)
    invalid = edition()
    invalid["operations_details"] = [{}] * 1000

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=invalid))
            )
            assert result["passed"] is False
            assert result["failure_type"] == "validation"
            assert result["execution_path"] == (
                "sandbox" if python else "local_recovery"
            )
            assert result["errors_truncated"] is True
            assert result["error_count"] == 3001
            assert len(result["errors"]) == 100
            assert result["attempts_remaining"] == 1
            assert run.terminal_content is None

    asyncio.run(scenario())


def test_registered_tool_exposes_configured_canonical_nested_schema(tmp_path):
    import inspect
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from nat_helpers.briefing_renderer import briefing_renderer
    from pydantic import WithJsonSchema

    async def scenario():
        builder = SimpleNamespace(
            get_function=AsyncMock(
                return_value=SimpleNamespace(acall_invoke=AsyncMock())
            )
        )
        config = BriefingRendererConfig(skill_directory=str(SKILL))
        generator = briefing_renderer(config, builder)
        info = await generator.__anext__()
        try:
            parameters = inspect.signature(info.single_fn).parameters
            assert len(parameters) == 1
            assert parameters["input_data"].annotation is info.input_schema
            schema = info.input_schema.model_json_schema()
            edition_schema = schema["properties"]["edition"]
            assert any(
                isinstance(metadata, WithJsonSchema)
                for metadata in info.input_schema.model_fields["edition"].metadata
            )
            assert edition_schema["additionalProperties"] is False
            operations = edition_schema["properties"]["operations_details"]["items"]
            variants = operations["properties"]["blocks"]["items"]["anyOf"]
            assert {
                variant["properties"]["type"]["enum"][0] for variant in variants
            } == {
                "paragraph",
                "subhead",
                "list",
                "table",
                "briefs",
                "figure",
            }
            assert '"$ref"' not in json.dumps(schema)
            # Detailed validation stays with the canonical renderer so failures
            # can return all correction paths together and preserve research.
            assert info.input_schema(edition={"unexpected": "field"}).edition == {
                "unexpected": "field"
            }
        finally:
            await generator.aclose()

    asyncio.run(scenario())
