"""Render structured briefing data with canonical resources in llm-sandbox."""

import asyncio
import json
import logging
import os
import signal
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import FunctionRef
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.agent_loop_guard import briefing_error_response, current_agent_run
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

_RESOURCES = {
    "edition-policy.json": "references/edition-policy.json",
    "daybook-v4.html": "assets/daybook-v4.html",
    "render_daybook.py": "scripts/render_daybook.py",
    "validate_daybook.py": "scripts/validate_daybook.py",
}


class BriefingRendererConfig(FunctionBaseConfig, name="briefing_renderer"):
    sandbox_tool: FunctionRef = "llm_sandbox_tool"
    skill_directory: str = "/skills/daily-summary"
    timeout_seconds: float = Field(default=60, ge=5, le=180)
    max_edition_bytes: int = Field(default=200_000, ge=10_000, le=1_000_000)
    description: str = (
        "Render and validate the Daily Daedalus from an edition object following "
        "the daily-summary skill. The backend supplies canonical resources and "
        "serializes JSON. Submit one corrected object if validation fails. "
        "A validated edition or terminal error edition is delivered directly."
    )


class BriefingRendererInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The canonical renderer owns the edition's detailed schema. Accepting an
    # object here removes JSON-inside-a-string without duplicating that schema.
    edition: dict[str, Any] = Field(
        description=(
            "A daily-daedalus/v1 edition OBJECT, not a JSON string. Follow "
            "daily-summary/references/edition-format.md for its fields."
        ),
    )


def _result(**payload) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _execution_result(text: str) -> dict:
    if not text.startswith("## Sandbox Execution Result\n"):
        raise ValueError("sandbox execution unavailable")
    fields = dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)
    if fields.get("Timed out") != "False" or fields.get("Truncated") != "False":
        raise ValueError("sandbox result timed out or was truncated")
    if fields.get("Conversation workspace persisted") != "True":
        raise ValueError("sandbox workspace persistence unavailable")
    return {
        "exit_code": int(fields["Exit code"]),
        "stdout": json.loads(fields["stdout (JSON string)"]),
        "fields": fields,
        "collection_incomplete": any(
            line.startswith("Collected file ") and "truncated=True" in line
            for line in text.splitlines()
        )
        or "Missing files (JSON)" in fields,
    }


async def _render_locally(config, edition):
    """Recover transport failures using only the operator-owned canonical scripts.

    Model data is JSON in a temporary directory, never executable code. The same
    schema, HTML and source-policy gates run before any artifact is delivered.
    """
    root = Path(config.skill_directory)
    with tempfile.TemporaryDirectory(prefix="daedalus-briefing-") as temporary:
        directory = Path(temporary)
        for name, relative in _RESOURCES.items():
            (directory / name).write_bytes((root / relative).read_bytes())
        (directory / "edition.json").write_text(
            json.dumps(edition, ensure_ascii=False, allow_nan=False), encoding="utf-8"
        )
        async with asyncio.timeout(config.timeout_seconds):
            for argv in (
                [
                    "render_daybook.py",
                    "edition.json",
                    "edition-policy.json",
                    "daybook-v4.html",
                    "daily-daedalus.html",
                    "coverage.json",
                ],
                [
                    "validate_daybook.py",
                    "daily-daedalus.html",
                    "coverage.json",
                    "edition-policy.json",
                ],
            ):
                # Capture only bounded JSON diagnostics. No shell, inherited
                # provider credentials, or model-selected executable arguments.
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-I",
                    *argv,
                    cwd=directory,
                    env={"PATH": os.defpath},
                    start_new_session=True,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    output = await process.stdout.read(65_537)
                    if len(output) > 65_536:
                        raise ValueError(
                            "canonical renderer diagnostic budget exceeded"
                        )
                    await process.wait()
                finally:
                    if process.returncode is None:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        await asyncio.shield(process.communicate())
                report = json.loads(output)
                if process.returncode != 0 or report.get("passed") is not True:
                    return None, report
            path = directory / "daily-daedalus.html"
            if path.stat().st_size > config.max_edition_bytes * 10:
                raise ValueError("canonical HTML exceeds output budget")
            return path.read_text(encoding="utf-8"), report


def _build_briefing_runner(config: BriefingRendererConfig, sandbox):
    async def render(input_data: BriefingRendererInput) -> str:
        run = current_agent_run()
        if run is None:
            return _result(
                passed=False, error="A request-scoped agent run is required."
            )
        run.briefing = True
        # Parallel model calls share this invocation's lock and budget. Another
        # conversation or subsequent turn gets a different context object.
        async with run.artifact_lock:
            if run.terminal_content is not None:
                return _result(
                    passed=run.terminal_reason == "validated_artifact", terminal=True
                )
            run.attempts["briefing"] += 1
            attempt = run.attempts["briefing"]

            def fail(errors, *, retryable=True):
                terminal = attempt >= 2 or not retryable
                if terminal:
                    run.terminal_reason = "briefing_validation_failed"
                    run.terminal_content = briefing_error_response()
                elif run.repair_phase is None:
                    run.repair_phase = "briefing"
                return _result(
                    passed=False,
                    errors=[str(error)[:500] for error in errors[:5]],
                    attempts_remaining=max(0, 2 - attempt) if not terminal else 0,
                    terminal=terminal,
                )

            if attempt > 2:
                return fail(["Briefing repair budget exhausted."])
            stage = "edition_serialization"
            try:
                serialized = json.dumps(
                    input_data.edition, ensure_ascii=False, allow_nan=False
                )
                if len(serialized.encode()) > config.max_edition_bytes:
                    return fail(
                        ["Edition exceeds the size budget; submit a smaller edition."]
                    )
                root = Path(config.skill_directory)
                files = {
                    name: (root / relative).read_text(encoding="utf-8")
                    for name, relative in _RESOURCES.items()
                }
                files["edition.json"] = serialized
                directory = f"briefing-{uuid.uuid4().hex}"
                stage = "sandbox_staging"
                async with asyncio.timeout(config.timeout_seconds):
                    for name, content in files.items():
                        result = _execution_result(
                            await sandbox(
                                operation="write_file",
                                file_path=f"{directory}/{name}",
                                file_content=content,
                            )
                        )
                        if result["exit_code"] != 0:
                            raise ValueError("unable to stage briefing resources")
                    for argv in (
                        [
                            "python3",
                            "render_daybook.py",
                            "edition.json",
                            "edition-policy.json",
                            "daybook-v4.html",
                            "daily-daedalus.html",
                            "coverage.json",
                        ],
                        [
                            "python3",
                            "validate_daybook.py",
                            "daily-daedalus.html",
                            "coverage.json",
                            "edition-policy.json",
                        ],
                    ):
                        stage = argv[1]
                        result = _execution_result(
                            await sandbox(
                                operation="execute",
                                argv=argv,
                                working_directory=directory,
                            )
                        )
                        report = json.loads(result["stdout"])
                        if not isinstance(report, dict):
                            raise ValueError("invalid validation report")
                        if result["exit_code"] != 0 or report.get("passed") is not True:
                            errors = report.get("errors")
                            return fail(
                                errors
                                if isinstance(errors, list) and errors
                                else ["Briefing validation failed."]
                            )
                    stage = "validated_html_collection"
                    result = _execution_result(
                        await sandbox(
                            operation="read_file",
                            file_path=f"{directory}/daily-daedalus.html",
                        )
                    )
                    if result["exit_code"] != 0:
                        raise ValueError("validated HTML unavailable")
                    html = json.loads(result["fields"]["content (UTF-8 JSON string)"])
                    if not isinstance(html, str) or not html.strip():
                        raise ValueError("validated HTML unavailable")
                    # Collected-file truncation is separate from stdout truncation.
                    if result["collection_incomplete"]:
                        raise ValueError("validated HTML collection incomplete")
                run.terminal_reason = "validated_artifact"
                run.terminal_content = f"```html\n{html}\n```"
                return _result(
                    passed=True, terminal=True, metrics=report.get("metrics", {})
                )
            except (TypeError, ValueError, OSError, TimeoutError, KeyError) as exc:
                logger.warning(
                    "Briefing transport recovery: stage=%s error_class=%s",
                    stage,
                    type(exc).__name__,
                )
                try:
                    html, report = await _render_locally(config, input_data.edition)
                    if html is None:
                        return fail(
                            report.get("errors") or ["Canonical validation failed."]
                        )
                    run.terminal_reason = "validated_artifact"
                    run.terminal_content = f"```html\n{html}\n```"
                    logger.info(
                        "Briefing recovered using canonical local validation: stage=%s",
                        stage,
                    )
                    return _result(
                        passed=True,
                        terminal=True,
                        rendering="local_recovery",
                        metrics=report.get("metrics", {}),
                    )
                except (
                    TypeError,
                    ValueError,
                    OSError,
                    TimeoutError,
                    KeyError,
                ) as recovery:
                    logger.warning(
                        "Briefing recovery unavailable: stage=%s error_class=%s",
                        stage,
                        type(recovery).__name__,
                    )
                    return fail(
                        [
                            f"Briefing rendering failed at {stage}; canonical recovery "
                            f"is unavailable ({type(recovery).__name__})."
                        ],
                        retryable=False,
                    )

    return render


@register_function(config_type=BriefingRendererConfig)
async def briefing_renderer(config: BriefingRendererConfig, builder: Builder):
    sandbox = await builder.get_function(config.sandbox_tool)
    yield FunctionInfo.from_fn(
        _build_briefing_runner(config, sandbox.acall_invoke),
        input_schema=BriefingRendererInput,
        description=config.description,
    )
