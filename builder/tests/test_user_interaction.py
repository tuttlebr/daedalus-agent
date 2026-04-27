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


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


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
    def test_yields_four_function_infos(self):
        items = run(_get_tools())
        assert len(items) == 4

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
        assert "present_options" in fn_names
        assert "delete_memory_guarded" in fn_names


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

    def test_confirmation_can_issue_approval_token(self):
        async def _run():
            import user_interaction.user_interaction_function as mod

            fake_redis = FakeRedis()
            with patch.object(mod, "make_redis_client", return_value=fake_redis):
                items = await _get_tools()
                confirm_fn = next(
                    i.fn for i in items if i.fn.__name__ == "confirm_action"
                )
                result = await confirm_fn(
                    action="Delete memories",
                    reason="User requested it",
                    user_id="brandon",
                    action_type="delete_memory",
                    target="brandon",
                )
            assert "approval token" in result.lower()
            assert len(fake_redis.store) == 1

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
            fake_redis.store["nat:memory:brandon:1"] = "a"
            fake_redis.store["nat:memory:someoneelse:1"] = "b"

            import user_interaction.user_interaction_function as mod

            with patch.object(mod, "make_redis_client", return_value=fake_redis):
                items = await _get_tools()
                delete_fn = next(
                    i.fn for i in items if i.fn.__name__ == "delete_memory_guarded"
                )
                result = await delete_fn(user_id="brandon", approval_token=token)
                second = await delete_fn(user_id="brandon", approval_token=token)

            assert "Deleted 1" in result
            assert "nat:memory:brandon:1" not in fake_redis.store
            assert "nat:memory:someoneelse:1" in fake_redis.store
            assert "denied" in second

        run(_run())
