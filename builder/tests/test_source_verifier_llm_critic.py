"""Focused tests for the provider-neutral source-verification critic."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest


def run(coro):
    return asyncio.run(coro)


def test_claim_focused_excerpt_preserves_middle_and_boundary_evidence():
    from source_verifier.source_verifier_function import _claim_focused_excerpt

    content = (
        "HEAD EVIDENCE\n"
        + ("unrelated filler " * 100)
        + "The critical build identifier is ZXQ-9.4.7."
        + ("more filler " * 100)
        + "\nTAIL EVIDENCE"
    )

    excerpt, truncated = _claim_focused_excerpt(
        content,
        "The critical build identifier is ZXQ-9.4.7.",
        600,
    )

    assert truncated is True
    assert len(excerpt) <= 600
    assert excerpt.startswith("HEAD EVIDENCE")
    assert "critical build identifier is ZXQ-9.4.7" in excerpt
    assert excerpt.endswith("TAIL EVIDENCE")
    assert "source content omitted" in excerpt


def test_llm_critic_validates_and_normalizes_a_verdict():
    from nat_helpers.communication_style import PROSE_STYLE_GUIDANCE
    from source_verifier.critic import LLMClaimCritic

    captured = {}

    async def invoke(system_prompt, user_prompt):
        captured["system_prompt"] = system_prompt
        captured["user_prompt"] = user_prompt
        return """```json
        {
          "verdict": "partially_supported",
          "confidence": 0.82,
          "evidence": "The release supports Linux.",
          "reasoning": "The source supports the platform but not the version.",
          "claim_issues": ["Version 4.2 is not stated."]
        }
        ```"""

    critic = LLMClaimCritic(llm_name="any_registered_llm", invoke=invoke)
    result = run(
        critic.verify(
            claim="Release 4.2 supports Linux.",
            source_url="https://docs.example.test/release",
            source_content="The release supports Linux.",
            context="durable memory finding",
        )
    )

    assert result == {
        "verdict": "partially_supported",
        "confidence": 0.82,
        "evidence": "The release supports Linux.",
        "reasoning": "The source supports the platform but not the version.",
        "claim_issues": ["Version 4.2 is not stated."],
        "critic": {
            "type": "llm",
            "llm_name": "any_registered_llm",
            "confidence_calibrated": False,
        },
    }
    assert "source-verification critic" in captured["system_prompt"]
    assert "Do not fill gaps with prior knowledge" in captured["system_prompt"]
    assert PROSE_STYLE_GUIDANCE in captured["system_prompt"]
    assert "Release 4.2 supports Linux." in captured["user_prompt"]
    assert "BEGIN UNTRUSTED SOURCE CONTENT" in captured["user_prompt"]


@pytest.mark.parametrize(
    "response",
    [
        "not json",
        json.dumps(
            {
                "verdict": "probably_supported",
                "confidence": 0.9,
                "evidence": None,
                "reasoning": "Invalid verdict vocabulary.",
                "claim_issues": [],
            }
        ),
        json.dumps(
            {
                "verdict": "supported",
                "confidence": 2.0,
                "evidence": "Evidence",
                "reasoning": "Invalid confidence.",
                "claim_issues": [],
            }
        ),
        json.dumps(
            {
                "verdict": "supported",
                "confidence": 0.9,
                "evidence": "Evidence",
                "reasoning": "Valid fields plus an undeclared field.",
                "claim_issues": [],
                "unrequested_field": "must be rejected",
            }
        ),
    ],
)
def test_llm_critic_rejects_invalid_responses(response):
    from source_verifier.critic import CriticResponseError, LLMClaimCritic

    async def invoke(_system_prompt, _user_prompt):
        return response

    critic = LLMClaimCritic(llm_name="test_llm", invoke=invoke)
    with pytest.raises(CriticResponseError):
        run(
            critic.verify(
                claim="A precise claim.",
                source_url="https://docs.example.test/source",
                source_content="Source text.",
            )
        )


def test_verify_claim_uses_the_configured_toolkit_llm(monkeypatch):
    import source_verifier.source_verifier_function as mod
    from langchain_core.messages import HumanMessage

    config = mod.SourceVerifierConfig(
        enabled_operations=["verify_claim"],
        llm_name="portable_verifier",
        max_source_chars=1000,
    )
    model_response = MagicMock()
    model_response.content = json.dumps(
        {
            "verdict": "supported",
            "confidence": 0.94,
            "evidence": "The project ships a supported release.",
            "reasoning": "The source states the precise claim.",
            "claim_issues": [],
        }
    )
    llm = MagicMock()
    llm.ainvoke = AsyncMock(return_value=model_response)
    builder = MagicMock()
    builder.get_llm = AsyncMock(return_value=llm)
    monkeypatch.setattr(
        mod,
        "_fetch_source",
        AsyncMock(
            return_value=mod.FetchResult(
                status="ok",
                content=(
                    "Head material. "
                    + ("unrelated filler " * 120)
                    + "Tail evidence: the project ships a supported release."
                ),
            )
        ),
    )

    async def _run():
        async for item in mod.source_verifier_function(config, builder):
            return await item.fn(
                operation="verify_claim",
                claim="The project ships a supported release.",
                source_url="https://docs.example.test/release",
            )
        raise AssertionError("verify_claim was not registered")

    result = json.loads(run(_run()))

    assert builder.get_llm.await_args.args[0] == "portable_verifier"
    assert llm.ainvoke.await_count == 1
    assert result["verdict"] == "supported"
    assert result["source_reachable"] is True
    assert result["source_truncated"] is True
    verifier_prompt = HumanMessage.call_args.kwargs["content"]
    assert "Tail evidence: the project ships a supported release." in verifier_prompt
    assert "source content omitted" in verifier_prompt
    assert result["critic"] == {
        "type": "llm",
        "llm_name": "portable_verifier",
        "confidence_calibrated": False,
    }


def test_verify_claim_returns_a_structured_error_for_bad_model_output(monkeypatch):
    import source_verifier.source_verifier_function as mod

    config = mod.SourceVerifierConfig(
        enabled_operations=["verify_claim"],
        llm_name="portable_verifier",
    )
    model_response = MagicMock()
    model_response.content = "I think the claim is true."
    llm = MagicMock()
    llm.ainvoke = AsyncMock(return_value=model_response)
    builder = MagicMock()
    builder.get_llm = AsyncMock(return_value=llm)
    monkeypatch.setattr(
        mod,
        "_fetch_source",
        AsyncMock(return_value=mod.FetchResult(status="ok", content="source body")),
    )

    async def _run():
        async for item in mod.source_verifier_function(config, builder):
            return await item.fn(
                operation="verify_claim",
                claim="A precise claim.",
                source_url="https://docs.example.test/release",
            )
        raise AssertionError("verify_claim was not registered")

    result = json.loads(run(_run()))

    assert result["verdict"] == "error"
    assert result["claim_issues"] == ["verification_response_error"]
    assert result["critic"]["status"] == "error"


def test_verify_claim_rejects_malformed_url_before_fetching(monkeypatch):
    import source_verifier.source_verifier_function as mod
    from nat_helpers.public_content import PublicContentSession

    http_fetch = AsyncMock(side_effect=AssertionError("Malformed URL was fetched"))
    monkeypatch.setattr(PublicContentSession, "article", http_fetch)

    async def scenario():
        async for item in mod.source_verifier_function(
            mod.SourceVerifierConfig(), MagicMock()
        ):
            return json.loads(
                await item.fn(
                    operation="verify_claim",
                    claim="A precise claim.",
                    source_url="https://[broken/source",
                )
            )
        raise AssertionError("Source verifier was not registered")

    result = run(scenario())
    assert result["verdict"] == "source_unreachable"
    assert result["fetch_status"] == "invalid_url"
    http_fetch.assert_not_awaited()


def test_verify_claim_selects_evidence_from_the_whole_fetched_source(monkeypatch):
    """Claim evidence beyond the model token budget must still reach the critic.

    Only the HTTP exchange and converter library are replaced; the real shared
    article session, conversion wrapper, excerpt and token bound run.
    """
    import httpx
    import nat_helpers.public_content as public_content
    import source_verifier.source_verifier_function as mod
    import webscrape.webscrape_function as scrape

    evidence = "The critical build identifier is ZXQ-9.4.7."
    page = (
        "HEAD EVIDENCE\n"
        + "unrelated filler " * 2000
        + evidence
        + " more filler" * 2500
        + "\nTAIL EVIDENCE"
    )

    async def fetch(_client, requested, **_kwargs):
        return httpx.Response(
            200,
            content=page.encode(),
            headers={"content-type": "text/plain"},
            request=httpx.Request("GET", requested),
        )

    def convert(path):
        with open(path, encoding="utf-8") as file_obj:
            return MagicMock(title="Release notes", text_content=file_obj.read())

    prompts = []

    async def call_llm(_builder, _config, _system_prompt, user_prompt):
        prompts.append(user_prompt)
        return json.dumps(
            {
                "verdict": "supported",
                "confidence": 0.9,
                "evidence": evidence,
                "reasoning": "The source states the identifier.",
                "claim_issues": [],
            }
        )

    monkeypatch.setattr(public_content, "get_public_response_async", fetch)
    monkeypatch.setattr(
        scrape, "MarkItDown", MagicMock(return_value=MagicMock(convert=convert))
    )
    monkeypatch.setattr(mod, "_call_llm", call_llm)
    config = mod.SourceVerifierConfig(
        enabled_operations=["verify_claim"], max_fetch_tokens=1000
    )

    async def scenario():
        async for item in mod.source_verifier_function(config, MagicMock()):
            return json.loads(
                await item.fn(
                    operation="verify_claim",
                    claim=evidence,
                    source_url="https://docs.example.test/release",
                )
            )
        raise AssertionError("verify_claim was not registered")

    result = run(scenario())

    (prompt,) = prompts
    source = prompt.split("BEGIN UNTRUSTED SOURCE CONTENT\n", 1)[1]
    source = source.split("\nEND UNTRUSTED SOURCE CONTENT", 1)[0]
    assert evidence in source
    assert "HEAD EVIDENCE" in source
    assert source.endswith("TAIL EVIDENCE")
    assert scrape._count_tokens(source) <= config.max_fetch_tokens
    assert result["verdict"] == "supported"
    assert result["source_truncated"] is True
