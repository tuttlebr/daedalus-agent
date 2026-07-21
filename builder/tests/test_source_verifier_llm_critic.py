"""Focused tests for the provider-neutral source-verification critic."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest


def run(coro):
    return asyncio.run(coro)


def test_llm_critic_validates_and_normalizes_a_verdict():
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

    config = mod.SourceVerifierConfig(
        enabled_operations=["verify_claim"],
        llm_name="portable_verifier",
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
        AsyncMock(return_value=mod.FetchResult(status="ok", content="source body")),
    )

    async def _run():
        async for item in mod.source_verifier_function(config, builder):
            return await item.fn(
                "The project ships a supported release.",
                "https://docs.example.test/release",
            )
        raise AssertionError("verify_claim was not registered")

    result = json.loads(run(_run()))

    assert builder.get_llm.await_args.args[0] == "portable_verifier"
    assert llm.ainvoke.await_count == 1
    assert result["verdict"] == "supported"
    assert result["source_reachable"] is True
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
                "A precise claim.",
                "https://docs.example.test/release",
            )
        raise AssertionError("verify_claim was not registered")

    result = json.loads(run(_run()))

    assert result["verdict"] == "error"
    assert result["claim_issues"] == ["verification_response_error"]
    assert result["critic"]["status"] == "error"
