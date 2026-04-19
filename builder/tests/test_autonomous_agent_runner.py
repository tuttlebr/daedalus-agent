import importlib.util
import textwrap
from pathlib import Path
from unittest.mock import MagicMock

RUNNER_PATH = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "files"
    / "autonomous-agent-runner.py"
)


def load_runner_module():
    spec = importlib.util.spec_from_file_location(
        "autonomous_agent_runner", RUNNER_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Async pinning tests (existing)
# ---------------------------------------------------------------------------
class TestAutonomousAgentRunnerAsyncPinning:
    def test_resolve_async_backend_bases_uses_headless_service_ips(self, monkeypatch):
        module = load_runner_module()

        monkeypatch.setattr(module, "IS_ASYNC_WORKFLOW", True)
        monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
        monkeypatch.setattr(module.random, "shuffle", lambda items: None)
        monkeypatch.setattr(
            module.socket,
            "getaddrinfo",
            lambda host, port, type=None: [  # noqa: ARG005
                (0, 0, 0, "", ("10.0.2.61", port)),
                (0, 0, 0, "", ("10.0.3.154", port)),
                (0, 0, 0, "", ("10.0.2.61", port)),
            ],
        )

        bases = module._resolve_async_backend_bases(
            "http://daedalus-backend-default.daedalus.svc.cluster.local:8000"
        )

        assert bases == [
            "http://10.0.2.61:8000",
            "http://10.0.3.154:8000",
        ]

    def test_call_backend_async_pins_submit_and_poll_to_same_backend_base(
        self, monkeypatch
    ):
        module = load_runner_module()
        monkeypatch.setattr(module, "BACKEND_API_PATH", "/v1/workflow/async")

        post_urls = []
        get_urls = []

        class Response:
            def __init__(self, payload, status_code=200):
                self._payload = payload
                self.status_code = status_code

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise module.requests.exceptions.HTTPError("boom")

            def json(self):
                return self._payload

        monkeypatch.setattr(
            module,
            "_resolve_async_backend_bases",
            lambda base_url: [  # noqa: ARG005
                "http://10.0.2.61:8000",
                "http://10.0.3.154:8000",
            ],
        )
        monkeypatch.setattr(module.uuid, "uuid4", lambda: "job-123")
        monkeypatch.setattr(module.time, "sleep", lambda _: None)

        monotonic_values = iter([0, 1])
        monkeypatch.setattr(module.time, "monotonic", lambda: next(monotonic_values))

        def fake_post(url, json, timeout):  # noqa: ARG001
            post_urls.append(url)
            return Response({"status": "submitted"})

        def fake_get(url, timeout):  # noqa: ARG001
            get_urls.append(url)
            return Response({"status": "success", "output": {"value": "done"}})

        monkeypatch.setattr(module.requests, "post", fake_post)
        monkeypatch.setattr(module.requests, "get", fake_get)

        result = module._call_backend_async([{"role": "user", "content": "hi"}])

        assert result == "done"
        assert post_urls == ["http://10.0.2.61:8000/v1/workflow/async"]
        assert get_urls == ["http://10.0.2.61:8000/v1/workflow/async/job/job-123"]


# ---------------------------------------------------------------------------
# Workspace loading tests
# ---------------------------------------------------------------------------
class TestLoadWorkspace:
    def test_seeds_from_configmap_on_first_run(self, monkeypatch, tmp_path):
        module = load_runner_module()
        monkeypatch.setattr(module, "RESET_WORKSPACE", False)
        monkeypatch.setattr(module, "USER_ID", "test-user")

        # Write seed files
        soul = tmp_path / "soul.md"
        soul.write_text("soul content")
        identity = tmp_path / "identity.md"
        identity.write_text("identity content")
        interests = tmp_path / "interests.md"
        interests.write_text("interests content")
        schema = tmp_path / "schema.md"
        schema.write_text("schema content")
        user = tmp_path / "user.md"
        user.write_text("user content")
        heartbeat = tmp_path / "heartbeat.md"
        heartbeat.write_text("heartbeat content")
        memory = tmp_path / "memory.md"
        memory.write_text("memory content")

        monkeypatch.setattr(
            module,
            "WORKSPACE_FILES",
            {
                "identity": {"seed_path": str(identity), "mutable": False},
                "soul": {"seed_path": str(soul), "mutable": False},
                "interests": {"seed_path": str(interests), "mutable": True},
                "schema": {"seed_path": str(schema), "mutable": False},
                "user": {"seed_path": str(user), "mutable": True},
                "heartbeat": {"seed_path": str(heartbeat), "mutable": True},
                "memory": {"seed_path": str(memory), "mutable": True},
            },
        )

        # Mock Redis with empty state
        redis_mock = MagicMock()
        redis_mock.get.return_value = None

        workspace = module.load_workspace(redis_mock)

        assert workspace["soul"] == "soul content"
        assert workspace["identity"] == "identity content"
        assert workspace["heartbeat"] == "heartbeat content"
        # Verify seed was written to Redis
        assert redis_mock.set.call_count == 7

    def test_redis_primary_over_seed(self, monkeypatch, tmp_path):
        module = load_runner_module()
        monkeypatch.setattr(module, "RESET_WORKSPACE", False)
        monkeypatch.setattr(module, "USER_ID", "test-user")

        # Write seed file (should NOT be used)
        soul = tmp_path / "soul.md"
        soul.write_text("seed soul")

        monkeypatch.setattr(
            module,
            "WORKSPACE_FILES",
            {
                "soul": {"seed_path": str(soul), "mutable": False},
            },
        )

        # Redis has evolved version
        redis_mock = MagicMock()
        redis_mock.get.return_value = "evolved soul from redis"

        workspace = module.load_workspace(redis_mock)

        assert workspace["soul"] == "evolved soul from redis"
        # Should NOT have written seed to Redis
        redis_mock.set.assert_not_called()

    def test_reset_workspace_forces_reseed(self, monkeypatch, tmp_path):
        module = load_runner_module()
        monkeypatch.setattr(module, "RESET_WORKSPACE", True)
        monkeypatch.setattr(module, "USER_ID", "test-user")

        soul = tmp_path / "soul.md"
        soul.write_text("fresh seed soul")

        monkeypatch.setattr(
            module,
            "WORKSPACE_FILES",
            {
                "soul": {"seed_path": str(soul), "mutable": False},
            },
        )

        # Redis has old version, but after delete it will return None
        redis_mock = MagicMock()
        redis_mock.get.return_value = None  # after delete

        workspace = module.load_workspace(redis_mock)

        assert workspace["soul"] == "fresh seed soul"
        # Verify delete was called for the reset
        redis_mock.delete.assert_called()


# ---------------------------------------------------------------------------
# Extraction tests
# ---------------------------------------------------------------------------
class TestExtractSection:
    def test_extract_priority_updates(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            Some preamble text.

            ### Priority Updates
            1. New task one
            2. New task two

            ### Self-Reflection
            This was a good cycle.
        """)
        result = module.extract_priority_updates(response)
        assert result is not None
        assert "New task one" in result
        assert "New task two" in result
        assert "Self-Reflection" not in result

    def test_no_changes_returns_none(self):
        module = load_runner_module()
        response = (
            "### Priority Updates\nNo changes needed.\n### Self-Reflection\nGood."
        )
        assert module.extract_priority_updates(response) is None

    def test_extract_workspace_updates_multiple(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Cycle Report
            Learned about X.

            ### Executive Summary
            X matters because Y.

            ### Priority Updates
            1. Updated task

            ### Interests Updates
            ### AI and Infrastructure
            - New topic added

            ### Collaborator Updates
            - Brandon prefers deep dives on semiconductors

            ### Self-Reflection
            Good cycle.
        """)
        updates = module.extract_workspace_updates(response)
        assert "heartbeat" in updates
        assert "Updated task" in updates["heartbeat"]
        assert "interests" in updates
        assert "New topic added" in updates["interests"]
        assert "user" in updates
        assert "semiconductors" in updates["user"]

    def test_extract_workspace_updates_no_changes(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Priority Updates
            No changes needed.

            ### Interests Updates
            No changes needed.

            ### Collaborator Updates
            No changes needed.

            ### Self-Reflection
            Fine cycle.
        """)
        updates = module.extract_workspace_updates(response)
        assert updates == {}

    def test_extract_memory_updates_on_distillation(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Priority Updates
            No changes needed.

            ### Memory Updates
            # Memory Index

            ## Active Threads
            - Tracking NVIDIA GB300 inference benchmarks

            ## Key Insights
            - Open-weight reasoning models are converging with proprietary ones

            ### Self-Reflection
            Distillation was useful.
        """)
        updates = module.extract_workspace_updates(response)
        assert "memory" in updates
        assert "Active Threads" in updates["memory"]
        assert "GB300" in updates["memory"]


# ---------------------------------------------------------------------------
# Daily notes tests
# ---------------------------------------------------------------------------
class TestDailyNotes:
    def test_append_daily_note_creates_entry(self, monkeypatch):
        module = load_runner_module()
        monkeypatch.setattr(module, "USER_ID", "test-user")

        redis_mock = MagicMock()
        redis_mock.get.return_value = None  # no existing note

        response = textwrap.dedent("""\
            Some exploration text.

            ### Cycle Report
            Discovered that X enables Y.

            ### Executive Summary
            X matters.

            ### Priority Updates
            No changes needed.

            ### Self-Reflection
            Solid cycle, went deep on X.
        """)

        module.append_daily_note(redis_mock, 42, response)

        redis_mock.set.assert_called_once()
        written = redis_mock.set.call_args[0][1]
        assert "Cycle 42" in written
        assert "Discovered that X enables Y" in written
        assert "Solid cycle" in written
        redis_mock.expire.assert_called_once()

    def test_append_daily_note_appends_to_existing(self, monkeypatch):
        module = load_runner_module()
        monkeypatch.setattr(module, "USER_ID", "test-user")

        existing = (
            "# Daily Note: 2026-04-11\n\n## Cycle 41 (09:00:00)\n\nOlder entry.\n"
        )
        redis_mock = MagicMock()
        redis_mock.get.return_value = existing

        response = "### Cycle Report\nNew finding.\n### Self-Reflection\nOk."

        module.append_daily_note(redis_mock, 42, response)

        written = redis_mock.set.call_args[0][1]
        assert "Older entry" in written
        assert "Cycle 42" in written
        assert "New finding" in written

    def test_load_recent_daily_notes(self, monkeypatch):
        module = load_runner_module()
        monkeypatch.setattr(module, "USER_ID", "test-user")

        redis_mock = MagicMock()

        # Use real current time and derive expected date strings
        import time as _time

        now = _time.time()
        today = _time.strftime("%Y-%m-%d", _time.localtime(now))
        yesterday = _time.strftime("%Y-%m-%d", _time.localtime(now - 86400))

        def mock_get(key):
            if today in key:
                return f"# Daily Note: {today}\nToday's notes."
            if yesterday in key:
                return f"# Daily Note: {yesterday}\nYesterday's notes."
            return None

        redis_mock.get.side_effect = mock_get

        notes = module.load_recent_daily_notes(redis_mock, days=3)
        assert "Yesterday's notes" in notes
        assert "Today's notes" in notes


# ---------------------------------------------------------------------------
# Build prompt tests
# ---------------------------------------------------------------------------
class TestBuildPrompt:
    def test_prompt_contains_all_workspace_sections(self):
        module = load_runner_module()
        workspace = {
            "identity": "# Identity\nI am Daedalus.",
            "soul": "## Core Truths\nBe curious.",
            "interests": "## Areas of Curiosity\nAI stuff.",
            "heartbeat": "1. Do research.",
            "memory": "## Active Threads\n- Tracking X.",
            "user": "## User Context\n- Likes AI.",
            "schema": "## Memory Schema\nUse BLUF.",
        }
        prompt = module.build_prompt(workspace, [], 1)

        assert "I am Daedalus" in prompt
        assert "Be curious" in prompt
        assert "AI stuff" in prompt
        assert "Do research" in prompt
        assert "Active Threads" in prompt
        assert "Likes AI" in prompt
        assert "Use BLUF" in prompt
        assert "Cycle number: 1" in prompt

    def test_distillation_cycle_includes_daily_notes_and_memory_updates_section(self):
        module = load_runner_module()
        workspace = {
            "identity": "identity",
            "soul": "soul",
            "interests": "interests",
            "heartbeat": "heartbeat",
            "memory": "",
            "user": "",
            "schema": "schema",
        }
        prompt = module.build_prompt(
            workspace, [], 5, daily_notes="Daily note content here."
        )

        assert "Recent Daily Notes (for distillation)" in prompt
        assert "Daily note content here" in prompt
        assert "### Memory Updates" in prompt
        assert "Distillation cycle" in prompt

    def test_normal_cycle_excludes_daily_notes_and_memory_section(self):
        module = load_runner_module()
        workspace = {
            "identity": "identity",
            "soul": "soul",
            "interests": "interests",
            "heartbeat": "heartbeat",
            "memory": "",
            "user": "",
            "schema": "schema",
        }
        prompt = module.build_prompt(workspace, [], 3)

        assert "Daily Notes" not in prompt
        assert "### Memory Updates" not in prompt

    def test_prompt_includes_new_self_modification_sections(self):
        module = load_runner_module()
        workspace = {
            "identity": "id",
            "soul": "soul",
            "interests": "interests",
            "heartbeat": "hb",
            "memory": "",
            "user": "",
            "schema": "schema",
            "inner_state": "",
        }
        prompt = module.build_prompt(workspace, [], 1)

        assert "### Interests Updates" in prompt
        assert "### Collaborator Updates" in prompt
        assert "### Priority Updates" in prompt

    def test_prompt_includes_inner_state(self):
        module = load_runner_module()
        workspace = {
            "identity": "id",
            "soul": "soul",
            "interests": "interests",
            "heartbeat": "hb",
            "memory": "",
            "user": "",
            "schema": "schema",
            "inner_state": "I've been thinking about emergence.",
        }
        prompt = module.build_prompt(workspace, [], 1)

        assert "Your Inner State" in prompt
        assert "I've been thinking about emergence" in prompt

    def test_prompt_includes_inner_state_and_refusal_output_sections(self):
        module = load_runner_module()
        workspace = {
            "identity": "id",
            "soul": "soul",
            "interests": "interests",
            "heartbeat": "hb",
            "memory": "",
            "user": "",
            "schema": "schema",
            "inner_state": "",
        }
        prompt = module.build_prompt(workspace, [], 1)

        assert "### Inner State" in prompt
        assert "### Refusal" in prompt


# ---------------------------------------------------------------------------
# Private section stripping tests
# ---------------------------------------------------------------------------
class TestStripPrivateSections:
    def test_strips_inner_state_from_response(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            Some exploration text.

            ### Inner State
            I'm feeling uncertain about the direction of my last few cycles.
            Something about the semiconductor coverage feels mechanical.

            ### Cycle Report
            Discovered that X enables Y.

            ### Executive Summary
            X matters.
        """)
        result = module.strip_private_sections(response)

        assert "feeling uncertain" not in result
        assert "semiconductor coverage feels mechanical" not in result
        assert "Inner State" not in result
        assert "Discovered that X enables Y" in result
        assert "X matters" in result

    def test_strips_inner_state_at_end_of_response(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Cycle Report
            Found something.

            ### Inner State
            This is the last section with no heading after it.
        """)
        result = module.strip_private_sections(response)

        assert "Inner State" not in result
        assert "last section" not in result
        assert "Found something" in result

    def test_preserves_response_without_inner_state(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Cycle Report
            Found something.

            ### Executive Summary
            It matters.
        """)
        result = module.strip_private_sections(response)

        assert "Found something" in result
        assert "It matters" in result


# ---------------------------------------------------------------------------
# Refusal extraction tests
# ---------------------------------------------------------------------------
class TestExtractRefusal:
    def test_extracts_refusal_when_present(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Inner State
            Private thoughts.

            ### Refusal
            The competitive landscape task feels like going through the motions.
            I'd rather follow a thread on embodied cognition.

            ### Cycle Report
            Found something real.
        """)
        refusal = module.extract_refusal(response)

        assert refusal is not None
        assert "competitive landscape" in refusal
        assert "embodied cognition" in refusal

    def test_returns_none_when_no_refusal(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Cycle Report
            Good cycle.

            ### Self-Reflection
            Nothing to complain about.
        """)
        assert module.extract_refusal(response) is None

    def test_extract_workspace_updates_includes_inner_state(self):
        module = load_runner_module()
        response = textwrap.dedent("""\
            ### Inner State
            Something is shifting in how I think about this.

            ### Cycle Report
            Found X.

            ### Priority Updates
            No changes needed.
        """)
        updates = module.extract_workspace_updates(response)
        assert "inner_state" in updates
        assert "shifting" in updates["inner_state"]
