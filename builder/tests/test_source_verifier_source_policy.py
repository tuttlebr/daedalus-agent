import asyncio
import json
import socket
from functools import partial
from unittest.mock import MagicMock

import httpx
import pytest


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Source fetches use the builder-scoped PublicContentSession. Tests replace only
# its HTTP client: URL validation, redirect checks, DNS validation, conversion,
# caching and failure classification are the production code.
# ---------------------------------------------------------------------------
class _SessionClient:
    def __init__(self, responses=()):
        self._responses = list(responses)
        self.requested_urls = []

    async def get(self, url):
        self.requested_urls.append(url)
        response = self._responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response

    async def aclose(self):
        pass


def _response(url, status=200, *, content=b"", headers=None):
    return httpx.Response(
        status,
        content=content,
        headers=headers or {},
        request=httpx.Request("GET", url),
    )


def _fetch(url, config, client):
    """Run _fetch_source with a session whose only replaced part is *client*."""
    import source_verifier.source_verifier_function as mod
    from nat_helpers.public_content import PublicContentSession

    async def scenario():
        session = PublicContentSession(client=client)
        token = mod._content_session.set(session)
        try:
            return await mod._fetch_source(url, config)
        finally:
            mod._content_session.reset(token)
            await session.close()

    return run(scenario())


@pytest.fixture
def plain_text_conversion(monkeypatch):
    """Convert fixture bodies as text; conftest replaces MarkItDown with a mock."""
    import webscrape.webscrape_function as scrape

    monkeypatch.setattr(
        scrape,
        "_bytes_to_markdown",
        lambda content, url, content_type="": (
            f"# Source\n\n_Source: {url}_\n\n{content.decode()}"
        ),
    )


async def _plan_fn(config_overrides=None):
    from source_verifier.source_verifier_function import (
        SourceVerifierConfig,
        source_verifier_function,
    )

    config = SourceVerifierConfig(
        enabled_operations=["plan_sources"],
        **(config_overrides or {}),
    )
    async for item in source_verifier_function(config, MagicMock()):
        return partial(item.fn, operation="plan_sources")
    raise AssertionError("plan_sources was not registered")


def test_plan_sources_prioritizes_current_source_families():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question=(
                "What is the latest NVIDIA Developer Blog post about inference?"
            ),
            depth="quick",
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is True
    tool_order = [
        tool for item in result["recommended_tool_sequence"] for tool in item["tools"]
    ]
    assert tool_order[:3] == [
        "curated_feed_search_tool",
        "perplexity_search_tool",
        "domain_retriever_tool",
    ]
    assert result["recommended_tool_sequence"][1]["hints"] == [
        {"tool": "perplexity_search_tool", "search_recency_filter": "week"}
    ]
    assert result["source_ledger_contract"]["audit_tool"] == "source_verifier_tool"
    assert result["source_ledger_contract"]["audit_operation"] == "audit_citations"


def test_plan_sources_respects_selected_and_disabled_sources():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question="Deep research CUDA inference strategy.",
            selected_sources_json=json.dumps(["curated_domains", "perplexity_search"]),
            disabled_sources_json=json.dumps(["perplexity_search"]),
            depth="deep",
        )
        return json.loads(raw)

    result = run(_run())

    assert [source["id"] for source in result["selected_sources"]] == [
        "curated_domains"
    ]
    assert result["blocked_tools"] == ["perplexity_search_tool"]
    assert result["approval_recommended"] is False


def test_plan_sources_reports_unknown_sources():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question="Compare CUDA and ROCm.",
            selected_sources_json=json.dumps(["curated_domains", "missing"]),
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is True
    assert result["unknown_sources"] == ["missing"]
    assert any("unknown source ids" in warning for warning in result["warnings"])


def test_quick_briefing_does_not_recommend_an_extra_research_approval():
    async def _run():
        plan_sources = await _plan_fn()
        return json.loads(
            await plan_sources(
                research_question="Today's briefing: cluster report, AI strategy, markets",
                depth="quick",
            )
        )

    result = run(_run())
    assert result["passed"]
    assert len(result["selected_sources"]) >= 3
    assert result["approval_recommended"] is False


@pytest.mark.parametrize(
    "question,product",
    [
        ("How does Dynamo KV routing work?", "dynamo"),
        ("Configure OpenShell sandbox policy", "openshell"),
        ("Run an AIPerf concurrency sweep", "aiperf"),
        ("Deploy an NVCF cloud function", "nvcf"),
    ],
)
def test_nvidia_docs_hints_route_through_one_product_capability(question, product):
    from source_verifier.source_verifier_function import _tool_hints

    assert _tool_hints("nvidia_docs", question) == [
        {"tool": "nvidia_docs_tool", "product": product}
    ]


@pytest.mark.parametrize(
    "question,tool",
    [
        ("Read my Google Doc", "docs_mcp_server"),
        ("Search my Gmail inbox", "gmail_mcp_server"),
        ("What is on my calendar?", "calendar_mcp_server"),
    ],
)
def test_workspace_hints_route_to_the_relevant_google_service(question, tool):
    from source_verifier.source_verifier_function import _tool_hints

    assert _tool_hints("workspace_data", question) == [{"tool": tool}]


# ---------------------------------------------------------------------------
# F-002a: _fetch_source rejects redirects to internal/metadata addresses
# ---------------------------------------------------------------------------
def _public_dns(*_args, **_kwargs):
    return [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))]


_EVIDENCE = b"The release notes state that version 4.2 supports Linux on ARM64. " * 3


def test_fetch_source_rejects_redirect_to_internal(monkeypatch):
    import source_verifier.source_verifier_function as mod

    # Deterministic public resolution; the test must not depend on real DNS.
    monkeypatch.setattr(socket, "getaddrinfo", _public_dns)
    config = mod.SourceVerifierConfig(enabled_operations=["plan_sources"])
    url = "https://example.com/redirector"
    client = _SessionClient(
        [
            _response(
                url,
                302,
                headers={"location": "http://169.254.169.254/latest/meta-data/"},
            ),
            _response(url, content=b"<html>secret</html>"),
        ]
    )

    result = _fetch(url, config, client)

    assert result.status == "invalid_url"
    # The internal metadata target was never fetched.
    assert client.requested_urls == [url]


def test_fetch_source_rejects_literal_internal_url():
    import source_verifier.source_verifier_function as mod

    config = mod.SourceVerifierConfig(enabled_operations=["plan_sources"])
    client = _SessionClient()

    result = _fetch("http://169.254.169.254/latest/meta-data/", config, client)

    assert result.status == "invalid_url"
    assert client.requested_urls == []


def test_fetch_source_rejects_hostname_resolving_private(monkeypatch):
    import source_verifier.source_verifier_function as mod

    config = mod.SourceVerifierConfig(enabled_operations=["plan_sources"])
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, None, None, "", ("10.0.0.10", 0))],
    )
    client = _SessionClient()

    result = _fetch("https://rebind.example/private", config, client)

    assert result.status == "invalid_url"
    assert "non-public" in result.error.lower()
    assert client.requested_urls == []


@pytest.mark.parametrize(
    "url",
    [
        "https://reader:secret@docs.example.test/release",
        "https://reader@docs.example.test/release",
    ],
)
def test_fetch_source_rejects_url_credentials_before_any_request(url):
    """URL userinfo would otherwise be sent to the source as Basic auth."""
    import source_verifier.source_verifier_function as mod

    client = _SessionClient()
    result = _fetch(url, mod.SourceVerifierConfig(), client)

    assert result.status == "invalid_url"
    assert "credentials" in result.error
    assert client.requested_urls == []


@pytest.mark.usefixtures("plain_text_conversion")
@pytest.mark.parametrize(
    "status,fetch_status,detail",
    [
        (401, "challenge_page", "HTTP 401 (Unauthorized)"),
        (403, "challenge_page", "HTTP 403 (Forbidden)"),
        (451, "challenge_page", "HTTP 451 (Unavailable For Legal Reasons)"),
        (404, "unreachable", "HTTP 404 (Not Found)"),
        (410, "unreachable", "HTTP 410 (Gone)"),
    ],
)
def test_fetch_source_reports_the_http_status(
    monkeypatch, status, fetch_status, detail
):
    import source_verifier.source_verifier_function as mod

    monkeypatch.setattr(socket, "getaddrinfo", _public_dns)
    url = "https://docs.example.test/release"
    client = _SessionClient([_response(url, status, content=_EVIDENCE)])

    result = _fetch(url, mod.SourceVerifierConfig(), client)

    assert result.status == fetch_status
    assert detail in result.error


@pytest.mark.usefixtures("plain_text_conversion")
def test_fetch_source_reports_a_raw_challenge_page(monkeypatch):
    import source_verifier.source_verifier_function as mod

    monkeypatch.setattr(socket, "getaddrinfo", _public_dns)
    url = "https://docs.example.test/release"
    challenge = b"<html><title>Just a moment...</title>Checking your browser</html>"
    client = _SessionClient(
        [_response(url, content=challenge, headers={"content-type": "text/html"})]
    )

    result = _fetch(url, mod.SourceVerifierConfig(), client)

    assert result.status == "challenge_page"


@pytest.mark.parametrize(
    "error,detail",
    [
        (TimeoutError(), "did not respond in time (timeout 30s)"),
        (httpx.ConnectError("refused"), "Could not connect to the site (ConnectError)"),
    ],
)
def test_fetch_source_reports_transport_failures(monkeypatch, error, detail):
    from unittest.mock import AsyncMock

    import source_verifier.source_verifier_function as mod
    from nat_helpers.public_content import PublicContentSession

    monkeypatch.setattr(PublicContentSession, "article", AsyncMock(side_effect=error))

    result = _fetch(
        "https://docs.example.test/release",
        mod.SourceVerifierConfig(),
        _SessionClient(),
    )

    assert result.status == "unreachable"
    assert detail in result.error


def test_fetch_source_converts_legacy_encoded_html_from_original_bytes(monkeypatch):
    """Verification must see the same characters as the page.

    Decoding a media type without charset as UTF-8 would replace characters;
    the converter must receive the original bytes so the HTML charset
    declaration can be honored.
    """
    import source_verifier.source_verifier_function as mod
    import webscrape.webscrape_function as scrape

    legacy = (
        "<html><head><title>Résumé</title>"
        '<meta charset="windows-1252"></head><body><p>'
        + "Müller reported revenue of £42 million in Zürich. " * 3
        + "</p></body></html>"
    ).encode("cp1252")
    converted = {}

    def convert(path):
        with open(path, "rb") as file_obj:
            converted["bytes"] = file_obj.read()
        return MagicMock(title="Résumé", text_content="Article body. " * 10)

    monkeypatch.setattr(socket, "getaddrinfo", _public_dns)
    monkeypatch.setattr(
        scrape, "MarkItDown", MagicMock(return_value=MagicMock(convert=convert))
    )
    url = "https://docs.example.test/legacy"
    client = _SessionClient(
        [_response(url, content=legacy, headers={"content-type": "text/html"})]
    )

    result = _fetch(url, mod.SourceVerifierConfig(), client)

    assert result.status == "ok"
    assert result.content.startswith("# Résumé")
    assert converted["bytes"] == legacy


@pytest.mark.usefixtures("plain_text_conversion")
def test_fetch_source_dns_validation_does_not_stall_the_event_loop(monkeypatch):
    """Two verifier calls run concurrently with other tools on one loop."""
    import time

    import source_verifier.source_verifier_function as mod
    from nat_helpers.public_content import PublicContentSession

    delay = 0.6

    def slow_public_dns(*args, **kwargs):
        time.sleep(delay)
        return _public_dns(*args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", slow_public_dns)
    config = mod.SourceVerifierConfig(enabled_operations=["verify_claim"])
    url = "https://slow-dns.example/a"

    async def scenario():
        session = PublicContentSession(
            client=_SessionClient([_response(url, content=_EVIDENCE)])
        )
        token = mod._content_session.set(session)
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
        try:
            result = await mod._fetch_source(url, config)
        finally:
            done.set()
            await beat
            mod._content_session.reset(token)
            await session.close()
        return result, max(gaps)

    result, max_gap = run(scenario())
    assert result.status == "ok"
    assert max_gap < delay / 2, max_gap


@pytest.mark.usefixtures("plain_text_conversion")
def test_scraped_source_is_verified_from_the_shared_article_cache(monkeypatch):
    """webscrape and verify_claim share one bounded fetch per public URL."""
    import nat_helpers.public_content as public_content
    import source_verifier.source_verifier_function as mod
    from daedalus_runtime.tools import ToolRegistry

    fetches = []

    async def fetch(_client, url, **_kwargs):
        fetches.append(url)
        return _response(
            url,
            content=_EVIDENCE,
            headers={"content-type": "text/plain", "cache-control": "max-age=300"},
        )

    async def call_llm(*_args):
        return json.dumps(
            {
                "verdict": "supported",
                "confidence": 0.9,
                "evidence": "version 4.2 supports Linux on ARM64",
                "reasoning": "The source states the claim.",
                "claim_issues": [],
            }
        )

    monkeypatch.setattr(public_content, "get_public_response_async", fetch)
    monkeypatch.setattr(mod, "_call_llm", call_llm)
    url = "https://docs.example.test/release"

    async def scenario():
        registry = ToolRegistry(
            {
                "functions": {
                    "webscrape_tool": {
                        "_type": "webscrape",
                        "respect_robots_txt": False,
                    },
                    "source_verifier_tool": {"_type": "source_verifier"},
                },
                "llms": {"verifier_llm": {"model_name": "fixture"}},
            }
        )
        try:
            scrape = await registry.get_function("webscrape_tool")
            verifier = await registry.get_function("source_verifier_tool")
            scraped = await scrape.ainvoke({"url": url})
            arguments = {
                "operation": "verify_claim",
                "claim": "Version 4.2 supports Linux on ARM64.",
                "source_url": url,
            }
            verdicts = [json.loads(await verifier.ainvoke(arguments)) for _ in range(2)]
            return scraped, verdicts
        finally:
            await registry.close()

    scraped, verdicts = run(scenario())

    assert "version 4.2 supports Linux on ARM64" in scraped
    assert [verdict["verdict"] for verdict in verdicts] == ["supported", "supported"]
    assert all(verdict["source_reachable"] for verdict in verdicts)
    assert fetches == [url]


@pytest.mark.parametrize(
    "source_url",
    [
        "See https://example.com/report.",
        "<https://example.org/report>",
        "[report](https://example.net/report)",
        '{"url": "https://example.com/report"}',
    ],
)
def test_verify_claim_rejects_placeholder_host_of_the_extracted_url(
    monkeypatch, source_url
):
    """The placeholder check must see the URL that would actually be fetched."""
    from unittest.mock import AsyncMock

    import source_verifier.source_verifier_function as mod

    fetch = AsyncMock(side_effect=AssertionError("placeholder source was fetched"))
    monkeypatch.setattr(mod, "_fetch_source", fetch)

    async def scenario():
        async for item in mod.source_verifier_function(
            mod.SourceVerifierConfig(enabled_operations=["verify_claim"]), MagicMock()
        ):
            return json.loads(
                await item.fn(
                    operation="verify_claim",
                    claim="The report states the figure.",
                    source_url=source_url,
                )
            )
        raise AssertionError("verify_claim was not registered")

    result = run(scenario())
    assert result["fetch_status"] == "placeholder_url"
    assert result["claim_issues"] == ["placeholder_source_url"]
    fetch.assert_not_awaited()
