import asyncio
import json
from unittest.mock import MagicMock


def run(coro):
    return asyncio.run(coro)


async def _audit_fn():
    from source_verifier.source_verifier_function import (
        SourceVerifierConfig,
        source_verifier_function,
    )

    async for item in source_verifier_function(
        SourceVerifierConfig(enabled_operations=["audit_citations"]),
        MagicMock(),
    ):
        return item.fn
    raise AssertionError("audit_citations was not registered")


def test_audit_citations_accepts_valid_reference_from_source_ledger():
    async def _run():
        audit = await _audit_fn()
        raw = await audit(
            answer_markdown=(
                "CUDA supports GPU acceleration [1].\n\n"
                "**References:**\n"
                "- [1] NVIDIA CUDA - https://developer.nvidia.com/cuda-toolkit"
            ),
            source_urls_json=json.dumps(["https://developer.nvidia.com/cuda-toolkit"]),
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is True
    assert result["invalid_citations"] == []
    assert result["valid_citations"][0]["number"] == 1


def test_audit_citations_rejects_placeholder_and_repairs_orphaned_inline_citation():
    async def _run():
        audit = await _audit_fn()
        raw = await audit(
            answer_markdown=(
                "The answer uses one good source [1] and one bad source [2].\n\n"
                "## Sources\n"
                "- [1] NVIDIA CUDA - https://developer.nvidia.com/cuda-toolkit\n"
                "- [2] Placeholder - https://example.com/fake"
            ),
            source_urls_json=json.dumps(["https://developer.nvidia.com/cuda-toolkit"]),
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is False
    reasons = {item["reason"] for item in result["invalid_citations"]}
    assert "placeholder_url" in reasons
    assert "[2]" not in result["repaired_markdown"]
    assert "example.com/fake" not in result["repaired_markdown"]


def test_audit_citations_rejects_urls_not_seen_in_source_ledger():
    async def _run():
        audit = await _audit_fn()
        raw = await audit(
            answer_markdown=(
                "A claim is cited [1].\n\n"
                "## References\n"
                "- [1] Unseen - https://docs.nvidia.com/cuda/"
            ),
            source_urls_json=json.dumps(["https://developer.nvidia.com/cuda-toolkit"]),
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is False
    assert {item["reason"] for item in result["invalid_citations"]} >= {
        "url_not_in_source_ledger",
        "no_valid_citations",
    }
