"""
NAT function that exposes Anthropic-style Agent Skills through one dispatch tool:
  - list_skills:      Level 1 progressive disclosure (metadata)
  - load_skill:       Level 2/3 progressive disclosure (instructions + resources)
  - run_skill_script: Level 3 progressive disclosure (execute bundled scripts)
"""

import asyncio
import json
import logging
import os
import signal
from typing import Literal

from agent_skills.skill_parser import SkillParser
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

AgentSkillsOperation = Literal["list_skills", "load_skill", "run_skill_script"]
_ALL_OPERATIONS = ("list_skills", "load_skill", "run_skill_script")
_DEFAULT_DESCRIPTION = (
    "Unified agent-skills dispatcher. Use operation='list_skills' with an "
    "optional query to discover skills. Then use operation='load_skill' with "
    "skill_name to read the selected skill's instructions or an optional bundled "
    "resource. Follow the returned instructions using the ordinary session tools; "
    "do not look for a separate skill execution tool. operation='run_skill_script' "
    "is available only when explicitly enabled by the operator."
)

# Maximum bytes of combined stdout+stderr captured from a skill script.
# Prevents OOM if a script produces unbounded output.
_MAX_SCRIPT_OUTPUT_BYTES = 1_048_576  # 1 MB

# Environment variables forwarded to skill scripts. This is an ALLOWLIST, not a
# denylist: only these explicitly-safe, non-secret names are passed through. A
# denylist is unsafe here because almost every secret this stack injects uses a
# suffix/service convention (DAEDALUS_INTERNAL_API_TOKEN, *_API_KEY, MINIO_*,
# REDIS_URL, GITHUB_PAT, ...) that a prefix/substring match misses. An allowlist
# guarantees a newly-introduced secret cannot leak to untrusted skill code,
# regardless of how it is named.
_ALLOWED_ENV_VARS = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "PWD",
        "TMPDIR",
        "TEMP",
        "TMP",
        "TZ",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "PYTHONPATH",
        "PYTHONUNBUFFERED",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONIOENCODING",
        "VIRTUAL_ENV",
    }
)


def _sanitized_env() -> dict[str, str]:
    """Return a minimal child environment containing only allowlisted, non-secret vars.

    Built as an allowlist so secrets (API keys, tokens, Redis/MinIO/DB
    credentials, the internal API token) are never exposed to untrusted skill
    code, even if a new secret env var is added later under any naming scheme.
    """
    return {k: v for k, v in os.environ.items() if k in _ALLOWED_ENV_VARS}


def _terminate_process_group(proc) -> None:
    """Kill the script's entire process group.

    Skill scripts (especially .sh) may spawn child processes; ``proc.kill()``
    only signals the direct child and can orphan grandchildren. Because the
    process is launched with ``start_new_session=True`` it is its own process
    group leader, so we can signal the whole group.
    """
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


# ----------------------------------------------------------------------
# Standalone operation helpers
#
# The three tool operations live here as module-level functions (rather than
# closures inside the @register_function generator) so they can be unit-tested
# in isolation. The generator's inner functions are thin delegators.
# ----------------------------------------------------------------------
async def _list_skills(parser: "SkillParser", query: str | None = None) -> str:
    """List all available agent skills with their names and descriptions.

    Args:
        parser: The skill parser holding discovered skill metadata.
        query: Optional single keyword to filter skills (e.g. "nvcf", "review").
               Omit or pass null to list ALL skills. Do NOT pass natural language
               phrases like "list all skills" — that will filter results incorrectly.

    Returns:
        JSON array of objects with 'name' and 'description' fields.
    """
    all_skills = [
        meta.to_dict() for meta in sorted(parser._skills.values(), key=lambda m: m.name)
    ]

    if query:
        # Tokenize query and match any word against name or description
        tokens = query.lower().split()
        all_skills = [
            s
            for s in all_skills
            if any(t in s["name"] or t in s["description"].lower() for t in tokens)
        ]

    if not all_skills:
        return json.dumps({"skills": [], "message": "No skills found."})

    return json.dumps({"skills": all_skills, "count": len(all_skills)})


async def _load_skill(
    parser: "SkillParser", skill_name: str, resource: str | None = None
) -> str:
    """Load a skill's full instructions or a specific resource file.

    When called without a resource path, returns the full SKILL.md instructions.
    When called with a resource path, returns that file's contents.
    Also lists any additional resources and scripts bundled with the skill.

    Args:
        parser: The skill parser holding discovered skill metadata.
        skill_name: The name of the skill to load (as returned by list_skills).
        resource: Optional relative path to a specific resource file within the
                  skill directory. If omitted, returns the main SKILL.md instructions.

    Returns:
        The skill instructions (markdown) or the requested resource file content,
        along with a listing of available resources.
    """
    try:
        if resource:
            content = parser.get_skill_resource(skill_name, resource)
            return content

        instructions = parser.get_skill_instructions(skill_name)
        resources = parser.list_skill_resources(skill_name)

        result = instructions
        if resources:
            result += "\n\n---\n\n**Available resources** (use `load_skill` with the `resource` parameter to read):\n"
            for r in resources:
                result += f"- `{r}`\n"

        return result

    except KeyError:
        available = ", ".join(parser.get_skill_names()) or "(none)"
        return f"Skill '{skill_name}' not found. Available skills: {available}"
    except (FileNotFoundError, PermissionError, ValueError) as exc:
        return f"Error: {exc}"


async def _run_skill_script(
    parser: "SkillParser",
    allowed_script_extensions: list[str],
    script_timeout: int,
    skill_name: str,
    script: str,
    args: str | None = None,
) -> str:
    """Execute a script bundled with a skill and return its output.

    Args:
        parser: The skill parser holding discovered skill metadata.
        allowed_script_extensions: File extensions permitted for execution.
        script_timeout: Maximum seconds the script is allowed to run.
        skill_name: The name of the skill containing the script.
        script: Relative path to the script within the skill directory
                (e.g. 'scripts/validate.py').
        args: Optional space-separated arguments to pass to the script.

    Returns:
        The combined stdout and stderr output from the script, or an error message.
    """
    try:
        resolved = parser.resolve_script_path(skill_name, script)
    except (KeyError, FileNotFoundError, PermissionError) as exc:
        return f"Error: {exc}"

    ext = resolved.suffix.lower()
    if ext not in allowed_script_extensions:
        return (
            f"Error: Extension '{ext}' is not allowed. "
            f"Permitted: {allowed_script_extensions}"
        )

    if ext == ".py":
        cmd = ["python3", str(resolved)]
    elif ext == ".sh":
        cmd = ["bash", str(resolved)]
    else:
        cmd = [str(resolved)]

    if args:
        cmd.extend(args.split())

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(resolved.parent),
            env=_sanitized_env(),
            start_new_session=True,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=script_timeout,
        )
    except TimeoutError:
        _terminate_process_group(proc)
        try:
            await proc.wait()
        except Exception:  # noqa: BLE001  # nosec B110 - best-effort reap of killed child
            pass
        return f"Error: Script timed out after {script_timeout}s"
    except OSError as exc:
        return f"Error executing script: {exc}"

    output_parts: list[str] = []
    if stdout:
        decoded = stdout[:_MAX_SCRIPT_OUTPUT_BYTES].decode(errors="replace")
        if len(stdout) > _MAX_SCRIPT_OUTPUT_BYTES:
            decoded += f"\n[stdout truncated: {len(stdout)} bytes total, showing first {_MAX_SCRIPT_OUTPUT_BYTES}]"
        output_parts.append(decoded)
    if stderr:
        decoded = stderr[:_MAX_SCRIPT_OUTPUT_BYTES].decode(errors="replace")
        if len(stderr) > _MAX_SCRIPT_OUTPUT_BYTES:
            decoded += f"\n[stderr truncated: {len(stderr)} bytes total, showing first {_MAX_SCRIPT_OUTPUT_BYTES}]"
        output_parts.append(f"[stderr]\n{decoded}")
    if proc.returncode != 0:
        output_parts.append(f"[exit code: {proc.returncode}]")

    return "\n".join(output_parts) if output_parts else "(no output)"


class AgentSkillsConfig(FunctionBaseConfig, name="agent_skills"):
    """Configuration for the agent_skills function."""

    description: str = Field(
        default=_DEFAULT_DESCRIPTION,
        description="The description exposed to the tool-calling model.",
    )

    skills_directory: str = Field(
        default="/skills",
        description="Filesystem path to the root directory containing skill subdirectories.",
    )
    allow_script_execution: bool = Field(
        default=False,
        description=(
            "Whether to enable the run_skill_script dispatch operation. "
            "Disabled by default for security."
        ),
    )
    allowed_script_extensions: list[str] = Field(
        default_factory=lambda: [".py", ".sh"],
        description="File extensions permitted for script execution.",
    )
    script_timeout: int = Field(
        default=30,
        ge=1,
        le=300,
        description="Maximum seconds a skill script is allowed to run before being killed.",
    )
    enabled_operations: list[AgentSkillsOperation] | None = Field(
        default=None,
        description=(
            "Optional allow-list of dispatch operations. Supported values: "
            "list_skills, load_skill, run_skill_script. When omitted, all "
            "operations are accepted subject to allow_script_execution."
        ),
    )


class AgentSkillsInput(BaseModel):
    """Explicit LLM-facing schema for the unified skill dispatcher."""

    model_config = ConfigDict(extra="forbid")

    operation: AgentSkillsOperation = Field(
        default="list_skills",
        description=(
            "Use list_skills to discover matching skills, load_skill to read a "
            "selected skill's instructions or resource, or run_skill_script only "
            "when script execution is enabled."
        ),
    )
    query: str | None = Field(
        default=None,
        description="Optional keyword query used only by list_skills.",
    )
    skill_name: str = Field(
        default="",
        description=(
            "Skill name returned by list_skills; required by load_skill and "
            "run_skill_script."
        ),
    )
    resource: str | None = Field(
        default=None,
        description="Optional skill-relative resource path used only by load_skill.",
    )
    script: str = Field(
        default="",
        description="Skill-relative script path used only by run_skill_script.",
    )
    args: str | None = Field(
        default=None,
        description=(
            "Optional space-separated script arguments used only by "
            "run_skill_script."
        ),
    )


@register_function(config_type=AgentSkillsConfig)
async def agent_skills_function(config: AgentSkillsConfig, builder: Builder):
    parser = SkillParser(skills_directory=config.skills_directory)
    parser.discover_skills()

    enabled = set(config.enabled_operations or _ALL_OPERATIONS)

    async def agent_skills(
        operation: AgentSkillsOperation = "list_skills",
        query: str | None = None,
        skill_name: str = "",
        resource: str | None = None,
        script: str = "",
        args: str | None = None,
    ) -> str:
        """Discover or load a skill, or run an enabled bundled script.

        Loading a skill returns its instructions. Follow those instructions with the
        ordinary tools already exposed in the session; no separate skill execution
        tool is required.
        """
        op = (operation or "").strip()
        if op not in enabled:
            enabled_text = ", ".join(
                candidate for candidate in _ALL_OPERATIONS if candidate in enabled
            )
            return (
                f"Error: operation '{op}' is disabled. "
                f"Enabled operations: {enabled_text or '(none)'}."
            )

        if op == "list_skills":
            return await _list_skills(parser, query)

        normalized_skill_name = skill_name.strip()
        if not normalized_skill_name:
            return f"Error: skill_name is required for operation='{op}'."

        if op == "load_skill":
            return await _load_skill(parser, normalized_skill_name, resource)

        if not config.allow_script_execution:
            return "Error: skill script execution is disabled."
        if not script.strip():
            return "Error: script is required for operation='run_skill_script'."
        return await _run_skill_script(
            parser,
            config.allowed_script_extensions,
            config.script_timeout,
            normalized_skill_name,
            script.strip(),
            args,
        )

    try:
        yield FunctionInfo.from_fn(
            agent_skills,
            input_schema=AgentSkillsInput,
            description=config.description,
        )

    except GeneratorExit:
        logger.warning("agent_skills function exited early!")
    finally:
        logger.info("Cleaning up agent_skills function.")
