"""External reader fallback preserves the source, limits, and operator opt-in."""

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import nat_helpers.safe_http as safe_http
import pytest
import webscrape.reader as reader
import webscrape.webscrape_function as scrape
from daedalus_runtime.tools import ToolRegistry
from nat_helpers.public_content import (
    ArticleChallengeError,
    EmptyArticleError,
    PublicArticle,
    PublicContentSession,
)
from nat_helpers.safe_http import ResponseSizeError
from nat_helpers.url_guard import UnsafeURLError

URL = "https://zhuanlan.zhihu.com/p/123456789"
BODY = (
    "## 推理部署\n\n这是用于测试的合成文章。保留中文、代码、表格和链接。\n\n"
    "```python\nprint('示例')\n```\n\n| 模型 | 吞吐 |\n| --- | --- |\n| 示例 | 42 |\n\n"
    "[论文](https://example.org/paper)\n\n![架构](https://example.org/figure.png)\n\n"
    "参考文献：完整尾部。"
)


def status_error(status=403):
    response = httpx.Response(status, request=httpx.Request("GET", URL))
    return httpx.HTTPStatusError(
        "Synthetic failure", request=response.request, response=response
    )


def payload(**overrides):
    return {
        "code": 200,
        "data": {
            "url": URL,
            "title": "合成部署文章",
            "content": BODY,
            "httpStatus": 200,
            **overrides,
        },
    }


def response(value):
    return httpx.Response(
        200, json=value, request=httpx.Request("GET", reader.READER_BASE_URL + URL)
    )


@pytest.mark.parametrize(
    "error", [status_error(), ArticleChallengeError(), EmptyArticleError()]
)
def test_recoverable_failure_requires_exact_host_opt_in(error):
    assert not reader.reader_fallback_allowed(URL, [], ["https"], error)
    assert not reader.reader_fallback_allowed(URL, ["zhihu.com"], ["https"], error)
    assert reader.reader_fallback_allowed(URL, ["ZHUANLAN.ZHIHU.COM"], ["https"], error)


@pytest.mark.parametrize(
    "url",
    [
        URL + "?token=synthetic",
        "https://user:synthetic@zhuanlan.zhihu.com/p/123",
        "https://zhuanlan.zhihu.com:8443/p/123",
        "https://zhuanlan.zhihu.com.evil.test/p/123",
        "https://child.zhuanlan.zhihu.com/p/123",
        "https://127.0.0.1/p/123",
    ],
)
def test_sensitive_or_unconfigured_urls_are_never_exported(url):
    assert not reader.reader_fallback_allowed(
        url, ["zhuanlan.zhihu.com"], ["https"], status_error()
    )


@pytest.mark.parametrize(
    "error",
    [
        *(status_error(status) for status in (401, 404, 407, 410, 429, 451, 500, 503)),
        UnsafeURLError("private redirect"),
        ResponseSizeError("too large"),
        httpx.ConnectError("disconnected"),
        TimeoutError(),
        ValueError("converter bug"),
    ],
)
def test_unrelated_failures_do_not_trigger_reader(error):
    assert not reader.reader_fallback_allowed(
        URL, ["zhuanlan.zhihu.com"], ["https"], error
    )


def test_reader_requires_https_to_be_allowed():
    assert not reader.reader_fallback_allowed(
        URL.replace("https:", "http:"), ["zhuanlan.zhihu.com"], ["http"], status_error()
    )


def test_reader_preserves_full_original_language_and_provenance():
    article = reader._reader_article(response(payload()), URL)
    assert article.url == URL
    assert f"_Source: {URL}_" in article.markdown
    assert "合成部署文章" in article.markdown
    assert "Retrieved via: [Jina Reader]" in article.markdown
    assert "cached content" in article.markdown
    assert article.markdown.endswith(BODY)
    assert article.fetched_at


@pytest.mark.parametrize(
    "value,error",
    [
        ([], reader.ReaderResponseError),
        ({"code": 403, "data": {}}, reader.ReaderResponseError),
        ({"code": 200, "data": []}, reader.ReaderResponseError),
        (payload(url="https://example.org/unrelated"), reader.ReaderResponseError),
        (payload(httpStatus=403), reader.ReaderResponseError),
        (payload(warning="Page is incomplete"), reader.ReaderResponseError),
        (payload(warnings=["Page is incomplete"]), reader.ReaderResponseError),
        ({**payload(), "warning": "Partial response"}, reader.ReaderResponseError),
        (payload(content=None), EmptyArticleError),
        (payload(content=""), EmptyArticleError),
        (
            payload(content="just a moment checking your browser " * 3),
            ArticleChallengeError,
        ),
        (
            payload(content="安全验证，访问异常，请完成验证。" * 6),
            ArticleChallengeError,
        ),
    ],
)
def test_reader_error_envelopes_and_challenges_are_not_articles(value, error):
    with pytest.raises(error):
        reader._reader_article(response(value), URL)


def test_reader_invalid_json_is_reported():
    with pytest.raises(reader.ReaderResponseError, match="invalid JSON"):
        reader._reader_article(
            httpx.Response(200, text="not json", request=httpx.Request("GET", URL)), URL
        )


def test_reader_transport_checks_target_and_redirects_without_credentials(monkeypatch):
    seen, validated = [], []

    def validate(url, **kwargs):
        validated.append((url, kwargs))
        if "127.0.0.1" in url:
            raise UnsafeURLError("non-public redirect")

    def handle(request):
        seen.append(request)
        assert request.headers["accept"] == "application/json"
        assert (
            "cookie" not in request.headers and "authorization" not in request.headers
        )
        if len(seen) == 1:
            return httpx.Response(
                302,
                headers={
                    "location": "https://r.jina.ai/next",
                    "set-cookie": "identity=synthetic",
                },
            )
        return response(payload())

    monkeypatch.setattr(reader, "validate_public_url", validate)
    monkeypatch.setattr(safe_http, "validate_public_url", validate)
    monkeypatch.setattr(
        reader, "PublicAsyncHTTPTransport", lambda: httpx.MockTransport(handle)
    )
    article = asyncio.run(
        reader.fetch_reader_article(
            URL + "#section", timeout=5, allowed_schemes=["https"]
        )
    )
    assert article.markdown.endswith(BODY)
    assert [url for url, _ in validated] == [
        URL,
        reader.READER_BASE_URL + URL,
        "https://r.jina.ai/next",
    ]
    assert all(kwargs["check_dns"] for _, kwargs in validated)

    seen.clear()
    monkeypatch.setattr(
        reader,
        "PublicAsyncHTTPTransport",
        lambda: httpx.MockTransport(
            lambda request: httpx.Response(
                302, headers={"location": "https://127.0.0.1/private"}
            )
        ),
    )
    with pytest.raises(UnsafeURLError, match="non-public redirect"):
        asyncio.run(
            reader.fetch_reader_article(URL, timeout=5, allowed_schemes=["https"])
        )


def test_private_source_is_rejected_before_contacting_reader(monkeypatch):
    def reject(*args, **kwargs):
        raise UnsafeURLError("non-public source")

    transport = AsyncMock(side_effect=AssertionError("Reader must not be contacted"))
    monkeypatch.setattr(reader, "validate_public_url", reject)
    monkeypatch.setattr(reader, "get_public_response_async", transport)
    with pytest.raises(UnsafeURLError, match="non-public source"):
        asyncio.run(
            reader.fetch_reader_article(URL, timeout=5, allowed_schemes=["https"])
        )
    transport.assert_not_called()


async def invoke(**config):
    registry = ToolRegistry(
        {
            "functions": {
                "scrape": {
                    "_type": "webscrape",
                    "respect_robots_txt": False,
                    "reader_fallback_hosts": ["zhuanlan.zhihu.com"],
                    **config,
                }
            }
        }
    )
    try:
        tool = await registry.get_function("scrape")
        return await tool.ainvoke({"url": URL})
    finally:
        await registry.close()


def setup_failure(monkeypatch, error=None):
    direct = AsyncMock(side_effect=error or status_error())
    fallback = AsyncMock(return_value=reader._reader_article(response(payload()), URL))
    monkeypatch.setattr(PublicContentSession, "article", direct)
    monkeypatch.setattr(scrape, "fetch_reader_article", fallback)
    return direct, fallback


def test_tool_falls_back_with_original_source_and_fetch_time(monkeypatch):
    direct, fallback = setup_failure(monkeypatch)
    result = asyncio.run(invoke())
    assert result.endswith(BODY)
    assert f"_Source: {URL}_" in result
    assert "_Fetched:" in result and "cache: reader" in result
    assert "Jina Reader" in result
    direct.assert_awaited_once()
    fallback.assert_awaited_once()


def test_tool_default_and_robots_denial_do_not_contact_reader(monkeypatch):
    direct, fallback = setup_failure(monkeypatch)
    assert "HTTP 403" in asyncio.run(invoke(reader_fallback_hosts=[]))
    fallback.assert_not_awaited()
    direct.reset_mock()
    monkeypatch.setattr(
        scrape, "_check_robots", AsyncMock(side_effect=PermissionError("robots denied"))
    )
    assert "robots denied" in asyncio.run(invoke(respect_robots_txt=True))
    direct.assert_not_awaited()
    fallback.assert_not_awaited()


def test_direct_success_does_not_contact_reader(monkeypatch):
    _, fallback = setup_failure(monkeypatch)
    monkeypatch.setattr(
        PublicContentSession,
        "article",
        AsyncMock(return_value=(PublicArticle(URL, BODY, "fixture"), "miss")),
    )
    assert asyncio.run(invoke()) == BODY
    fallback.assert_not_awaited()


def test_tool_reports_both_failures_and_truncates_reader_content(monkeypatch):
    _, fallback = setup_failure(monkeypatch)
    fallback.side_effect = reader.ReaderResponseError(
        "Reader reported an incomplete or blocked page."
    )
    result = asyncio.run(invoke())
    assert "HTTP 403" in result and "Reader fallback also failed" in result
    assert "incomplete or blocked page" in result
    fallback.side_effect = None
    fallback.return_value = reader._reader_article(
        response(payload(content=BODY * 100)), URL
    )
    result = asyncio.run(invoke(max_output_tokens=100))
    assert "Content truncated" in result
    assert not result.endswith(BODY)


def test_research_mode_retains_reader_provenance_and_untruncated_content(monkeypatch):
    setup_failure(monkeypatch)

    async def run():
        registry = ToolRegistry(
            {
                "functions": {
                    "scrape": {
                        "_type": "webscrape",
                        "respect_robots_txt": False,
                        "reader_fallback_hosts": ["zhuanlan.zhihu.com"],
                        "enable_research_mode": True,
                        "max_output_tokens": 100,
                    }
                }
            }
        )
        try:
            tool = await registry.get_function("scrape")
            result = json.loads(
                await tool.ainvoke({"url": URL, "output_mode": "research"})
            )
            assert result["source"]["url"] == URL
            assert "Jina Reader" in result["content"]
            assert result["content"].endswith(BODY)
        finally:
            await registry.close()

    asyncio.run(run())


def test_direct_and_reader_share_one_deadline(monkeypatch):
    async def direct(*args, **kwargs):
        await asyncio.sleep(0.06)
        raise status_error()

    async def fallback(*args, **kwargs):
        await asyncio.sleep(0.06)
        raise AssertionError("Combined deadline must expire first")

    monkeypatch.setattr(PublicContentSession, "article", direct)
    monkeypatch.setattr(scrape, "fetch_reader_article", fallback)

    async def run():
        # Bypass the operator's five-second minimum only for a fast deadline test.
        config = scrape.WebscrapeFunctionConfig.model_construct(
            timeout=0.1,
            respect_robots_txt=False,
            reader_fallback_hosts=["zhuanlan.zhihu.com"],
        )
        generator = scrape.webscrape_function(config, object())
        definition = await generator.__anext__()
        try:
            result = await definition.fn(URL)
            assert "timeout 0.1s" in result
        finally:
            await generator.aclose()

    asyncio.run(run())
