"""Shared anonymous article fetching preserves identity and bounded cache rules."""

import asyncio
from unittest.mock import AsyncMock

import httpx
import nat_helpers.public_content as content
import pytest
from nat_helpers.url_guard import UnsafeURLError


def _response(url="https://example.com/article", status=200, headers=None):
    return httpx.Response(
        status,
        content=b"article bytes",
        headers=headers,
        request=httpx.Request("GET", url),
    )


def test_article_coalesces_fetch_conversion_and_expires(monkeypatch):
    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()

        async def fetch(*args, **kwargs):
            entered.set()
            await release.wait()
            return _response(headers={"etag": "v1"})

        fetch_mock = AsyncMock(side_effect=fetch)
        monkeypatch.setattr(content, "get_public_response_async", fetch_mock)
        calls = []
        monkeypatch.setattr(
            content,
            "_convert_article",
            lambda *args: calls.append(args) or "# Article\n\nBody",
        )
        clock = [100.0]
        monkeypatch.setattr(content.time, "monotonic", lambda: clock[0])
        session = content.PublicContentSession(client=AsyncMock(), ttl=30)
        first = asyncio.create_task(
            session.article(
                "https://example.com/article", converter=lambda *_: "article"
            )
        )
        await entered.wait()
        second = asyncio.create_task(
            session.article(
                "https://example.com/article#section", converter=lambda *_: "article"
            )
        )
        await asyncio.sleep(0)
        release.set()
        one, two = await asyncio.gather(first, second)
        assert one[0] is two[0]
        assert {one[1], two[1]} == {"miss", "coalesced"}
        assert len(calls) == fetch_mock.await_count == 1
        assert one[0].fetched_at and one[0].etag == "v1"
        assert (
            await session.article(
                "https://example.com/article", converter=lambda *_: "article"
            )
        )[1] == "hit"
        clock[0] += 31
        assert (
            await session.article(
                "https://example.com/article", converter=lambda *_: "article"
            )
        )[1] == "miss"
        assert fetch_mock.await_count == 2
        await session.close()

    asyncio.run(run())


@pytest.mark.parametrize(
    "url,headers",
    [
        ("https://example.com/article?token=private", {}),
        ("https://example.com/article", {"cache-control": "private"}),
        ("https://example.com/article", {"cache-control": "no-store"}),
        ("https://example.com/article", {"set-cookie": "identity=test"}),
    ],
)
def test_sensitive_or_uncacheable_response_is_not_retained(monkeypatch, url, headers):
    async def run():
        fetch = AsyncMock(return_value=_response(url, headers=headers))
        monkeypatch.setattr(content, "get_public_response_async", fetch)
        monkeypatch.setattr(content, "_convert_article", lambda *args: "article")
        session = content.PublicContentSession(client=AsyncMock())
        assert (await session.article(url, converter=lambda *_: "article"))[1] == "miss"
        assert (await session.article(url, converter=lambda *_: "article"))[1] == "miss"
        assert fetch.await_count == 2
        assert not session._cache
        await session.close()

    asyncio.run(run())


def test_failed_fetch_not_cached_and_private_url_rejected(monkeypatch):
    async def run():
        fetch = AsyncMock(return_value=_response(status=403))
        monkeypatch.setattr(content, "get_public_response_async", fetch)
        session = content.PublicContentSession(client=AsyncMock())
        for _ in range(2):
            with pytest.raises(httpx.HTTPStatusError):
                await session.article(
                    "https://example.com/article", converter=lambda *_: "article"
                )
        assert fetch.await_count == 2
        with pytest.raises(UnsafeURLError):
            await session.article(
                "http://127.0.0.1/private", converter=lambda *_: "article"
            )
        assert fetch.await_count == 2
        await session.close()

    asyncio.run(run())


def test_waiter_cancellation_does_not_cancel_other_waiters(monkeypatch):
    async def run():
        release = asyncio.Event()

        async def fetch(*args, **kwargs):
            await release.wait()
            return _response()

        monkeypatch.setattr(content, "get_public_response_async", fetch)
        monkeypatch.setattr(content, "_convert_article", lambda *args: "article")
        session = content.PublicContentSession(client=AsyncMock())
        one = asyncio.create_task(
            session.article(
                "https://example.com/article", converter=lambda *_: "article"
            )
        )
        two = asyncio.create_task(
            session.article(
                "https://example.com/article", converter=lambda *_: "article"
            )
        )
        await asyncio.sleep(0)
        one.cancel()
        with pytest.raises(asyncio.CancelledError):
            await one
        release.set()
        assert (await two)[0].markdown == "article"
        await session.close()

    asyncio.run(run())


def test_cache_has_entry_and_byte_bounds(monkeypatch):
    async def run():
        monkeypatch.setattr(
            content, "get_public_response_async", AsyncMock(return_value=_response())
        )
        monkeypatch.setattr(content, "_convert_article", lambda *args: "x" * 20)
        session = content.PublicContentSession(
            client=AsyncMock(), max_entries=2, max_bytes=30
        )
        for index in range(3):
            await session.article(
                f"https://example.com/{index}", converter=lambda *_: "article"
            )
        assert len(session._cache) == 1
        assert session._bytes == 20
        await session.close()

    asyncio.run(run())


def test_anonymous_client_does_not_send_cookies_or_authorization():
    async def run():
        seen = []

        def handler(request):
            seen.append(dict(request.headers))
            return httpx.Response(
                200, headers={"set-cookie": "identity=secret; Path=/"}
            )

        async with content.AnonymousPublicClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            await client.get(
                "https://example.com/a",
                headers={"Authorization": "secret", "Cookie": "identity=secret"},
            )
            await client.get("https://example.com/b")
            assert len(client.cookies) == 0
        assert all(
            "cookie" not in headers and "authorization" not in headers
            for headers in seen
        )

    asyncio.run(run())


def test_builder_scoped_sessions_close_only_after_last_tool(monkeypatch):
    async def run():
        session = content.PublicContentSession(client=AsyncMock())
        close = AsyncMock(wraps=session.close)
        monkeypatch.setattr(session, "close", close)
        monkeypatch.setattr(content, "PublicContentSession", lambda: session)
        owner = object()
        async with content.public_content_session(owner) as first:
            async with content.public_content_session(owner) as second:
                assert first is second
            close.assert_not_awaited()
        close.assert_awaited_once()
        assert id(owner) not in content._SESSIONS

    asyncio.run(run())


def test_cache_does_not_bypass_restricted_redirect_schemes(monkeypatch):
    async def run():
        fetch = AsyncMock(return_value=_response())
        monkeypatch.setattr(content, "get_public_response_async", fetch)
        session = content.PublicContentSession(client=AsyncMock())

        def converter(*_):
            return "article"

        await session.article("https://example.com/article", converter=converter)
        await session.article(
            "https://example.com/article",
            allowed_schemes=("https",),
            converter=converter,
        )
        assert fetch.await_count == 2
        assert fetch.await_args.kwargs["allowed_schemes"] == ("https",)
        await session.close()

    asyncio.run(run())


def test_article_timeout_covers_waiting_for_fetch_slot(monkeypatch):
    async def run():
        fetch = AsyncMock(return_value=_response())
        monkeypatch.setattr(content, "get_public_response_async", fetch)
        session = content.PublicContentSession(client=AsyncMock())
        session._slots = asyncio.Semaphore(0)
        async with asyncio.timeout(0.2):
            with pytest.raises(TimeoutError):
                await session.article(
                    "https://example.com/article?query=uncached",
                    timeout=0.01,
                    converter=lambda *_: "article",
                )
        fetch.assert_not_awaited()
        await session.close()

    asyncio.run(run())


@pytest.mark.parametrize(
    "url",
    [
        "https://user:synthetic@example.com/userinfo",
        "https://user@example.com/userinfo",
    ],
)
def test_anonymous_client_rejects_derived_url_basic_auth(url):
    async def run():
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200)

        async with content.AnonymousPublicClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            with pytest.raises(UnsafeURLError, match="credentials"):
                await client.get(url)
        assert not seen

    asyncio.run(run())


def test_anonymous_redirect_does_not_send_derived_basic_auth(monkeypatch):
    async def run():
        from nat_helpers import safe_http

        monkeypatch.setattr(
            safe_http, "validate_public_url", lambda *args, **kwargs: None
        )
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(
                302, headers={"location": "https://user:synthetic@example.com/private"}
            )

        async with content.AnonymousPublicClient(
            transport=httpx.MockTransport(handler), follow_redirects=False
        ) as client:
            with pytest.raises(UnsafeURLError, match="credentials"):
                await safe_http.get_public_response_async(
                    client, "https://example.com/public"
                )
        assert len(seen) == 1
        assert "authorization" not in seen[0].headers

    asyncio.run(run())


def test_anonymous_client_disables_client_and_per_call_auth():
    async def run():
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200)

        async with content.AnonymousPublicClient(
            transport=httpx.MockTransport(handler), auth=("user", "synthetic")
        ) as client:
            await client.get("https://example.com/client-auth")
            await client.get(
                "https://example.com/call-auth", auth=("user", "synthetic")
            )
        assert len(seen) == 2
        assert all("authorization" not in request.headers for request in seen)

    asyncio.run(run())


@pytest.mark.parametrize(
    "body",
    [
        "attention required ddos-guard",
        "just a moment checking your browser",
        "access denied you don't have permission to access",
    ],
)
def test_challenges_never_enter_the_shared_article_cache(monkeypatch, body):
    async def run():
        fetch = AsyncMock(return_value=_response())
        monkeypatch.setattr(content, "get_public_response_async", fetch)
        session = content.PublicContentSession(client=AsyncMock())
        for _ in range(2):
            with pytest.raises(ValueError, match="challenge"):
                await session.article(
                    "https://example.com/article", converter=lambda *_: body
                )
        assert fetch.await_count == 2
        assert not session._cache
        await session.close()

    asyncio.run(run())


def test_raw_html_challenge_rejected_before_converter_hides_signatures(monkeypatch):
    async def run():
        from unittest.mock import Mock

        response = httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=b"<html><script>ddos-guard attention required</script></html>",
            request=httpx.Request("GET", "https://example.com/article"),
        )
        monkeypatch.setattr(
            content, "get_public_response_async", AsyncMock(return_value=response)
        )
        converter = Mock(return_value="page")
        session = content.PublicContentSession(client=AsyncMock())
        with pytest.raises(ValueError, match="challenge"):
            await session.article("https://example.com/article", converter=converter)
        converter.assert_not_called()
        assert not session._cache
        await session.close()

    asyncio.run(run())


@pytest.mark.parametrize(
    "media_type", ["text/html; charset=UTF-8", "application/xhtml+xml"]
)
def test_known_html_uses_shared_converter_without_generic_detection(
    monkeypatch, media_type
):
    from unittest.mock import Mock

    html = Mock(return_value="# Title\n\n_Source: https://example.com/_\n\nBody")
    generic = Mock(side_effect=AssertionError("HTML must not initialize Magika"))
    monkeypatch.setattr(content, "_convert_html_article", html)
    assert "Body" in content._convert_article(
        b"<p>Body</p>", "https://example.com/", media_type, generic
    )
    html.assert_called_once_with(b"<p>Body</p>", "https://example.com/")
    generic.assert_not_called()


@pytest.mark.parametrize("media_type", ["", "application/pdf", "text/plain"])
def test_other_documents_retain_existing_converter(monkeypatch, media_type):
    from unittest.mock import Mock

    html = Mock(side_effect=AssertionError("Document must retain format detection"))
    generic = Mock(return_value="Document body")
    monkeypatch.setattr(content, "_convert_html_article", html)
    assert (
        content._convert_article(
            b"document", "https://example.com/", media_type, generic
        )
        == "Document body"
    )
    generic.assert_called_once_with(b"document", "https://example.com/", media_type)
    html.assert_not_called()


@pytest.mark.parametrize(
    "missing", ["charset_normalizer", "markitdown", "markitdown.converters"]
)
def test_missing_optional_html_libraries_preserve_supplied_converter(
    monkeypatch, missing
):
    import builtins
    from unittest.mock import Mock

    original_import = builtins.__import__

    def without_optional_library(name, *args, **kwargs):
        if name == missing:
            raise ImportError(f"Optional library unavailable: {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_optional_library)
    generic = Mock(return_value="Alternate complete HTML content")
    assert (
        content._convert_article(
            b"<p>Article</p>", "https://example.com/", "text/html", generic
        )
        == "Alternate complete HTML content"
    )
    generic.assert_called_once_with(
        b"<p>Article</p>", "https://example.com/", "text/html"
    )


@pytest.mark.parametrize("error", [ValueError, ImportError])
def test_actual_html_conversion_errors_are_not_hidden_by_fallback(monkeypatch, error):
    from unittest.mock import Mock

    generic = Mock(return_value="Must not hide invalid extraction")
    monkeypatch.setattr(
        content, "_convert_html_article", Mock(side_effect=error("Invalid HTML"))
    )
    with pytest.raises(error, match="Invalid HTML"):
        content._convert_article(
            b"broken", "https://example.com/", "text/html", generic
        )
    generic.assert_not_called()


def test_real_html_converter_preserves_full_markdown_without_classifier(tmp_path):
    """Exercise the installed converter outside conftest's dependency stubs."""
    import importlib.metadata
    import os
    import subprocess
    import sys
    from pathlib import Path

    try:
        importlib.metadata.version("markitdown")
    except importlib.metadata.PackageNotFoundError:
        pytest.skip("Real MarkItDown contract also runs in the built backend image")

    fixture = """<!doctype html><html><head><title>Full article</title>
    <meta charset="utf-8"><style>.hidden {display:none}</style></head><body>
    <nav><a href="/archive">Archive</a></nav><main><h1>Full article</h1>
    <p>Evidence: café, α, 東京. <a href="https://example.org/paper#results">Paper</a></p>
    <table><tr><th>Model</th><th>Rate</th></tr><tr><td>A</td><td>42</td></tr></table>
    <pre><code class="language-python">if ready:\n    print("retained")</code></pre>
    <ul><li>First observation</li><li>Second observation</li></ul>
    <p>Footnote <a href="#reference-1">[1]</a></p></main>
    <footer id="reference-1">Reference outside main content</footer>
    <script>throw new Error("not article text")</script></body></html>"""
    path = tmp_path / "article.html"
    path.write_text(fixture)
    program = """
import sys
from pathlib import Path
from markitdown import MarkItDown
from nat_helpers.public_content import _convert_article
path = Path(sys.argv[1])
url = "https://example.com/article"
expected = MarkItDown(enable_plugins=True).convert(path)
expected = f"# {expected.title or url}\\n\\n_Source: {url}_\\n\\n{expected.text_content}"
def forbidden(*args, **kwargs):
    raise AssertionError("General classifier must not run for known HTML")
MarkItDown.__init__ = forbidden
actual = _convert_article(path.read_bytes(), url, "text/html", forbidden)
assert actual == expected
for retained in ("café", "α", "東京", "https://example.org/paper#results", "| Model | Rate |", 'print("retained")', "Reference outside main content", "#reference-1", "/archive"):
    assert retained in actual, retained
assert "not article text" not in actual
assert ".hidden" not in actual
# HTML's encoding declarations and legacy non-UTF8 prose are retained as well.
legacy = '<html><head><title>Café</title><meta charset="windows-1252"></head><body><p>Résumé — £42</p></body></html>'.encode("cp1252")
actual = _convert_article(legacy, url, "text/html", forbidden)
assert "Café" in actual and "Résumé" in actual and "£42" in actual
# Preserve the caller's specialized conversion, without activating a converter
# here that could perform an unpinned network fetch (YouTube transcripts).
for specialized_url in ("https://en.wikipedia.org/wiki/Example", "https://www.youtube.com/watch?v=example", "https://www.bing.com/search?q=example"):
    calls = []
    def specialized(data, source, media_type):
        calls.append((data, source, media_type))
        return "Specialized complete content"
    assert _convert_article(path.read_bytes(), specialized_url, "text/html", specialized) == "Specialized complete content"
    assert calls == [(path.read_bytes(), specialized_url, "text/html")]
# An installed plugin can override generic HTML extraction. Keep that contract.
import nat_helpers.public_content as public_content
public_content._has_markitdown_plugins = lambda: True
assert _convert_article(path.read_bytes(), url, "text/html", lambda *_: "Plugin content") == "Plugin content"
print("Real HTML conversion: exact Markdown, full content, Unicode, tables, code and links passed")
"""
    env = {**os.environ, "PYTHONPATH": str(Path(content.__file__).parents[1])}
    result = subprocess.run(
        [sys.executable, "-c", program, str(path)],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
