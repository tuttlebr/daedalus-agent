"""Render structured briefing data with canonical resources in llm-sandbox."""

import asyncio
import json
import logging
import os
import runpy
import signal
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Annotated, Any

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import FunctionRef
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.agent_loop_guard import current_agent_run
from nat_helpers.briefing_images import embed_article_photos
from pydantic import BaseModel, ConfigDict, Field, WithJsonSchema, create_model

logger = logging.getLogger(__name__)

_RESOURCES = {
    "edition-policy.json": "references/edition-policy.json",
    "edition-schema.json": "references/edition-schema.json",
    "edition_contract.py": "scripts/edition_contract.py",
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
        "serializes JSON and embeds linked article photos using source captions, "
        "without AI image analysis. Submit one corrected object if validation fails. "
        "A validated edition is delivered directly. If rendering fails, the "
        "submitted edition is returned so the available research can be delivered "
        "as text. At most two rendering attempts are allowed per request."
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


def briefing_input_schema(skill_directory: str):
    """Advertise the canonical nested schema without duplicating its validator.

    Keep runtime edition values as dictionaries so one canonical validation pass
    can return every structural correction instead of NAT rejecting the first.
    """
    root = Path(skill_directory)
    contract = runpy.run_path(str(root / "scripts/edition_contract.py"))
    schema = contract["expanded_schema"](
        contract["load_schema"](root / "references/edition-schema.json")
    )
    return create_model(
        "BriefingRendererInput",
        __base__=BriefingRendererInput,
        edition=(
            # LangChain subsets tool fields and preserves Annotated metadata;
            # Field.json_schema_extra is discarded at that adapter boundary.
            Annotated[dict[str, Any], WithJsonSchema(schema)],
            Field(
                description=BriefingRendererInput.model_fields["edition"].description,
            ),
        ),
    )


class SandboxUnavailable(ValueError):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def _sandbox_capabilities(text: str) -> dict:
    """Read the real llm_sandbox adapter's capability envelope before writes."""
    if not text.startswith("## Sandbox Capabilities\n"):
        raise SandboxUnavailable("capability_discovery_unavailable")
    fields = dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)
    try:
        if (
            json.loads(fields["Isolation"]) != "bubblewrap"
            or json.loads(fields["Stateless"]) is not True
        ):
            raise SandboxUnavailable("sandbox_isolation_unavailable")
        if json.loads(fields["Conversation workspaces"]) is not True:
            raise SandboxUnavailable("sandbox_workspace_unavailable")
        commands = json.loads(fields["Commands (JSON)"])
        if not isinstance(commands, list) or not all(
            isinstance(command, str) for command in commands
        ):
            raise ValueError("invalid command list")
        if "python3" not in commands:
            raise SandboxUnavailable("sandbox_python3_unavailable")
        if "true" not in commands:
            raise SandboxUnavailable("sandbox_file_operations_unavailable")
        maximum = int(fields["Maximum timeout"].removesuffix(" seconds"))
        if maximum < 1:
            raise ValueError("invalid command timeout")
    except SandboxUnavailable:
        raise
    except (KeyError, ValueError, TypeError) as exc:
        raise SandboxUnavailable("capability_report_invalid") from exc
    return {"max_timeout_seconds": maximum}


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
                    return None, {**report, "validation_stage": argv[0]}
            path = directory / "daily-daedalus.html"
            if path.stat().st_size > config.max_edition_bytes * 10:
                raise ValueError("canonical HTML exceeds output budget")
            return path.read_text(encoding="utf-8"), report


def _build_briefing_runner(config: BriefingRendererConfig, sandbox):
    async def render(input_data: BriefingRendererInput) -> str:
        run = current_agent_run()
        if run is None:
            return _result(
                passed=False,
                error="A request-scoped agent run is required.",
                execution_path="none",
                stage="invocation",
                failure_type="authorization",
                recovery_reason=None,
            )
        # Parallel calls share this request's lock and two-attempt budget.
        async with run.artifact_lock:
            if run.terminal_content is not None:
                return _result(
                    passed=run.terminal_reason == "validated_artifact",
                    terminal=True,
                    **run.briefing_execution,
                )
            retained_edition = None
            metadata = {
                "execution_path": "none",
                "stage": "input_validation",
                "failure_type": None,
                "recovery_reason": None,
            }

            def fail(errors, failure_type="validation", *, validation_report=None):
                remaining = max(0, 2 - run.attempts["briefing"])
                metadata["failure_type"] = failure_type
                if failure_type != "attempt_limit":
                    run.briefing_execution = dict(metadata)
                bounded_errors = [str(error)[:500] for error in errors[:100]]
                report = validation_report or {}
                reported_count = report.get("error_count")
                error_count = max(
                    len(errors), reported_count if type(reported_count) is int else 0
                )
                return _result(
                    passed=False,
                    errors=bounded_errors,
                    error_count=error_count,
                    errors_truncated=report.get("errors_truncated") is True
                    or error_count > len(bounded_errors)
                    or any(len(str(error)) > 500 for error in errors[:100]),
                    attempts_remaining=remaining,
                    terminal=False,
                    edition=retained_edition,
                    **metadata,
                    next_step=(
                        "Correct all reported validation errors and retry once, or deliver "
                        "the available sourced research as text with honest source gaps."
                        if remaining
                        else "Do not retry this renderer in this request. Deliver "
                        "the available sourced research as text, retain source gaps, "
                        "and explain that validated HTML rendering failed."
                    ),
                )

            def succeed(html, report):
                metadata["failure_type"] = None
                run.briefing_execution = dict(metadata)
                run.terminal_reason = "validated_artifact"
                run.terminal_content = f"```html\n{html}\n```"
                return _result(
                    passed=True,
                    terminal=True,
                    **metadata,
                    rendering=metadata["execution_path"],
                    metrics=report.get("metrics", {}),
                )

            try:
                serialized = json.dumps(
                    input_data.edition, ensure_ascii=False, allow_nan=False
                )
            except (TypeError, ValueError):
                return fail(["Edition must contain only valid JSON values."], "input")
            if len(serialized.encode()) > config.max_edition_bytes:
                return fail(
                    [
                        "Edition exceeds the size budget; submit a smaller edition. "
                        "The original edition remains in the tool-call arguments."
                    ],
                    "input",
                )
            retained_edition = input_data.edition
            if run.attempts["briefing"] >= 2:
                return fail(
                    ["Briefing rendering attempt limit reached."], "attempt_limit"
                )
            run.attempts["briefing"] += 1
            metadata["stage"] = "resource_loading"
            try:
                root = Path(config.skill_directory)
                files = {
                    name: (root / relative).read_text(encoding="utf-8")
                    for name, relative in _RESOURCES.items()
                }
            except (OSError, UnicodeError):
                return fail(
                    ["Canonical briefing resources are unavailable."], "resource"
                )
            metadata["stage"] = "article_photo_embedding"
            contract = runpy.run_path(str(root / "scripts/edition_contract.py"))
            # Leave malformed input intact for the canonical aggregate diagnostics;
            # do not make image requests for an edition that needs correction.
            prepared_edition = (
                input_data.edition
                if contract["validate_edition"](input_data.edition)
                else await embed_article_photos(input_data.edition)
            )
            files["edition.json"] = json.dumps(
                prepared_edition, ensure_ascii=False, allow_nan=False
            )
            directory = f"briefing-{uuid.uuid4().hex}"
            try:
                async with asyncio.timeout(config.timeout_seconds):
                    metadata["stage"] = "sandbox_capability_check"
                    _sandbox_capabilities(await sandbox(operation="list_commands"))
                    metadata["execution_path"] = "sandbox"
                    metadata["stage"] = "sandbox_staging"
                    for name, content in files.items():
                        result = _execution_result(
                            await sandbox(
                                operation="write_file",
                                file_path=f"{directory}/{name}",
                                file_content=content,
                            )
                        )
                        if result["exit_code"] != 0:
                            raise SandboxUnavailable("sandbox_staging_failed")
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
                        metadata["stage"] = argv[1]
                        result = _execution_result(
                            await sandbox(
                                operation="execute",
                                argv=argv,
                                working_directory=directory,
                            )
                        )
                        report = json.loads(result["stdout"])
                        if not isinstance(report, dict):
                            raise SandboxUnavailable(
                                "sandbox_validation_report_invalid"
                            )
                        if result["exit_code"] != 0 or report.get("passed") is not True:
                            errors = report.get("errors")
                            return fail(
                                errors
                                if isinstance(errors, list) and errors
                                else ["Briefing validation failed."],
                                validation_report=report,
                            )
                    metadata["stage"] = "validated_html_collection"
                    result = _execution_result(
                        await sandbox(
                            operation="read_file",
                            file_path=f"{directory}/daily-daedalus.html",
                        )
                    )
                    if result["exit_code"] != 0:
                        raise SandboxUnavailable("sandbox_html_unavailable")
                    html = json.loads(result["fields"]["content (UTF-8 JSON string)"])
                    if (
                        not isinstance(html, str)
                        or not html.strip()
                        or result["collection_incomplete"]
                    ):
                        raise SandboxUnavailable("sandbox_html_incomplete")
                return succeed(html, report)
            except Exception as exc:
                metadata["recovery_reason"] = (
                    exc.reason
                    if isinstance(exc, SandboxUnavailable)
                    else "sandbox_timeout"
                    if isinstance(exc, TimeoutError)
                    else "sandbox_transport_error"
                )
                metadata["sandbox_failure_stage"] = metadata["stage"]
                metadata["execution_path"] = "local_recovery"
                logger.warning(
                    "Briefing recovery: stage=%s reason=%s error_class=%s",
                    metadata["stage"],
                    metadata["recovery_reason"],
                    type(exc).__name__,
                )
                try:
                    metadata["stage"] = "local_canonical_validation"
                    html, report = await _render_locally(config, prepared_edition)
                    if html is None:
                        metadata["stage"] = report.get(
                            "validation_stage", metadata["stage"]
                        )
                        return fail(
                            report.get("errors") or ["Canonical validation failed."],
                            validation_report=report,
                        )
                    metadata["stage"] = "validated_html_collection"
                    return succeed(html, report)
                except Exception as recovery:
                    logger.warning(
                        "Briefing recovery unavailable: error_class=%s",
                        type(recovery).__name__,
                    )
                    return fail(
                        [
                            "Canonical rendering recovery is unavailable "
                            f"({type(recovery).__name__}). Deliver sourced text with gaps preserved."
                        ],
                        "recovery",
                    )

    return render


@register_function(config_type=BriefingRendererConfig)
async def briefing_renderer(config: BriefingRendererConfig, builder: Builder):
    sandbox = await builder.get_function(config.sandbox_tool)
    input_schema = briefing_input_schema(config.skill_directory)
    render = _build_briefing_runner(config, sandbox.acall_invoke)

    # NAT compares the callable's input type with its schema by identity. Using
    # the base class here makes NAT unwrap the edition field instead of passing
    # the complete input model when a LangChain tool invokes it with a dict.
    async def render_edition(input_data: input_schema) -> str:
        return await render(input_data)

    yield FunctionInfo.from_fn(
        render_edition,
        input_schema=input_schema,
        description=config.description,
    )
