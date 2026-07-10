"""Focused tests for the Fireworks calibrated source-verification driver."""

import asyncio
import json
import math
from unittest.mock import AsyncMock, MagicMock

import pytest


def run(coro):
    return asyncio.run(coro)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeAsyncClient:
    def __init__(self, response, captured, **kwargs):
        self._response = response
        self._captured = captured
        self._captured["client_kwargs"] = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, *, headers, json):
        self._captured["url"] = url
        self._captured["headers"] = headers
        self._captured["request"] = json
        return self._response


def test_fireworks_classifier_uses_highest_configured_label_probability(monkeypatch):
    import source_verifier.source_verifier_function as mod

    payload = {
        "choices": [
            {
                # The completion itself was sampled as S, but U has the higher
                # model probability. The verifier must use the distribution,
                # not the stochastic completion text, to drive its verdict.
                "message": {"content": " S"},
                "logprobs": {
                    "content": [
                        {
                            "token": " S",
                            "logprob": math.log(0.30),
                            "top_logprobs": [
                                {"token": " U", "logprob": math.log(0.60)},
                                {"token": " S", "logprob": math.log(0.30)},
                                {"token": " P", "logprob": math.log(0.08)},
                                {"token": " I", "logprob": math.log(0.02)},
                            ],
                        }
                    ]
                },
            }
        ]
    }
    captured = {}

    monkeypatch.setattr(
        mod.httpx,
        "AsyncClient",
        lambda **kwargs: _FakeAsyncClient(_FakeResponse(payload), captured, **kwargs),
    )
    config = mod.SourceVerifierConfig(
        verification_driver="fireworks_classifier",
        fireworks_api_key="fireworks-test-key",
        fireworks_model="accounts/acme/models/source-verifier",
    )

    result = run(
        mod._classify_claim_with_fireworks(
            config,
            claim="The project ships a supported release.",
            source_url="https://example.test/release",
            source_content="The source content.",
            context="",
        )
    )

    assert result["verdict"] == "unsupported"
    assert result["confidence"] == pytest.approx(0.60)
    assert result["classifier"] == {
        "provider": "fireworks",
        "model": "accounts/acme/models/source-verifier",
        "label": "U",
        "label_logprob": pytest.approx(math.log(0.60)),
        "calibrated": True,
        "class_probabilities": {
            "supported": pytest.approx(0.30),
            "unsupported": pytest.approx(0.60),
            "partially_supported": pytest.approx(0.08),
            "insufficient_context": pytest.approx(0.02),
        },
    }
    assert captured["url"] == "https://api.fireworks.ai/inference/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer fireworks-test-key"
    assert captured["request"]["model"] == "accounts/acme/models/source-verifier"
    assert captured["request"]["logprobs"] is True
    assert captured["request"]["top_logprobs"] == 5
    assert captured["request"]["temperature"] == 1.0
    assert captured["request"]["top_p"] == 1.0


def test_verify_claim_uses_fireworks_classifier_without_calling_llm(monkeypatch):
    import source_verifier.source_verifier_function as mod

    config = mod.SourceVerifierConfig(
        enabled_operations=["verify_claim"],
        verification_driver="fireworks_classifier",
        fireworks_api_key="fireworks-test-key",
        fireworks_model="accounts/acme/models/source-verifier",
        fireworks_fallback_to_llm=False,
    )
    classifier = AsyncMock(
        return_value={
            "verdict": "supported",
            "confidence": 0.97,
            "evidence": None,
            "reasoning": "Calibrated classifier result.",
            "claim_issues": [],
            "classifier": {"provider": "fireworks", "calibrated": True},
        }
    )
    llm = AsyncMock()
    monkeypatch.setattr(
        mod,
        "_fetch_source",
        AsyncMock(return_value=mod.FetchResult(status="ok", content="source body")),
    )
    monkeypatch.setattr(mod, "_classify_claim_with_fireworks", classifier)
    monkeypatch.setattr(mod, "_call_llm", llm)

    async def _run():
        async for item in mod.source_verifier_function(config, MagicMock()):
            return await item.fn(
                "The project ships a supported release.",
                "https://example.test/release",
            )
        raise AssertionError("verify_claim was not registered")

    result = json.loads(run(_run()))

    assert classifier.await_count == 1
    assert classifier.await_args.kwargs["source_content"] == "source body"
    llm.assert_not_awaited()
    assert result == {
        "verdict": "supported",
        "confidence": 0.97,
        "evidence": None,
        "reasoning": "Calibrated classifier result.",
        "claim_issues": [],
        "classifier": {"provider": "fireworks", "calibrated": True},
        "source_url": "https://example.test/release",
        "source_reachable": True,
    }
