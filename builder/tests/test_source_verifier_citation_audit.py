import asyncio
import json
import socket
import threading
import time
from functools import partial
from unittest.mock import MagicMock

import pytest


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    """Resolve reference hosts deterministically; audits never need real DNS."""
    lookups = []

    def resolve(host, *_args, **_kwargs):
        lookups.append(host)
        address = "10.0.0.8" if host.endswith(".internal.test") else "93.184.216.34"
        return [(socket.AF_INET, None, None, "", (address, 0))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    return lookups


async def _audit_fn():
    from source_verifier.source_verifier_function import (
        SourceVerifierConfig,
        source_verifier_function,
    )

    async for item in source_verifier_function(
        SourceVerifierConfig(enabled_operations=["audit_citations"]),
        MagicMock(),
    ):
        return partial(item.fn, operation="audit_citations")
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


def test_explicit_empty_source_ledger_rejects_all_references():
    async def scenario():
        audit = await _audit_fn()
        answer = "A claim [1].\n\n## References\n- [1] NVIDIA - https://developer.nvidia.com/cuda-toolkit"
        omitted = json.loads(await audit(answer_markdown=answer))
        empty = json.loads(await audit(answer_markdown=answer, source_urls_json="[]"))
        assert omitted["passed"]
        assert not empty["passed"]
        assert any(
            item["reason"] == "url_not_in_source_ledger"
            for item in empty["invalid_citations"]
        )

    run(scenario())


def test_malformed_json_ledger_never_certifies_embedded_urls():
    async def scenario():
        audit = await _audit_fn()
        result = json.loads(
            await audit(
                answer_markdown="Claim [1].\n\n## References\n- [1] NVIDIA - https://developer.nvidia.com/cuda-toolkit",
                source_urls_json='["https://developer.nvidia.com/cuda-toolkit"',
            )
        )
        assert not result["passed"]
        assert any(
            item["reason"] == "invalid_source_ledger"
            for item in result["invalid_citations"]
        )

    run(scenario())


def test_reference_resolving_to_private_address_is_rejected(public_dns):
    async def scenario():
        audit = await _audit_fn()
        return json.loads(
            await audit(
                answer_markdown=(
                    "Claim [1].\n\n## References\n"
                    "- [1] Internal - https://wiki.internal.test/page"
                )
            )
        )

    result = run(scenario())
    assert result["passed"] is False
    assert result["invalid_citations"][0]["reason"].startswith("unsafe_url:")
    assert "non-public" in result["invalid_citations"][0]["reason"]
    assert public_dns == ["wiki.internal.test"]


@pytest.mark.parametrize(
    "second_url",
    [
        "https://docs.nvidia.com/cuda/",
        "https://developer.nvidia.com/cuda-toolkit",
        "https://example.com/fake",
    ],
)
def test_duplicate_citation_numbers_are_rejected_and_removed(second_url):
    async def scenario():
        audit = await _audit_fn()
        answer = (
            "Ambiguous claim [1]. Independent claim [3].\n\n## References\n"
            "- [1] First - https://developer.nvidia.com/cuda-toolkit\n"
            f"- [1] Second - {second_url}\n"
            "- [3] Independent - https://developer.nvidia.com/blog/"
        )
        result = json.loads(await audit(answer_markdown=answer))
        repaired = json.loads(await audit(answer_markdown=result["repaired_markdown"]))
        return result, repaired

    result, repaired = run(scenario())
    assert result["passed"] is False
    assert any(
        item["reason"] == "duplicate_citation_number"
        for item in result["invalid_citations"]
    )
    assert result["valid_citations"] == [
        {"number": 3, "url": "https://developer.nvidia.com/blog/"}
    ]
    assert "First" not in result["repaired_markdown"]
    assert "Second" not in result["repaired_markdown"]
    assert "Ambiguous claim ." in result["repaired_markdown"]
    assert "Independent claim [1]." in result["repaired_markdown"]
    assert repaired["passed"] is True


@pytest.mark.parametrize("with_references", [True, False])
@pytest.mark.parametrize("with_ledger", [True, False])
def test_malformed_reference_url_returns_a_failed_audit(with_references, with_ledger):
    async def scenario():
        audit = await _audit_fn()
        url = "https://[broken/source"
        answer = (
            f"Claim [1].\n\n## References\n- [1] Source - {url}"
            if with_references
            else f"Claim {url}"
        )
        return json.loads(
            await audit(
                answer_markdown=answer,
                source_urls_json=json.dumps([url]) if with_ledger else "",
                require_references=with_references,
            )
        )

    result = run(scenario())
    assert result["passed"] is False
    assert any(
        item["reason"].startswith("unsafe_url:") for item in result["invalid_citations"]
    )


@pytest.mark.parametrize("with_references", [True, False])
def test_reference_dns_does_not_stall_the_event_loop(monkeypatch, with_references):
    """Each reference performs blocking DNS; other tool calls must keep running."""
    delay = 0.2
    hosts = [f"source{index}.example" for index in range(6)]
    lock = threading.Lock()
    lookups, active, peak = [], 0, 0

    def slow_dns(host, *_args, **_kwargs):
        nonlocal active, peak
        with lock:
            lookups.append(host)
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(delay)
            return [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))]
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(socket, "getaddrinfo", slow_dns)
    links = [f"https://{host}/article" for host in hosts]
    body = " ".join(f"Claim [{index}]." for index in range(1, len(hosts) + 1))
    if with_references:
        # A repeated URL is checked once, then reported as a duplicate.
        references = [f"- [{i}] Source - {url}" for i, url in enumerate(links, 1)]
        references.append(f"- [{len(links) + 1}] Again - {links[0]}")
        answer = f"{body}\n\n## References\n" + "\n".join(references)
    else:
        answer = f"{body} " + " ".join(links + links[:1])

    async def scenario():
        audit = await _audit_fn()
        gaps, done = [], asyncio.Event()

        async def heartbeat():
            last = time.perf_counter()
            while not done.is_set():
                await asyncio.sleep(0.01)
                now = time.perf_counter()
                gaps.append(now - last)
                last = now

        beat = asyncio.create_task(heartbeat())
        await asyncio.sleep(0)
        started = time.perf_counter()
        try:
            result = json.loads(
                await audit(answer_markdown=answer, require_references=False)
            )
        finally:
            elapsed = time.perf_counter() - started
            done.set()
            await beat
        return result, max(gaps), elapsed

    result, max_gap, elapsed = run(scenario())
    assert sorted(lookups) == sorted(hosts)
    assert [item["reason"] for item in result["invalid_citations"]] == (
        ["duplicate_of_citation_1"] if with_references else []
    )
    # Serial lookups on the loop would block it for len(hosts) * delay.
    assert max_gap < 0.5, max_gap
    assert elapsed < delay * len(hosts) * 0.75, elapsed
    assert 1 < peak <= 8
