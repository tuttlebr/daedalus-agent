"""Optional public Reader fallback; never shares its results with direct fetches."""

import asyncio
from collections.abc import Iterable
from datetime import UTC, datetime
from urllib.parse import urldefrag, urlparse

import httpx
from nat_helpers.public_content import (
    AnonymousPublicClient,
    ArticleChallengeError,
    EmptyArticleError,
    PublicArticle,
    is_challenge_page,
)
from nat_helpers.safe_http import PublicAsyncHTTPTransport, get_public_response_async
from nat_helpers.url_guard import validate_public_url

READER_BASE_URL = "https://r.jina.ai/"


class ReaderResponseError(ValueError):
    """Reader returned an error, warning, or unrelated source instead of an article."""


def reader_fallback_allowed(
    url: str, hosts: Iterable[str], allowed_schemes: Iterable[str], exc: Exception
) -> bool:
    """Only send explicitly enabled, anonymous public URLs after extraction fails.

    Do not export query strings (which can contain credentials), use alternate
    ports, or turn authentication/not-found/rate-limit failures into reader calls.
    Public DNS is checked again immediately before contacting the reader.
    """
    parsed = urlparse(url)
    return (
        parsed.scheme in {"http", "https"}
        and "https" in allowed_schemes
        and parsed.hostname in {host.lower() for host in hosts}
        and not parsed.query
        and parsed.username is None
        and parsed.password is None
        and parsed.port in {None, 443 if parsed.scheme == "https" else 80}
        and (
            isinstance(exc, (ArticleChallengeError, EmptyArticleError))
            or (
                isinstance(exc, httpx.HTTPStatusError)
                and exc.response.status_code == 403
            )
        )
    )


def _reader_article(response: httpx.Response, url: str) -> PublicArticle:
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as exc:
        raise ReaderResponseError("Reader returned invalid JSON.") from exc
    if not isinstance(payload, dict) or payload.get("code") != 200:
        raise ReaderResponseError("Reader did not return a successful article.")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ReaderResponseError("Reader returned no article data.")
    if (
        data.get("httpStatus", 200) != 200
        or payload.get("warning")
        or payload.get("warnings")
        or data.get("warning")
        or data.get("warnings")
    ):
        raise ReaderResponseError("Reader reported an incomplete or blocked page.")
    if data.get("url") != url:
        raise ReaderResponseError("Reader returned a different source URL.")
    body = data.get("content")
    if not isinstance(body, str) or len(body.strip()) < 50:
        raise EmptyArticleError("Reader returned no extractable article content.")
    if is_challenge_page(body):
        raise ArticleChallengeError("Reader returned an automated-access challenge.")
    title = data.get("title")
    title = " ".join(title.split()) if isinstance(title, str) else url
    return PublicArticle(
        url=url,
        markdown=(
            f"# {title or url}\n\n_Source: {url}_\n"
            "_Retrieved via: [Jina Reader](https://jina.ai/reader/); "
            "the provider may serve cached content._\n\n" + body.strip()
        ),
        fetched_at=datetime.now(UTC).isoformat(),
    )


async def fetch_reader_article(
    url: str, *, timeout: float, allowed_schemes: Iterable[str]
) -> PublicArticle:
    """Fetch one bounded JSON response using the existing anonymous transport.

    The caller enforces host opt-in and a deadline shared with the direct fetch.
    No browser, cookies, credentials, or caller-selected proxy is used locally.
    The external reader controls its own rendering and downstream requests.
    """
    url = urldefrag(url)[0]
    await asyncio.to_thread(
        validate_public_url, url, allowed_schemes=allowed_schemes, check_dns=True
    )
    async with AnonymousPublicClient(
        headers={"Accept": "application/json"},
        transport=PublicAsyncHTTPTransport(),
        follow_redirects=False,
        trust_env=False,
        timeout=httpx.Timeout(timeout, connect=min(5, timeout)),
    ) as client:
        response = await get_public_response_async(
            client, READER_BASE_URL + url, allowed_schemes=("https",)
        )
    return await asyncio.to_thread(_reader_article, response, url)
