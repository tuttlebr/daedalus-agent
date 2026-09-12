"""Tests for the agent_skills dispatcher and script-execution safety."""

import asyncio
from unittest.mock import MagicMock


def run(coro):
    return asyncio.run(coro)


def _write_skill(root):
    skill = root / "safe-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: safe-skill\ndescription: Safe test skill\n---\n\nUse safely.\n",
        encoding="utf-8",
    )
    (skill / "script.py").write_text("print('unsafe')\n", encoding="utf-8")


def test_skill_operations_use_one_explicit_dispatch_schema(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            AgentSkillsInput,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                allow_script_execution=False,
            ),
            MagicMock(),
        ):
            items.append(item)
        return items, AgentSkillsInput

    items, input_schema = run(_run())

    assert [item.fn.__name__ for item in items] == ["agent_skills"]
    assert items[0].input_schema is input_schema
    operation_schema = input_schema.model_json_schema()["properties"]["operation"]
    assert operation_schema["enum"] == [
        "list_skills",
        "load_skill",
        "run_skill_script",
    ]


def test_dispatch_exposes_the_configured_routing_description(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                description="Load daily-summary before any other daily-summary tool.",
            ),
            MagicMock(),
        ):
            items.append(item)
        return items

    items = run(_run())

    assert items[0].description == (
        "Load daily-summary before any other daily-summary tool."
    )


def test_dispatch_denies_script_execution_when_disabled(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                allow_script_execution=False,
            ),
            MagicMock(),
        ):
            items.append(item)
        result = await items[0].fn(
            operation="run_skill_script",
            skill_name="safe-skill",
            script="script.py",
        )
        return items, result

    items, result = run(_run())

    assert [item.fn.__name__ for item in items] == ["agent_skills"]
    assert result == "Error: skill script execution is disabled."


def test_dispatch_runs_script_only_when_enabled(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                allow_script_execution=True,
            ),
            MagicMock(),
        ):
            items.append(item)
        return await items[0].fn(
            operation="run_skill_script",
            skill_name="safe-skill",
            script="script.py",
        )

    assert run(_run()) == "unsafe\n"


def test_dispatch_lists_then_loads_skill_instructions(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                allow_script_execution=False,
            ),
            MagicMock(),
        ):
            items.append(item)
        listed = await items[0].fn(operation="list_skills", query="safe")
        loaded = await items[0].fn(
            operation="load_skill",
            skill_name="safe-skill",
        )
        return listed, loaded

    listed, loaded = run(_run())

    assert '"name": "safe-skill"' in listed
    assert loaded.startswith("Use safely.")


def test_sanitized_env_is_allowlist(monkeypatch):
    # F-002 regression: secrets must never reach skill scripts regardless of
    # naming convention. _sanitized_env is an allowlist, so only known-safe
    # names survive and every secret-shaped var is dropped.
    from agent_skills.agent_skills_function import _sanitized_env

    secrets = (
        "DAEDALUS_INTERNAL_API_TOKEN",
        "TOOL_CALLING_LLM_MODEL_API_KEY",
        "MINIO_SECRET_KEY",
        "MINIO_ACCESS_KEY",
        "REDIS_URL",
        "GITHUB_PAT",
        "MILVUS_PASSWORD",
        "NVIDIA_API_KEY",
    )
    for name in secrets:
        monkeypatch.setenv(name, "leak-me")
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("HOME", "/home/agent")

    env = _sanitized_env()

    assert env.get("PATH") == "/usr/bin"
    assert env.get("HOME") == "/home/agent"
    for name in secrets:
        assert name not in env


# ----------------------------------------------------------------------
# F-021: the operations are now module-level helpers, so we can exercise
# run_skill_script directly (timeout, truncation, env allowlist) with a
# real tiny script in a temp skills dir.
# ----------------------------------------------------------------------
def _skill_with_script(root, script_name, body):
    """Create a discovered skill containing an executable script and return its parser."""
    from agent_skills.skill_parser import SkillParser

    skill = root / "runner-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: runner-skill\ndescription: Script runner skill\n---\n\nRun stuff.\n",
        encoding="utf-8",
    )
    (skill / script_name).write_text(body, encoding="utf-8")

    parser = SkillParser(skills_directory=str(root))
    parser.discover_skills()
    return parser


def test_run_skill_script_returns_stdout(tmp_path):
    from agent_skills.agent_skills_function import _run_skill_script

    parser = _skill_with_script(tmp_path, "hello.py", "print('hello world')\n")

    out = run(_run_skill_script(parser, [".py", ".sh"], 30, "runner-skill", "hello.py"))

    assert "hello world" in out


def test_run_skill_script_timeout(tmp_path):
    from agent_skills.agent_skills_function import _run_skill_script

    parser = _skill_with_script(tmp_path, "slow.py", "import time\ntime.sleep(10)\n")

    # 1s timeout against a 10s sleep — must report the timeout, not hang.
    out = run(_run_skill_script(parser, [".py", ".sh"], 1, "runner-skill", "slow.py"))

    assert "timed out after 1s" in out


def test_run_skill_script_truncates_stdout(tmp_path, monkeypatch):
    import agent_skills.agent_skills_function as mod
    from agent_skills.agent_skills_function import _run_skill_script

    # Shrink the cap so the test stays fast while still exercising truncation.
    monkeypatch.setattr(mod, "_MAX_SCRIPT_OUTPUT_BYTES", 16)

    parser = _skill_with_script(
        tmp_path, "loud.py", "import sys\nsys.stdout.write('A' * 100)\n"
    )

    out = run(_run_skill_script(parser, [".py", ".sh"], 30, "runner-skill", "loud.py"))

    assert "Script output limit exceeded (16 bytes combined)" in out
    # Only the first 16 bytes of payload survive (plus the truncation notice).
    assert out.count("A") == 16


def test_run_skill_script_truncates_stderr(tmp_path, monkeypatch):
    import agent_skills.agent_skills_function as mod
    from agent_skills.agent_skills_function import _run_skill_script

    monkeypatch.setattr(mod, "_MAX_SCRIPT_OUTPUT_BYTES", 16)

    parser = _skill_with_script(
        tmp_path, "err.py", "import sys\nsys.stderr.write('B' * 100)\n"
    )

    out = run(_run_skill_script(parser, [".py", ".sh"], 30, "runner-skill", "err.py"))

    assert "[stderr]" in out
    assert "Script output limit exceeded (16 bytes combined)" in out


def test_run_skill_script_extension_not_allowed(tmp_path):
    from agent_skills.agent_skills_function import _run_skill_script

    parser = _skill_with_script(tmp_path, "data.txt", "not a script\n")

    out = run(_run_skill_script(parser, [".py", ".sh"], 30, "runner-skill", "data.txt"))

    assert "Extension '.txt' is not allowed" in out


def test_run_skill_script_env_allowlist_strips_secrets(tmp_path, monkeypatch):
    # The running script can only see allowlisted env vars; injected secrets
    # must not be visible in its environment.
    from agent_skills.agent_skills_function import _run_skill_script

    monkeypatch.setenv("NVIDIA_API_KEY", "leak-me")
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "leak-me-too")

    body = (
        "import os\n"
        "print('NVIDIA_API_KEY' in os.environ)\n"
        "print('DAEDALUS_INTERNAL_API_TOKEN' in os.environ)\n"
    )
    parser = _skill_with_script(tmp_path, "env.py", body)

    out = run(_run_skill_script(parser, [".py", ".sh"], 30, "runner-skill", "env.py"))

    assert "True" not in out
    assert out.count("False") == 2


def test_list_skills_helper_filters(tmp_path):
    from agent_skills.agent_skills_function import _list_skills
    from agent_skills.skill_parser import SkillParser

    _write_skill(tmp_path)
    parser = SkillParser(skills_directory=str(tmp_path))
    parser.discover_skills()

    import json

    all_out = json.loads(run(_list_skills(parser)))
    assert all_out["count"] == 1

    miss = json.loads(run(_list_skills(parser, "nonexistent")))
    assert miss["skills"] == []


def test_load_skill_helper_not_found(tmp_path):
    from agent_skills.agent_skills_function import _load_skill
    from agent_skills.skill_parser import SkillParser

    _write_skill(tmp_path)
    parser = SkillParser(skills_directory=str(tmp_path))
    parser.discover_skills()

    out = run(_load_skill(parser, "missing-skill"))
    assert "not found" in out


def test_explicit_empty_operation_list_disables_all_operations(tmp_path):
    async def scenario():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        async for info in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                enabled_operations=[],
                allow_script_execution=True,
            ),
            MagicMock(),
        ):
            for operation in ("list_skills", "load_skill", "run_skill_script"):
                result = await info.fn(
                    operation=operation, skill_name="safe-skill", script="script.py"
                )
                assert "disabled" in result

    run(scenario())


def test_cancelling_script_kills_parent_and_descendant(tmp_path):
    import os
    from pathlib import Path

    import pytest
    from agent_skills.agent_skills_function import _run_skill_script

    marker = tmp_path / "pids"
    body = (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        f"open({str(marker)!r}, 'w').write(str(os.getpid()) + ' ' + str(child.pid))\n"
        "time.sleep(30)\n"
    )
    parser = _skill_with_script(tmp_path, "parent.py", body)

    def live(pid):
        path = Path(f"/proc/{pid}/stat")
        return path.exists() and path.read_text().split()[2] != "Z"

    async def scenario():
        task = asyncio.create_task(
            _run_skill_script(parser, [".py"], 30, "runner-skill", "parent.py")
        )
        try:
            async with asyncio.timeout(3):
                while not marker.exists():
                    await asyncio.sleep(0.01)
            pids = [int(value) for value in marker.read_text().split()]
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            async with asyncio.timeout(2):
                while any(live(pid) for pid in pids):
                    await asyncio.sleep(0.01)
        finally:
            if marker.exists():
                for pid in map(int, marker.read_text().split()):
                    try:
                        os.kill(pid, 9)
                    except ProcessLookupError:
                        pass

    run(scenario())


def test_unbounded_output_is_stopped_before_script_finishes(tmp_path, monkeypatch):
    import agent_skills.agent_skills_function as mod

    monkeypatch.setattr(mod, "_MAX_SCRIPT_OUTPUT_BYTES", 1024)
    completed = tmp_path / "completed"
    body = (
        "import sys, time\nwhile True:\n sys.stdout.write('x'*65536)\n sys.stdout.flush()\n"
        f"open({str(completed)!r}, 'w').write('done')\n"
    )
    parser = _skill_with_script(tmp_path, "noisy.py", body)
    out = run(mod._run_skill_script(parser, [".py"], 3, "runner-skill", "noisy.py"))
    assert "output limit exceeded" in out
    assert len(out) < 1400
    assert not completed.exists()
