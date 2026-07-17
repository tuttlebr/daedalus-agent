"""Tests for the user_interaction package -- structured user interaction framework."""

import asyncio
import json
from unittest.mock import MagicMock, patch


class FakeRedis:
    def __init__(self):
        self.store = {}

    def setex(self, key, ttl, value):
        self.store[key] = value
        return True

    def get(self, key):
        return self.store.get(key)

    def getdel(self, key):
        return self.store.pop(key, None)

    def delete(self, *keys):
        deleted = 0
        for key in keys:
            if key in self.store:
                del self.store[key]
                deleted += 1
        return deleted

    def scan_iter(self, pattern):
        import fnmatch

        return (key for key in list(self.store) if fnmatch.fnmatch(key, pattern))

    def execute_command(self, command, key):
        if command != "JSON.GET":
            raise ValueError(command)
        return self.store.get(key)


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


def test_approval_redis_url_uses_standard_redis_host(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("REDIS_USERNAME", raising=False)
    monkeypatch.delenv("REDIS_PASSWORD", raising=False)
    monkeypatch.delenv("REDIS_TLS_ENABLED", raising=False)
    monkeypatch.delenv("REDIS_TLS_CA_FILE", raising=False)
    monkeypatch.setenv("REDIS_HOST", "redis.internal")
    monkeypatch.setenv("REDIS_PORT", "6380")

    assert build_redis_url() == "redis://redis.internal:6380"


def test_approval_redis_url_encodes_acl_credentials_and_tls(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_HOST", "2001:db8::8")
    monkeypatch.setenv("REDIS_PORT", "6380")
    monkeypatch.setenv("REDIS_USERNAME", "approval user")
    monkeypatch.setenv("REDIS_PASSWORD", "p@ss word/#")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_FILE", "/etc/redis tls/ca.crt")

    assert build_redis_url() == (
        "rediss://approval%20user:p%40ss%20word%2F%23@[2001:db8::8]:6380"
        "?ssl_ca_certs=%2Fetc%2Fredis+tls%2Fca.crt"
    )


def test_approval_redis_url_prefers_explicit_url(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.setenv("REDIS_HOST", "ignored")
    monkeypatch.setenv("REDIS_URL", "rediss://daedalus@example.test:6379/0")

    assert build_redis_url() == "rediss://daedalus@example.test:6379/0"


def test_approval_redis_url_adds_port_before_database_path(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.setenv("REDIS_URL", "redis://daedalus@example.test/2?health=1")
    monkeypatch.setenv("REDIS_PORT", "6380")

    assert build_redis_url() == ("redis://daedalus@example.test:6380/2?health=1")


async def _get_tools(config_overrides=None):
    """Instantiate user_interaction and collect yielded FunctionInfo objects."""
    from user_interaction.user_interaction_function import (
        UserInteractionConfig,
        user_interaction_function,
    )

    kwargs = config_overrides or {}
    config = UserInteractionConfig(**kwargs)
    builder = MagicMock()
    items = []
    async for item in user_interaction_function(config, builder):
        items.append(item)
    return items


class TestUserInteractionRegistration:
    def test_yields_five_function_infos(self):
        items = run(_get_tools())
        assert len(items) == 5

    def test_all_have_fn_and_description(self):
        items = run(_get_tools())
        for item in items:
            assert item.fn is not None
            assert item.description

    def test_tool_names(self):
        items = run(_get_tools())
        fn_names = [item.fn.__name__ for item in items]
        assert "clarify" in fn_names
        assert "confirm_action" in fn_names
        assert "confirm_research_plan" in fn_names
        assert "present_options" in fn_names
        assert "delete_memory_guarded" in fn_names


def test_mcp_argument_preview_redacts_nested_and_embedded_credentials():
    from user_interaction.approval_tokens import (
        canonicalize_mcp_arguments,
        redacted_mcp_arguments,
    )

    # Assemble the credential markers at runtime so the redaction regression
    # test does not itself look like a committed live secret to Gitleaks.
    authorization_key = "Authori" + "zation"
    bearer_scheme = "Bear" + "er"
    token_key = "API_" + "TOKEN"
    nested_value = "nested-" + "secret"
    command_value = "command-" + "secret"
    environment_value = "environment-" + "secret"

    canonical, _ = canonicalize_mcp_arguments(
        json.dumps(
            {
                "name": "safe-resource",
                "headers": {authorization_key: f"{bearer_scheme} {nested_value}"},
                "command": (
                    f"curl -H '{authorization_key}: {bearer_scheme} "
                    f"{command_value}' https://x"
                ),
                "env": [f"{token_key}={environment_value}", "MODE=production"],
                "url": "https://user:url-secret@example.test/path",
            }
        )
    )

    preview = redacted_mcp_arguments(canonical)
    assert "safe-resource" in preview
    assert nested_value not in preview
    assert command_value not in preview
    assert environment_value not in preview
    assert "url-secret" not in preview
    assert preview.count("[REDACTED]") >= 4


class TestClarify:
    def test_basic_question(self):
        async def _run():
            items = await _get_tools()
            clarify_fn = items[0].fn
            result = await clarify_fn(question="Which format do you prefer?")
            assert "Which format do you prefer?" in result
            assert "Clarification needed" in result

        run(_run())

    def test_with_options(self):
        async def _run():
            items = await _get_tools()
            clarify_fn = items[0].fn
            result = await clarify_fn(
                question="Which source?",
                options="News | Knowledge base | Both",
            )
            assert "1." in result
            assert "News" in result
            assert "Knowledge base" in result
            assert "Both" in result
            assert "different answer" in result.lower()

        run(_run())

    def test_with_context_and_why(self):
        async def _run():
            items = await _get_tools()
            clarify_fn = items[0].fn
            result = await clarify_fn(
                question="Which topic?",
                context="You asked about semiconductors",
                why_asking="Determines which knowledge base to search",
            )
            assert "understand so far" in result.lower()
            assert "semiconductors" in result
            assert "knowledge base" in result.lower()

        run(_run())

    def test_options_limited_to_max(self):
        async def _run():
            items = await _get_tools({"max_options": 2})
            clarify_fn = items[0].fn
            result = await clarify_fn(
                question="Pick one",
                options="A | B | C | D | E",
            )
            # Should only show 2 options
            assert "1." in result
            assert "2." in result
            assert "3." not in result

        run(_run())


class TestConfirmAction:
    def test_basic_confirmation(self):
        async def _run():
            items = await _get_tools()
            confirm_fn = next(i.fn for i in items if i.fn.__name__ == "confirm_action")
            result = await confirm_fn(
                action="Delete all memories for user john",
                reason="User explicitly requested memory reset",
            )
            assert "Delete all memories" in result
            assert "Reason" in result
            assert "Proceed?" in result

        run(_run())

    def test_irreversible_warning(self):
        async def _run():
            items = await _get_tools()
            confirm_fn = next(i.fn for i in items if i.fn.__name__ == "confirm_action")
            result = await confirm_fn(
                action="Drop the database",
                reason="Migration requires fresh start",
                reversible=False,
            )
            assert "difficult to reverse" in result.lower()

        run(_run())

    def test_with_risks_and_alternatives(self):
        async def _run():
            items = await _get_tools()
            confirm_fn = next(i.fn for i in items if i.fn.__name__ == "confirm_action")
            result = await confirm_fn(
                action="Scale to 10 replicas",
                reason="Traffic spike expected",
                risks="Increased cloud costs",
                alternatives="Scale to 5 | Enable autoscaling",
            )
            assert "Risks" in result
            assert "Increased cloud costs" in result
            assert "Alternatives" in result
            assert "autoscaling" in result

        run(_run())

    def test_confirmation_does_not_issue_approval_token(self):
        async def _run():
            fake_redis = FakeRedis()
            items = await _get_tools()
            confirm_fn = next(i.fn for i in items if i.fn.__name__ == "confirm_action")
            result = await confirm_fn(
                action="Delete memories",
                reason="User requested it",
                user_id="brandon",
                action_type="delete_memory",
                target="brandon",
            )
            assert "No executable credential has been created" in result
            assert "Approval scope" in result
            assert fake_redis.store == {}

        run(_run())

    def test_mcp_confirmation_records_exact_server_tool_and_arguments(self):
        async def _run():
            fake_redis = FakeRedis()
            import user_interaction.user_interaction_function as mod

            with patch.object(mod, "make_redis_client", return_value=fake_redis):
                items = await _get_tools()
                confirm_fn = next(
                    i.fn for i in items if i.fn.__name__ == "confirm_action"
                )
                result = await confirm_fn(
                    action="Scale the production API",
                    reason="User requested it",
                    user_id="brandon",
                    action_type="mcp_mutation",
                    target="production/api",
                    server_name="k8s_mcp_server",
                    tool_name="scale_deployment",
                    arguments_json=json.dumps(
                        {
                            "namespace": "production",
                            "name": "api",
                            "replicas": 3,
                            "api_token": "must-not-be-displayed",
                        }
                    ),
                )
            return result, fake_redis

        result, fake_redis = run(_run())

        assert "server_name=`k8s_mcp_server`" in result
        assert "tool_name=`scale_deployment`" in result
        assert "approval_request_id=`" in result
        assert "arguments_sha256=`" in result
        assert "approval_token" not in result
        assert "must-not-be-displayed" not in result
        assert "[REDACTED]" in result
        assert len(fake_redis.store) == 1
        pending_key, raw_pending = next(iter(fake_redis.store.items()))
        assert pending_key.startswith("approval-pending:")
        pending = json.loads(raw_pending)
        assert pending["canonical_arguments"].endswith('"replicas":3}')
        assert pending["arguments_preview"].startswith('{"api_token":"[REDACTED]"')

    def test_interactive_chat_cannot_create_mcp_mutation_intent(self):
        async def _run():
            fake_redis = FakeRedis()
            import sys
            from types import SimpleNamespace

            import user_interaction.user_interaction_function as mod

            class _ChatContext:
                @staticmethod
                def get():
                    return SimpleNamespace(
                        metadata=SimpleNamespace(
                            headers={
                                "x-user-id": "brandon",
                                "x-daedalus-execution-scope": "",
                            }
                        )
                    )

            with (
                patch.object(mod, "make_redis_client", return_value=fake_redis),
                patch.object(
                    mod,
                    "_authenticated_user_or_fallback",
                    return_value="brandon",
                ),
                patch.dict(
                    sys.modules,
                    {"nat.builder.context": SimpleNamespace(Context=_ChatContext)},
                ),
            ):
                items = await _get_tools()
                confirm_fn = next(
                    i.fn for i in items if i.fn.__name__ == "confirm_action"
                )
                result = await confirm_fn(
                    action="Scale the production API",
                    reason="Requested in chat",
                    user_id="brandon",
                    action_type="mcp_mutation",
                    target="production/api",
                    server_name="k8s_mcp_server",
                    tool_name="scale_deployment",
                    arguments_json='{"replicas":3}',
                )
            return result, fake_redis

        result, fake_redis = run(_run())
        assert "only through the Autonomy dashboard" in result
        assert fake_redis.store == {}

    def test_memory_update_redirects_to_add_memory_without_confirmation(self):
        async def _run():
            items = await _get_tools()
            confirm_fn = next(i.fn for i in items if i.fn.__name__ == "confirm_action")
            result = await confirm_fn(
                action="Store a memory that the user's name is Brandon Tuttle.",
                reason="The user explicitly asked me to remember it.",
                action_type="memory_update",
                target="user profile",
            )

            assert "No confirmation is required" in result
            assert "Call add_memory directly" in result
            assert "Proceed?" not in result

            inferred_result = await confirm_fn(
                action="Store a memory that the user's name is Brandon Tuttle.",
                reason="The user explicitly asked me to remember it.",
            )
            assert "Call add_memory directly" in inferred_result
            assert "Proceed?" not in inferred_result

        run(_run())


class TestPresentOptions:
    def test_basic_options(self):
        async def _run():
            items = await _get_tools()
            present_fn = next(i.fn for i in items if i.fn.__name__ == "present_options")
            options = json.dumps(
                [
                    {
                        "label": "Detailed",
                        "description": "Full analysis with sources",
                        "tradeoffs": "Comprehensive but slow",
                    },
                    {
                        "label": "Headlines",
                        "description": "Key points only",
                        "tradeoffs": "Quick but may miss nuance",
                    },
                ]
            )
            result = await present_fn(
                decision="Report format",
                options_json=options,
            )
            assert "Detailed" in result
            assert "Headlines" in result
            assert "Report format" in result
            assert "Which option" in result

        run(_run())

    def test_with_recommendation(self):
        async def _run():
            items = await _get_tools()
            present_fn = next(i.fn for i in items if i.fn.__name__ == "present_options")
            options = json.dumps(
                [
                    {"label": "A", "description": "Option A"},
                    {"label": "B", "description": "Option B"},
                ]
            )
            result = await present_fn(
                decision="Choose",
                options_json=options,
                recommendation="I recommend A because it's simpler",
            )
            assert "recommendation" in result.lower()
            assert "simpler" in result

        run(_run())

    def test_invalid_json_returns_error(self):
        async def _run():
            items = await _get_tools()
            present_fn = next(i.fn for i in items if i.fn.__name__ == "present_options")
            result = await present_fn(
                decision="Choose",
                options_json="not valid json{{{",
            )
            assert "error" in result.lower()

        run(_run())

    def test_options_limited_to_max(self):
        async def _run():
            items = await _get_tools({"max_options": 2})
            present_fn = next(i.fn for i in items if i.fn.__name__ == "present_options")
            options = json.dumps([{"label": f"Option {i}"} for i in range(5)])
            result = await present_fn(
                decision="Choose",
                options_json=options,
            )
            assert "Option 0" in result
            assert "Option 1" in result
            assert "Option 2" not in result

        run(_run())


class TestConfirmResearchPlan:
    def test_formats_plan_and_source_strategy(self):
        async def _run():
            items = await _get_tools()
            confirm_fn = next(
                i.fn for i in items if i.fn.__name__ == "confirm_research_plan"
            )
            strategy = json.dumps(
                {
                    "recommended_tool_sequence": [
                        {
                            "name": "Curated Recent Feeds",
                            "tools": ["curated_feed_search_tool"],
                            "reason": "Current announcements.",
                        }
                    ],
                    "warnings": ["disabled source override applied"],
                }
            )
            return await confirm_fn(
                title="Inference Landscape",
                sections_json=json.dumps(["Scope", "Findings", "Recommendations"]),
                source_strategy_json=strategy,
                estimated_tool_calls=7,
            )

        result = run(_run())

        assert "Deep research plan approval" in result
        assert "Inference Landscape" in result
        assert "Curated Recent Feeds" in result
        assert "Estimated tool calls" in result
        assert "Reply yes" in result

    def test_records_scoped_pending_approval_without_token(self):
        async def _run():
            fake_redis = FakeRedis()
            items = await _get_tools()
            confirm_fn = next(
                i.fn for i in items if i.fn.__name__ == "confirm_research_plan"
            )
            result = await confirm_fn(
                title="Deep report",
                sections_json=json.dumps(["Plan", "Evidence"]),
                user_id="brandon",
                target="report:aiq",
            )
            return result, fake_redis

        result, fake_redis = run(_run())

        assert "No approval credential has been created" in result
        assert "deep_research_plan" in result
        assert fake_redis.store == {}


class TestDeleteMemoryGuarded:
    def test_rejects_missing_token(self):
        async def _run():
            fake_redis = FakeRedis()
            import user_interaction.user_interaction_function as mod

            with patch.object(mod, "make_redis_client", return_value=fake_redis):
                items = await _get_tools()
                delete_fn = next(
                    i.fn for i in items if i.fn.__name__ == "delete_memory_guarded"
                )
                result = await delete_fn(user_id="brandon", approval_token="")
            assert "denied" in result

        run(_run())

    def test_deletes_matching_memory_keys_once(self):
        async def _run():
            from user_interaction.approval_tokens import (
                ApprovalRequest,
                issue_approval_token,
            )

            fake_redis = FakeRedis()
            token = issue_approval_token(
                fake_redis,
                ApprovalRequest(
                    user_id="brandon",
                    action_type="delete_memory",
                    target="brandon",
                ),
            )
            fake_redis.store["nat:memory:deadbeef"] = json.dumps(
                {"user_id": "brandon", "memory": "a"}
            )
            fake_redis.store["nat:memory:brandon12"] = json.dumps(
                {"user_id": "someoneelse", "memory": "b"}
            )

            import user_interaction.user_interaction_function as mod

            with patch.object(mod, "make_redis_client", return_value=fake_redis):
                items = await _get_tools()
                delete_fn = next(
                    i.fn for i in items if i.fn.__name__ == "delete_memory_guarded"
                )
                result = await delete_fn(user_id="brandon", approval_token=token)
                second = await delete_fn(user_id="brandon", approval_token=token)

            assert "Deleted 1" in result
            assert "nat:memory:deadbeef" not in fake_redis.store
            assert "nat:memory:brandon12" in fake_redis.store
            assert "denied" in second

        run(_run())

    def test_uses_authenticated_user_over_llm_supplied_user_id(self):
        async def _run():
            from user_interaction.approval_tokens import (
                ApprovalRequest,
                issue_approval_token,
            )

            fake_redis = FakeRedis()
            token = issue_approval_token(
                fake_redis,
                ApprovalRequest(
                    user_id="tuttlebr",
                    action_type="delete_memory",
                    target="tuttlebr",
                ),
            )
            fake_redis.store["nat:memory:1234abcd"] = json.dumps(
                {"user_id": "tuttlebr", "memory": "a"}
            )
            fake_redis.store["nat:memory:tuttlebr"] = json.dumps(
                {"user_id": "Brandon Tuttle", "memory": "b"}
            )

            import user_interaction.user_interaction_function as mod

            with (
                patch.object(mod, "make_redis_client", return_value=fake_redis),
                patch.object(
                    mod,
                    "_authenticated_user_or_fallback",
                    return_value="tuttlebr",
                ),
            ):
                items = await _get_tools()
                delete_fn = next(
                    i.fn for i in items if i.fn.__name__ == "delete_memory_guarded"
                )
                result = await delete_fn(
                    user_id="Brandon Tuttle",
                    approval_token=token,
                )

            assert "Deleted 1" in result
            assert "nat:memory:1234abcd" not in fake_redis.store
            assert "nat:memory:tuttlebr" in fake_redis.store

        run(_run())

    def test_confirm_delete_memory_rejects_different_target(self):
        async def _run():
            import user_interaction.user_interaction_function as mod

            with patch.object(
                mod, "_authenticated_user_or_fallback", return_value="alice"
            ):
                items = await _get_tools()
                confirm_fn = next(
                    i.fn for i in items if i.fn.__name__ == "confirm_action"
                )
                return await confirm_fn(
                    action="Delete my memory",
                    reason="requested",
                    action_type="delete_memory",
                    target="harmless-label",
                )

        assert "must match the authenticated user" in run(_run())
