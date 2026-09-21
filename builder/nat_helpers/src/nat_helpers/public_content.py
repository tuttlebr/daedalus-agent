"""Bounded, anonymous article retrieval shared by a builder's tool lifecycles.

Never sends cookies or credentials. Cache only successful public responses that
allow caching, without query strings or Set-Cookie. There is no process-global
content cache: owners and their clients are released after the last tool closes.
"""

from __future__ import annotations

import asyncio
import io
import re
import time
from collections import OrderedDict
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from importlib.metadata import entry_points
from urllib.parse import urldefrag, urlparse

import httpx

from .phase_timing import phase_timing
from .safe_http import PublicAsyncHTTPTransport, get_public_response_async
from .url_guard import UnsafeURLError, validate_public_url

ARTICLE_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


CHALLENGE_SIGNATURES = (
    "just a moment",
    "checking your browser",
    "attention required",
    "enable javascript and cookies",
    "cf-browser-verification",
    "challenge-platform",
    "cdn-cgi/challenge-platform",
    "_cf_chl_opt",
    "ddos-guard",
    "please turn javascript on",
    "checking if the site connection is secure",
    "verify you are human",
    "ray id:",
    "access denied",
    "you don't have permission to access",
    "request blocked",
    "requested url was rejected",
    "forbidden",
    "reference #",
)


def is_challenge_page(text: str) -> bool:
    """Require two known challenge signatures in the first 5,000 characters."""
    lower = text[:5000].lower()
    return sum(signature in lower for signature in CHALLENGE_SIGNATURES) >= 2


class AnonymousPublicClient(httpx.AsyncClient):
    """Keep pooled TLS connections without retaining ambient cookie identity."""

    async def send(self, request, *args, **kwargs):
        if request.url.userinfo:
            raise UnsafeURLError(
                "Anonymous public requests cannot contain URL credentials"
            )
        # HTTPX normally derives BasicAuth after send() receives the request.
        # An explicit empty Auth also disables client/per-call auth providers.
        kwargs["auth"] = httpx.Auth()
        request.headers.pop("cookie", None)
        request.headers.pop("authorization", None)
        response = await super().send(request, *args, **kwargs)
        self.cookies.clear()
        return response


@dataclass(frozen=True)
class PublicArticle:
    url: str
    markdown: str
    fetched_at: str
    etag: str | None = None
    last_modified: str | None = None


@lru_cache(maxsize=1)
def _has_markitdown_plugins() -> bool:
    # Installed entry points are process-lifetime metadata, not article data.
    return bool(entry_points(group="markitdown.plugin"))


def _convert_html_article(content: bytes, url: str) -> str | None:
    """Use MarkItDown's HTML converter without rebuilding its file classifier.

    The HTTP media type already identifies HTML. Constructing the general
    MarkItDown dispatcher initializes Magika/ONNX and guesses the file type on
    every article, before reaching this same converter. Keep the complete DOM,
    charset detection, and dispatcher whitespace normalization; selecting an
    article subtree would discard tables, links, or other useful page content.
    Specialized URLs, plugins, and non-HTML documents retain the caller's
    existing general converter.
    """
    try:
        from charset_normalizer import from_bytes
        from markitdown import StreamInfo
        from markitdown.converters import (
            BingSerpConverter,
            HtmlConverter,
            WikipediaConverter,
            YouTubeConverter,
        )
    except ImportError:
        # The tool packages own these optional dependencies. Standalone helper
        # users can supply their own converter without installing MarkItDown.
        return None

    if _has_markitdown_plugins():
        return None
    stream = io.BytesIO(content)
    known_html = StreamInfo(mimetype="text/html", extension=".html", url=url)
    if any(
        specialized().accepts(stream, known_html)
        for specialized in (WikipediaConverter, YouTubeConverter, BingSerpConverter)
    ):
        # Do not replace specialized extraction with the generic HTML path, or
        # activate it here: YouTube's converter can fetch unpinned transcripts.
        return None

    # Match the bounded charset detection used by the general dispatcher. The
    # converter still receives bytes so HTML encoding declarations remain usable.
    detected = from_bytes(content[:4096]).best()
    result = HtmlConverter().convert(
        io.BytesIO(content),
        StreamInfo(
            mimetype="text/html",
            extension=".html",
            charset=detected.encoding if detected is not None else None,
        ),
    )
    markdown = "\n".join(
        line.rstrip() for line in re.split(r"\r?\n", result.text_content)
    )
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    return f"# {result.title or url}\n\n_Source: {url}_\n\n{markdown}"


def _convert_article(
    content: bytes,
    url: str,
    content_type: str,
    converter: Callable[[bytes, str, str], str],
) -> str:
    markdown = None
    if content_type.split(";", 1)[0].strip().lower() in {
        "text/html",
        "application/xhtml+xml",
    }:
        markdown = _convert_html_article(content, url)
    if markdown is None:
        markdown = converter(content, url, content_type)
    # Shared converters return a canonical title/source header, which alone is
    # not evidence of successful article extraction.
    source = f"_Source: {url}_"
    body = markdown.split(source, 1)[-1].strip()
    if not body or markdown.startswith("Error:"):
        raise ValueError("Article conversion produced no content")
    if is_challenge_page(body):
        raise ValueError("Article is an automated-access challenge")
    return markdown


def _cache_ttl(headers: httpx.Headers, default: float) -> float:
    directives = headers.get("cache-control", "").lower()
    if headers.get("set-cookie") or any(
        directive in directives for directive in ("no-store", "private", "no-cache")
    ):
        return 0
    match = re.search(r"(?:^|,)\s*max-age\s*=\s*\"?(\d+)", directives)
    age = headers.get("age", "0")
    server_ttl = (
        max(0, int(match[1]) - (int(age) if age.isdecimal() else 0))
        if match
        else default
    )
    return min(default, server_ttl)


class PublicContentSession:
    def __init__(
        self,
        *,
        ttl: float = 300,
        max_entries: int = 64,
        max_bytes: int = 8 * 1024 * 1024,
        client: httpx.AsyncClient | None = None,
    ):
        self.ttl, self.max_entries, self.max_bytes = ttl, max_entries, max_bytes
        self.client = client or AnonymousPublicClient(
            headers={
                "User-Agent": ARTICLE_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            transport=PublicAsyncHTTPTransport(),
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(30, connect=5),
        )
        self._cache: OrderedDict[
            tuple[str, tuple[str, ...]], tuple[float, PublicArticle, int]
        ] = OrderedDict()
        self._bytes = 0
        self._pending: dict[tuple[str, tuple[str, ...]], asyncio.Task] = {}
        self._slots = asyncio.Semaphore(8)

    async def close(self):
        pending = list(self._pending.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self._pending.clear()
        self._cache.clear()
        self._bytes = 0
        await self.client.aclose()

    async def _load(self, url: str, timeout: float, allowed_schemes, converter):
        async with asyncio.timeout(timeout):
            async with self._slots:
                with phase_timing("daedalus.public_content.fetch"):
                    for attempt in range(3):
                        try:
                            response = await get_public_response_async(
                                self.client, url, allowed_schemes=allowed_schemes
                            )
                            if (
                                response.status_code
                                not in {408, 425, 429, 500, 502, 503, 504}
                                or attempt == 2
                            ):
                                response.raise_for_status()
                                break
                        except httpx.TransportError:
                            if attempt == 2:
                                raise
                        await asyncio.sleep(0.35 * (2**attempt))
                    fetched_at = datetime.now(UTC).isoformat()
                content_type = response.headers.get("content-type", "")
                if not content_type and response.content[
                    :512
                ].lstrip().lower().startswith((b"<!doctype html", b"<html")):
                    content_type = "text/html"
                if content_type.split(";", 1)[0].strip().lower() in {
                    "text/html",
                    "application/xhtml+xml",
                } and is_challenge_page(
                    response.content[:20000].decode("utf-8", errors="ignore")
                ):
                    raise ValueError("Article is an automated-access challenge")
                with phase_timing("daedalus.public_content.convert"):
                    markdown = await asyncio.to_thread(
                        _convert_article,
                        response.content,
                        url,
                        content_type,
                        converter,
                    )
        article = PublicArticle(
            url=url,
            markdown=markdown,
            fetched_at=fetched_at,
            etag=response.headers.get("etag"),
            last_modified=response.headers.get("last-modified"),
        )
        ttl = _cache_ttl(response.headers, self.ttl)
        size = len(markdown.encode("utf-8"))
        if ttl > 0 and not urlparse(url).query and size <= self.max_bytes:
            key = (url, tuple(allowed_schemes))
            if key in self._cache:
                self._bytes -= self._cache.pop(key)[2]
            self._cache[key] = (time.monotonic() + ttl, article, size)
            self._bytes += size
            while len(self._cache) > self.max_entries or self._bytes > self.max_bytes:
                self._bytes -= self._cache.popitem(last=False)[1][2]
        return article

    async def article(
        self,
        url: str,
        *,
        converter: Callable[[bytes, str, str], str],
        timeout: float = 30,
        allowed_schemes=("https", "http"),
    ) -> tuple[PublicArticle, str]:
        url = urldefrag(url)[0]
        parsed = urlparse(url)
        if parsed.username is not None or parsed.password is not None:
            raise UnsafeURLError("Anonymous public URLs cannot contain credentials")
        allowed_schemes = tuple(sorted({scheme.lower() for scheme in allowed_schemes}))
        key = (url, allowed_schemes)
        validate_public_url(url, allowed_schemes=allowed_schemes, check_dns=False)
        # URL queries can carry tokens or personalized selectors. Do not cache or
        # coalesce them, even though the transport still enforces public hosts.
        share = not urlparse(url).query
        cached = self._cache.get(key) if share else None
        if cached and cached[0] > time.monotonic():
            self._cache.move_to_end(key)
            with phase_timing("daedalus.public_content.cache", {"cache_status": "hit"}):
                return cached[1], "hit"
        if cached:
            self._bytes -= self._cache.pop(key)[2]
        pending = self._pending.get(key) if share else None
        status = "coalesced" if pending else "miss"
        if pending is None:
            # Bound the pending table as well as live network/conversion work.
            if not share or len(self._pending) >= 32:
                return await self._load(
                    url, timeout, allowed_schemes, converter
                ), "miss"
            pending = asyncio.create_task(
                self._load(url, timeout, allowed_schemes, converter)
            )
            self._pending[key] = pending

            def finished(task):
                if self._pending.get(key) is task:
                    self._pending.pop(key, None)
                if not task.cancelled():
                    task.exception()  # Consume failures if all waiters cancel.

            pending.add_done_callback(finished)
        with phase_timing("daedalus.public_content.cache", {"cache_status": status}):
            # Cancelling a waiter must not cancel the shared bounded operation.
            return await asyncio.wait_for(asyncio.shield(pending), timeout), status


# Strong owner references prevent id reuse; the final context removes the entry.
_SESSIONS: dict[int, tuple[object, PublicContentSession, int]] = {}


@asynccontextmanager
async def public_content_session(owner):
    key = id(owner)
    entry = _SESSIONS.get(key)
    session = entry[1] if entry else PublicContentSession()
    _SESSIONS[key] = (owner, session, (entry[2] if entry else 0) + 1)
    try:
        yield session
    finally:
        entry = _SESSIONS[key]
        if entry[2] == 1:
            del _SESSIONS[key]
            await session.close()
        else:
            _SESSIONS[key] = (owner, session, entry[2] - 1)
