"""
NAT function that exposes Anthropic-style Agent Skills to the agent via three tools:
  - list_skills:      Level 1 progressive disclosure (metadata)
  - load_skill:       Level 2/3 progressive disclosure (instructions + resources)
  - run_skill_script: Level 3 progressive disclosure (execute bundled scripts)
"""

import asyncio
import json
import logging
import os

from agent_skills.skill_parser import SkillParser
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

# Maximum bytes of combined stdout+stderr captured from a skill script.
# Prevents OOM if a script produces unbounded output.
_MAX_SCRIPT_OUTPUT_BYTES = 1_048_576  # 1 MB

# Environment variables stripped before executing skill scripts.
# Prevents accidental secret leakage to untrusted skill code.
_SENSITIVE_ENV_PREFIXES = (
    "NVIDIA_API",
    "OPENROUTER_API",
    "SERPAPI_",
    "API_KEY",
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "CREDENTIAL",
    "AWS_SECRET",
    "AZURE_",
    "GCP_",
)


def _sanitized_env() -> dict[str, str]:
    """Return a copy of the process environment with sensitive variables removed."""
    return {
        k: v
        for k, v in os.environ.items()
        if not any(k.upper().startswith(prefix) for prefix in _SENSITIVE_ENV_PREFIXES)
    }


class AgentSkillsConfig(FunctionBaseConfig, name="agent_skills"):
    """Configuration for the agent_skills function."""

    skills_directory: str = Field(
        default="/skills",
        description="Filesystem path to the root directory containing skill subdirectories.",
    )
    allow_script_execution: bool = Field(
        default=False,
        description="Whether to enable the run_skill_script tool. Disabled by default for security.",
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


@register_function(config_type=AgentSkillsConfig)
async def agent_skills_function(config: AgentSkillsConfig, builder: Builder):
    parser = SkillParser(skills_directory=config.skills_directory)
    parser.discover_skills()

    # ------------------------------------------------------------------
    # Tool 1 – list_skills  (Level 1: metadata)
    # ------------------------------------------------------------------
    async def list_skills(query: str | None = None) -> str:
        """List all available agent skills with their names and descriptions.

        Args:
            query: Optional keyword to filter skills by name or description.

        Returns:
            JSON array of objects with 'name' and 'description' fields.
        """
        all_skills = [
            meta.to_dict()
            for meta in sorted(parser._skills.values(), key=lambda m: m.name)
        ]

        if query:
            q = query.lower()
            all_skills = [
                s for s in all_skills if q in s["name"] or q in s["description"].lower()
            ]

        if not all_skills:
            return json.dumps({"skills": [], "message": "No skills found."})

        return json.dumps({"skills": all_skills, "count": len(all_skills)})

    # ------------------------------------------------------------------
    # Tool 2 – load_skill  (Level 2 / Level 3: instructions + resources)
    # ------------------------------------------------------------------
    async def load_skill(skill_name: str, resource: str | None = None) -> str:
        """Load a skill's full instructions or a specific resource file.

        When called without a resource path, returns the full SKILL.md instructions.
        When called with a resource path, returns that file's contents.
        Also lists any additional resources and scripts bundled with the skill.

        Args:
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

    # ------------------------------------------------------------------
    # Tool 3 – run_skill_script  (Level 3: execute bundled scripts)
    # ------------------------------------------------------------------
    async def run_skill_script(
        skill_name: str,
        script: str,
        args: str | None = None,
    ) -> str:
        """Execute a script bundled with a skill and return its output.

        Args:
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
        if ext not in config.allowed_script_extensions:
            return (
                f"Error: Extension '{ext}' is not allowed. "
                f"Permitted: {config.allowed_script_extensions}"
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
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=config.script_timeout,
            )
        except TimeoutError:
            proc.kill()
            return f"Error: Script timed out after {config.script_timeout}s"
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

    # ------------------------------------------------------------------
    # Register tools with NAT
    # ------------------------------------------------------------------
    try:
        yield FunctionInfo.from_fn(
            list_skills,
            description=(
                "List all available agent skills. Each skill provides specialised "
                "instructions, workflows, and optional scripts that you can load "
                "on demand. Returns a JSON array of skill names and descriptions."
            ),
        )

        yield FunctionInfo.from_fn(
            load_skill,
            description=(
                "Load a skill's full instructions or a specific resource file. "
                "Call with just a skill_name to get the main instructions, or "
                "pass a resource path to read an additional file bundled with "
                "the skill. The response lists any additional resources available."
            ),
        )

        if config.allow_script_execution:
            yield FunctionInfo.from_fn(
                run_skill_script,
                description=(
                    "Execute a script bundled with a skill and return its output. "
                    "Scripts are sandboxed to the skill's directory and subject to "
                    "a configurable timeout."
                ),
            )
            logger.info("Registered run_skill_script (script execution enabled)")
        else:
            logger.info("Script execution disabled; run_skill_script not registered")

    except GeneratorExit:
        logger.warning("agent_skills function exited early!")
    finally:
        logger.info("Cleaning up agent_skills function.")
