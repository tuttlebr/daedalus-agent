"""Invalid dispatcher calls must fail before any leaf I/O or side effect."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from daedalus_runtime.tool_contracts import parameters
from daedalus_runtime.tools import ToolDefinition
from jsonschema import Draft202012Validator
from pydantic import ValidationError


def schemas():
    from agent_skills.agent_skills_function import AgentSkillsInput
    from llm_sandbox.llm_sandbox_function import LlmSandboxInput
    from nat_nv_ingest.nat_nv_ingest import UserDocumentInput
    from source_verifier.source_verifier_function import SourceVerifierInput
    from user_interaction.user_interaction_function import UserInteractionInput
    from visual_media.visual_media_function import VisualMediaInput

    return {
        "agent_skills": AgentSkillsInput,
        "llm_sandbox": LlmSandboxInput,
        "nat_nv_ingest": UserDocumentInput,
        "source_verifier": SourceVerifierInput,
        "user_interaction": UserInteractionInput,
        "visual_media": VisualMediaInput,
    }


@pytest.mark.parametrize(
    "kind,args",
    [
        ("agent_skills", {"operation": "load_skill"}),
        ("agent_skills", {"operation": "load_skill", "skill_name": " "}),
        (
            "agent_skills",
            {"operation": "run_skill_script", "skill_name": "x", "script": "x.py"},
        ),
        ("agent_skills", {"operation": "list_skills", "script": "x.py"}),
        ("source_verifier", {"operation": "verify_claim", "claim": "claim"}),
        (
            "source_verifier",
            {
                "operation": "plan_sources",
                "research_question": "topic",
                "source_url": "https://example.com",
            },
        ),
        (
            "visual_media",
            {"operation": "generate", "prompt": "draw", "imageRef": {"imageId": "x"}},
        ),
        ("visual_media", {"operation": "edit", "prompt": "edit"}),
        (
            "visual_media",
            {
                "operation": "analyze",
                "question": "describe",
                "imageRef": [{"imageId": "x"}],
            },
        ),
        (
            "visual_media",
            {
                "operation": "analyze",
                "question": "describe",
                "image_url": "https://example.com/a",
                "video_url": "https://example.com/v",
            },
        ),
        ("nat_nv_ingest", {"operation": "ingest", "query": "unrelated"}),
        (
            "nat_nv_ingest",
            {"operation": "extract", "documentRefs": [{"documentId": "x"}]},
        ),
        ("nat_nv_ingest", {"operation": "list_collections", "query": "ignored"}),
        (
            "llm_sandbox",
            {"operation": "execute", "argv": ["echo", "x"], "command": "echo x"},
        ),
        ("llm_sandbox", {"operation": "execute", "argv": [], "timeout_seconds": "30"}),
        ("llm_sandbox", {"operation": "write_file", "file_path": "x"}),
        ("user_interaction", {"operation": "clarify", "question": "Proceed?"}),
        (
            "user_interaction",
            {"operation": "delete_memory_guarded", "approval_token": " "},
        ),
    ],
)
def test_invalid_calls_never_enter_leaf(kind, args):
    leaf = AsyncMock()
    tool = ToolDefinition(leaf, schemas()[kind], "Purpose and result contract.")
    tool.configure_contract(
        kind, SimpleNamespace(enabled_operations=None, allow_script_execution=False)
    )
    with pytest.raises(ValidationError):
        asyncio.run(tool.ainvoke(args))
    leaf.assert_not_awaited()


def test_empty_file_is_valid_and_nested_types_survive():
    leaf = AsyncMock(return_value="saved")
    tool = ToolDefinition(leaf, schemas()["llm_sandbox"], "Write a file.")
    tool.configure_contract("llm_sandbox", SimpleNamespace(enabled_operations=None))
    assert (
        asyncio.run(
            tool.ainvoke(
                {
                    "operation": "write_file",
                    "file_path": "empty.txt",
                    "file_content": "",
                }
            )
        )
        == "saved"
    )
    assert leaf.await_args.kwargs["file_content"] == ""


def test_disabled_operations_and_arguments_are_absent_from_published_schema():
    config = SimpleNamespace(
        enabled_operations=["list_skills"], allow_script_execution=True
    )
    schema = parameters(
        "agent_skills", schemas()["agent_skills"].model_json_schema(), config
    )
    assert set(schema["properties"]) == {"operation", "query"}
    assert schema["properties"]["operation"]["enum"] == ["list_skills"]


def test_rss_batch_cannot_mix_single_query_or_ignore_scope():
    from rss_feed.rss_feed_function import _rss_input_schema

    schema = parameters(
        "rss_feed",
        _rss_input_schema({"one": "https://example.com/rss"}, 3).model_json_schema(),
        None,
    )
    validator = Draft202012Validator(schema)
    batch = {"mode": "discover", "queries": [{"query": "topic", "feed_scope": "one"}]}
    assert validator.is_valid(batch)
    assert not validator.is_valid({**batch, "query": "ignored"})
    assert not validator.is_valid({**batch, "feed_scope": "one"})
    assert not validator.is_valid({"query": " "})
    assert not validator.is_valid({"query": "topic", "unknown": True})


def test_clock_has_guidance_and_observes_trusted_timezone(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "synthetic-internal")
    from datetime import datetime

    from daedalus_runtime.datetime_tool import DateTimeConfig, current_datetime
    from nat_helpers.identity import authenticated_request_headers_scope

    async def check():
        async with asynccontextmanager(current_datetime)(
            DateTimeConfig(), MagicMock()
        ) as tool:
            assert "server clock" in tool.schema("clock")["description"]
            with authenticated_request_headers_scope(
                {
                    "x-user-id": "owner",
                    "x-timezone": "Asia/Kolkata",
                    "x-daedalus-internal-token": "synthetic-internal",
                }
            ):
                result = datetime.fromisoformat(await tool.ainvoke({}))
                assert result.utcoffset().total_seconds() == 19800
            with pytest.raises(ValidationError):
                await tool.ainvoke({"timezone": "UTC"})

    asyncio.run(check())
