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
