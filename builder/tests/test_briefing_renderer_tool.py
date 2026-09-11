"""Exercise actual canonical briefing gates through a local sandbox adapter."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

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
    def __init__(self, path):
        self.path = path
        self.calls = []
        self.truncate_html = False

    async def __call__(self, **args):
        self.calls.append(args)
        stdout, code, extra = "", 0, ""
        if args["operation"] == "write_file":
            path = self.path / args["file_path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(args["file_content"], encoding="utf-8")
        elif args["operation"] == "execute":
            # Only execute the two fixed scripts, never model-generated code.
            assert args["argv"][:2] in (
                ["python3", "render_daybook.py"],
                ["python3", "validate_daybook.py"],
            )
            process = subprocess.run(
                [sys.executable, *args["argv"][1:]],
                cwd=self.path / args["working_directory"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            stdout, code = process.stdout, process.returncode
        elif args["operation"] == "read_file":
            content = (self.path / args["file_path"]).read_text()
            extra = (
                f'\nCollected file "{args["file_path"]}" (1 bytes, mode 644, truncated={self.truncate_html}):\n'
                f"content (UTF-8 JSON string): {json.dumps(content)}"
            )
        return (
            "## Sandbox Execution Result\nRequest ID: test\n"
            f"Exit code: {code}\nDuration: 1 ms\nTimed out: False\nTruncated: False\n"
            "Conversation workspace persisted: True\n"
            f'stdout (JSON string): {json.dumps(stdout)}\nstderr (JSON string): ""{extra}'
        )


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
            for name in ("render_daybook.py", "validate_daybook.py"):
                assert (
                    next(tmp_path.glob(f"briefing-*/{name}")).read_bytes()
                    == (SKILL / "scripts" / name).read_bytes()
                )
            assert len(sandbox.calls) == 8

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
            assert run.terminal_content is None
            second = json.loads(await render(BriefingRendererInput(edition=edition())))
            assert second["passed"]
            assert run.attempts["briefing"] == 2

    asyncio.run(scenario())


def test_parallel_invalid_submissions_exhaust_budget_and_cannot_restart(tmp_path):
    sandbox = Sandbox(tmp_path)

    async def scenario():
        with agent_run_scope() as run:
            render = runner(sandbox)
            results = await asyncio.gather(
                *(render(BriefingRendererInput(edition={})) for _ in range(4))
            )
            assert run.attempts["briefing"] == 2
            assert run.terminal_reason == "briefing_validation_failed"
            assert "Briefing unavailable" in run.terminal_content
            assert all(not json.loads(r)["passed"] for r in results)
            calls = len(sandbox.calls)
            await render(BriefingRendererInput(edition=edition()))
            assert len(sandbox.calls) == calls

    asyncio.run(scenario())


def test_truncated_collected_file_never_delivered(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.truncate_html = True

    async def scenario():
        with agent_run_scope() as run:
            result = json.loads(
                await runner(sandbox)(BriefingRendererInput(edition=edition()))
            )
            assert not result["passed"]
            assert run.terminal_content is None

    asyncio.run(scenario())


def test_missing_resources_fail_terminally_and_next_run_has_fresh_budget(tmp_path):
    sandbox = Sandbox(tmp_path)

    async def scenario():
        render = _build_briefing_runner(
            BriefingRendererConfig(skill_directory=str(tmp_path / "missing")), sandbox
        )
        for _ in range(2):
            with agent_run_scope() as run:
                result = json.loads(await render(BriefingRendererInput(edition={})))
                assert result["terminal"]
                assert run.attempts["briefing"] == 1
                assert "Briefing unavailable" in run.terminal_content
        assert not sandbox.calls

    asyncio.run(scenario())
