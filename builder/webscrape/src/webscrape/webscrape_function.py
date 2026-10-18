import asyncio
import json
import logging
import mimetypes
import os
import re
import tempfile
from collections.abc import Iterable
from typing import Literal
from urllib.parse import ParseResult, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from daedalus_runtime.tools import (
    ToolConfig,
    ToolDefinition,
    ToolRegistry,
    register_tool,
)
from markitdown import MarkItDown
from nat_helpers.phase_timing import phase_timing
from nat_helpers.public_content import AnonymousPublicClient, _convert_html_article
from nat_helpers.public_content import is_challenge_page as _is_challenge_page
from nat_helpers.public_content import public_content_session
from nat_helpers.safe_http import PublicAsyncHTTPTransport
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from pydantic import Field, StrictInt

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

logger = logging.getLogger(__name__)

_HTTP_URL_RE = re.compile(r"https?://[^\s<>\]\)\"']+", re.IGNORECASE)
_URL_FIELD_NAMES = ("url", "link", "href", "source_url", "input_message")
_TRAILING_URL_PUNCTUATION = ".,;:"

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

_BROWSER_HEADERS = {
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

# Cap on redirect hops we will manually follow while re-validating each target.
_MAX_REDIRECTS = 10

# Default schemes accepted for fetched (including redirected) URLs.
_ALLOWED_FETCH_SCHEMES = ("https", "http")

_HTTPX_TIMEOUT = httpx.Timeout(20.0, connect=5.0, read=15.0, write=5.0, pool=5.0)
_HTTPX_RETRY_ATTEMPTS = 2
_HTTPX_RETRY_BACKOFF_SECONDS = 0.35
_HTTPX_RETRY_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
_HTTPX_BLOCKED_STATUS_CODES = {401, 403, 407, 451}
_HTML_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}
_RETRYABLE_HTTPX_EXCEPTIONS = tuple(
    exc_type
    for exc_type in (
        getattr(httpx, "TimeoutException", None),
        getattr(httpx, "TransportError", None),
        getattr(httpx, "NetworkError", None),
        getattr(httpx, "RemoteProtocolError", None),
        getattr(httpx, "ProxyError", None),
    )
    if isinstance(exc_type, type)
)


class WebscrapeFunctionConfig(ToolConfig, name="webscrape"):
    """Configuration for the webscrape function."""

    description: str | None = None
    enable_research_mode: bool = Field(
        default=False,
        description="Expose experimental archived research excerpts and exact retrieval.",
    )
    max_concurrency: StrictInt = Field(
        default=1,
        ge=1,
        le=8,
        description="Maximum simultaneous scrapes across runs sharing this tool.",
    )

    user_agent: str = Field(
        default="daedalus-webscraper/1.0",
        description="User-Agent header for robots.txt checking.",
    )
    respect_robots_txt: bool = Field(
        default=True,
        description="Honor robots.txt directives before scraping content.",
    )
    allowed_schemes: list[str] = Field(
        default_factory=lambda: ["https", "http"],
        description="URL schemes permitted for scraping.",
    )
    max_output_tokens: int = Field(
        default=64000,
        ge=100,
        le=128000,
        description=(
            "Maximum number of tokens in the output markdown. "
            "Content will be truncated if it exceeds this limit."
        ),
    )
    truncation_message: str = Field(
        default="\n\n---\n\n_**Note:** Content truncated to fit within token limit._",
        description="Message appended when content is truncated due to token limits.",
    )
    timeout: float = Field(
        default=30.0,
        ge=5.0,
        le=120.0,
        description="Timeout in seconds for the controlled HTTP fetch.",
    )


# ---------------------------------------------------------------------------
# Token counting & truncation
# ---------------------------------------------------------------------------


def _format_error(message: str) -> str:
    return f"Error: {message}"


def _count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    if not TIKTOKEN_AVAILABLE:
        return len(text) // 4
    try:
        encoding = tiktoken.get_encoding(encoding_name)
        return len(encoding.encode(text))
    except Exception as exc:
        logger.warning(
            "Failed to count tokens with tiktoken: %s. Using approximation.", exc
        )
        return len(text) // 4


def _truncate_to_token_limit(
    text: str,
    token_limit: int,
    truncation_msg: str,
    encoding_name: str = "cl100k_base",
) -> tuple[str, bool]:
    token_count = _count_tokens(text, encoding_name)
    if token_count <= token_limit:
        return text, False

    left, right = 0, len(text)
    truncation_msg_tokens = _count_tokens(truncation_msg, encoding_name)
    target_tokens = token_limit - truncation_msg_tokens

    while left < right:
        mid = (left + right + 1) // 2
        if _count_tokens(text[:mid], encoding_name) <= target_tokens:
            left = mid
        else:
            right = mid - 1

    truncated = text[:left]

    last_para = truncated.rfind("\n\n")
    if last_para > len(truncated) * 0.8:
        truncated = truncated[:last_para]
    else:
        for sep in [". ", "! ", "? ", "\n"]:
            last_sep = truncated.rfind(sep)
            if last_sep > len(truncated) * 0.9:
                truncated = truncated[: last_sep + 1]
                break

    return truncated + truncation_msg, True


# ---------------------------------------------------------------------------
# Content validation
# ---------------------------------------------------------------------------


def _is_valid_content(markdown: str) -> bool:
    """Return True if the markdown contains meaningful page content."""
    if not markdown:
        return False

    body = markdown
    source_idx = markdown.find("_Source: ")
    if source_idx >= 0:
        end_idx = markdown.find("\n\n", source_idx)
        if end_idx >= 0:
            body = markdown[end_idx:].strip()

    if len(body) < 50:
        return False

    return not _is_challenge_page(body)


# ---------------------------------------------------------------------------
# Shared HTML → markdown conversion
# ---------------------------------------------------------------------------


def _resource_suffix(url: str, content_type: str) -> str:
    """Choose a bounded file suffix so MarkItDown can select a local converter."""
    media_type = content_type.split(";", 1)[0].strip().lower()
    guessed = mimetypes.guess_extension(media_type) if media_type else None
    path_suffix = os.path.splitext(urlparse(url).path)[1].lower()
    candidate = guessed or path_suffix or ".bin"
    if not re.fullmatch(r"\.[a-z0-9]{1,10}", candidate):
        return ".bin"
    return candidate


def _bytes_to_markdown(
    content: bytes,
    url: str,
    *,
    content_type: str = "",
    token_limit: int | None = None,
    truncation_msg: str = "",
) -> str:
    """Convert already-fetched bytes without giving MarkItDown network access."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            suffix=_resource_suffix(url, content_type), delete=False
        ) as file_obj:
            file_obj.write(content)
            tmp_path = file_obj.name

        result = MarkItDown(enable_plugins=True).convert(tmp_path)
        title_text = result.title or url
        full_content = f"# {title_text}\n\n_Source: {url}_\n\n" + (
            result.text_content or ""
        )
        if token_limit is not None:
            full_content, was_truncated = _truncate_to_token_limit(
                full_content, token_limit, truncation_msg
            )
            if was_truncated:
                logger.info("Content from %s truncated to %d tokens", url, token_limit)
        return full_content
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _convert_fetched_resource(
    content: bytes,
    url: str,
    content_type: str,
    *,
    html: bool,
    token_limit: int | None = None,
    truncation_msg: str = "",
) -> str:
    """Convert already-fetched bytes locally; converters never receive a URL.

    HTML uses the shared article converter, as webscrape_tool does, so its
    charset comes from the original bytes and HTML declarations. Decoding to
    text first would replace legacy-encoded characters before conversion.
    """
    markdown = _convert_html_article(content, url) if html else None
    if markdown is None:
        return _bytes_to_markdown(
            content,
            url,
            # Sniffed HTML may lack a media type; keep an HTML local suffix.
            content_type="text/html" if html else content_type,
            token_limit=token_limit,
            truncation_msg=truncation_msg,
        )
    if token_limit is not None:
        markdown, was_truncated = _truncate_to_token_limit(
            markdown, token_limit, truncation_msg
        )
        if was_truncated:
            logger.info("Content from %s truncated to %d tokens", url, token_limit)
    return markdown


# ---------------------------------------------------------------------------
# Redirect-safe fetch
# ---------------------------------------------------------------------------


async def _get_following_safe_redirects(
    client: httpx.AsyncClient,
    url: str,
    *,
    allowed_schemes: list[str] | None = None,
    max_redirects: int = _MAX_REDIRECTS,
    retry_attempts: int = 0,
    retry_backoff_seconds: float = _HTTPX_RETRY_BACKOFF_SECONDS,
    retry_status_codes: Iterable[int] | None = None,
) -> httpx.Response:
    """GET *url*, manually following redirects after SSRF-validating each hop.

    The supplied *client* must be configured with ``follow_redirects=False`` so
    redirects surface here; every redirect target is checked with
    ``validate_public_url`` before it is fetched, closing the
    ``https://attacker.com -> http://169.254.169.254/`` bypass. Raises
    ``UnsafeURLError`` if any hop targets a non-public address or disallowed
    scheme. Optional retries restart from the original URL and are limited to
    transient transport failures or explicitly supplied HTTP status codes.
    """
    retry_status_set = set(retry_status_codes or ())
    last_exc: Exception | None = None

    for attempt in range(retry_attempts + 1):
        try:
            current_url = url
            for _ in range(max_redirects + 1):
                response = await client.get(current_url)
                if not response.is_redirect:
                    if (
                        response.status_code in retry_status_set
                        and attempt < retry_attempts
                    ):
                        await asyncio.sleep(retry_backoff_seconds * (2**attempt))
                        break
                    return response

                location = response.headers.get("location")
                if not location:
                    return response

                next_url = urljoin(current_url, location)
                await asyncio.to_thread(
                    validate_public_url,
                    next_url,
                    allowed_schemes=allowed_schemes or list(_ALLOWED_FETCH_SCHEMES),
                    check_dns=True,
                )
                current_url = next_url
            else:
                raise UnsafeURLError(
                    f"Exceeded maximum of {max_redirects} redirects while "
                    f"fetching '{url}'."
                )
        except _RETRYABLE_HTTPX_EXCEPTIONS as exc:
            last_exc = exc
            if attempt >= retry_attempts:
                raise
            await asyncio.sleep(retry_backoff_seconds * (2**attempt))

    if last_exc is not None:
        raise last_exc

    raise UnsafeURLError(
        f"Exceeded maximum of {max_redirects} redirects while fetching '{url}'."
    )


# ---------------------------------------------------------------------------
# Controlled fetch used by source verification
# ---------------------------------------------------------------------------


def _httpx_timeout_from_seconds(timeout_seconds: float):
    short_timeout = min(5.0, timeout_seconds)
    return httpx.Timeout(
        timeout_seconds,
        connect=short_timeout,
        read=timeout_seconds,
        write=short_timeout,
        pool=short_timeout,
    )


def _response_looks_like_html(response: httpx.Response) -> bool:
    content_type = response.headers.get("content-type", "")
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type in _HTML_CONTENT_TYPES:
        return True
    if media_type:
        return False

    content = getattr(response, "content", b"") or b""
    if isinstance(content, bytes):
        prefix = content[:512].lstrip().lower()
        return prefix.startswith((b"<!doctype html", b"<html"))
    return False


async def _scrape_with_httpx_result(
    url: str,
    token_limit: int | None = None,
    truncation_msg: str = "",
    allowed_schemes: list[str] | None = None,
    timeout=_HTTPX_TIMEOUT,
) -> tuple[str | None, str]:
    """Fetch and convert via httpx, returning ``(markdown, outcome)``.

    Outcomes are intentionally simple strings so callers can choose a fallback
    without parsing log messages: ``ok``, ``blocked``, ``non_html``,
    ``http_error``, or ``invalid``.
    """
    headers = {**_BROWSER_HEADERS, "User-Agent": _BROWSER_USER_AGENT}
    # follow_redirects=False so _get_following_safe_redirects can SSRF-validate
    # every hop before following it (F-002a).
    async with httpx.AsyncClient(
        headers=headers,
        follow_redirects=False,
        timeout=timeout,
        transport=PublicAsyncHTTPTransport(),
        trust_env=False,
    ) as client:
        response = await _get_following_safe_redirects(
            client,
            url,
            allowed_schemes=allowed_schemes,
            retry_attempts=_HTTPX_RETRY_ATTEMPTS,
            retry_status_codes=_HTTPX_RETRY_STATUS_CODES,
        )

    if response.status_code in _HTTPX_BLOCKED_STATUS_CODES:
        logger.info(
            "httpx returned blocked status %d for %s", response.status_code, url
        )
        return None, "blocked"

    if not response.is_success:
        logger.info("httpx returned status %d for %s", response.status_code, url)
        return None, "http_error"

    html = _response_looks_like_html(response)
    # Challenge signatures are ASCII, so lossy decoding cannot hide them.
    if html and _is_challenge_page(response.text):
        logger.info("httpx response for %s is a challenge page", url)
        return None, "blocked"

    markdown = await asyncio.to_thread(
        _convert_fetched_resource,
        response.content,
        url,
        response.headers.get("content-type", ""),
        html=html,
        token_limit=token_limit,
        truncation_msg=truncation_msg,
    )
    if not _is_valid_content(markdown):
        return markdown, "invalid"

    return markdown, "ok"


# ---------------------------------------------------------------------------
# URL validation & robots.txt
# ---------------------------------------------------------------------------


async def _check_robots(
    *,
    url: str,
    parsed_url: ParseResult,
    client: httpx.AsyncClient,
    user_agent: str,
    allowed_schemes: list[str] | None = None,
) -> None:
    robots_url = urljoin(f"{parsed_url.scheme}://{parsed_url.netloc}", "/robots.txt")
    try:
        # Manually follow redirects so each hop is SSRF-validated (F-002a); the
        # client is configured with follow_redirects=False at the call site.
        response = await _get_following_safe_redirects(
            client, robots_url, allowed_schemes=allowed_schemes
        )
    except UnsafeURLError as exc:
        logger.warning(
            "robots.txt fetch for %s redirected to an unsafe target: %s",
            robots_url,
            exc,
        )
        raise PermissionError(
            "robots.txt redirected to a disallowed target; scraping is not permitted."
        ) from exc
    except httpx.RequestError as exc:
        logger.warning("Failed to retrieve robots.txt from %s: %s", robots_url, exc)
        return

    if response.status_code in {401, 403}:
        raise PermissionError("Access to robots.txt denied; scraping is not permitted.")

    if response.status_code >= 500:
        logger.warning(
            "Robots.txt request for %s returned %s; proceeding optimistically.",
            robots_url,
            response.status_code,
        )
        return

    if response.status_code == 404:
        return

    robots_parser = RobotFileParser()
    robots_parser.parse(response.text.splitlines())

    if not robots_parser.can_fetch(user_agent, url):
        raise PermissionError(
            "robots.txt disallows accessing this URL with the configured user agent."
        )


def _extract_url_candidate(url_candidate: str) -> str:
    normalized_url = url_candidate.strip()
    if not normalized_url:
        raise ValueError("No URL supplied.")

    try:
        parsed_json = json.loads(normalized_url)
    except json.JSONDecodeError:
        parsed_json = None

    if isinstance(parsed_json, dict):
        for field_name in _URL_FIELD_NAMES:
            field_value = parsed_json.get(field_name)
            if isinstance(field_value, str) and field_value.strip():
                return field_value.strip()
    elif isinstance(parsed_json, str) and parsed_json.strip():
        return parsed_json.strip()

    match = _HTTP_URL_RE.search(normalized_url)
    if match:
        return match.group(0).rstrip(_TRAILING_URL_PUNCTUATION)

    if normalized_url.startswith("<") and normalized_url.endswith(">"):
        normalized_url = normalized_url[1:-1].strip()

    return normalized_url


def _validate_url(
    url_candidate: str, allowed_schemes: list[str]
) -> tuple[str, ParseResult]:
    if not url_candidate:
        raise ValueError("No URL supplied.")

    normalized_url = _extract_url_candidate(url_candidate)
    parsed = urlparse(normalized_url)

    if normalized_url.startswith("//"):
        normalized_url = f"https:{normalized_url}"
        parsed = urlparse(normalized_url)
    elif not parsed.scheme:
        normalized_url = f"https://{normalized_url}"
        parsed = urlparse(normalized_url)

    if not parsed.scheme or parsed.scheme.lower() not in {
        scheme.lower() for scheme in allowed_schemes
    }:
        raise ValueError("URL scheme is not allowed.")
    if not parsed.netloc:
        raise ValueError("URL is missing a host.")

    return normalized_url, parsed


# ---------------------------------------------------------------------------
# Main registered function
# ---------------------------------------------------------------------------


@register_tool(config_type=WebscrapeFunctionConfig)
async def webscrape_function(config: WebscrapeFunctionConfig, builder: ToolRegistry):
    slots = asyncio.Semaphore(config.max_concurrency)
    async with public_content_session(builder) as content_session:
        async with AnonymousPublicClient(
            headers={"User-Agent": config.user_agent},
            follow_redirects=False,
            timeout=_httpx_timeout_from_seconds(config.timeout),
            transport=PublicAsyncHTTPTransport(),
            trust_env=False,
        ) as robots_client:

            async def _fetch_response(url: str, output_mode: str) -> str:
                """Return markdown from a bounded, anonymous public URL fetch."""
                try:
                    url, parsed_url = _validate_url(url.strip(), config.allowed_schemes)
                    if (
                        parsed_url.username is not None
                        or parsed_url.password is not None
                    ):
                        raise UnsafeURLError(
                            "Anonymous public URLs cannot contain credentials"
                        )
                    # Literal/scheme rejection is immediate; DNS is validated by
                    # the pinned transport on misses without blocking this loop.
                    validate_public_url(
                        url, allowed_schemes=config.allowed_schemes, check_dns=False
                    )
                except (AttributeError, ValueError, UnsafeURLError) as exc:
                    return _format_error(str(exc))

                if config.respect_robots_txt:
                    try:
                        with phase_timing("daedalus.webscrape.robots"):
                            await _check_robots(
                                url=url,
                                parsed_url=parsed_url,
                                client=robots_client,
                                user_agent=config.user_agent,
                                allowed_schemes=config.allowed_schemes,
                            )
                    except (PermissionError, UnsafeURLError) as exc:
                        return _format_error(str(exc))

                try:
                    article, cache_status = await content_session.article(
                        url,
                        converter=lambda content, source, content_type: (
                            _bytes_to_markdown(
                                content, source, content_type=content_type
                            )
                        ),
                        timeout=config.timeout,
                        allowed_schemes=config.allowed_schemes,
                    )
                    if _is_challenge_page(article.markdown):
                        return _format_error("The site is blocking automated access.")
                    source = f"_Source: {article.url}_"
                    content = article.markdown.replace(
                        source,
                        source
                        + f"\n_Fetched: {article.fetched_at}; cache: {cache_status}_",
                        1,
                    )
                    if output_mode == "research":
                        # Archive the complete converted source before the runtime
                        # chooses excerpts. Full/document mode keeps its old limit.
                        return json.dumps(
                            {
                                "success": True,
                                "output_mode": "research",
                                "source": {
                                    "url": article.url,
                                    "fetched_at": article.fetched_at,
                                },
                                "content": content,
                            },
                            ensure_ascii=False,
                        )
                    # Token-limit search repeatedly tokenizes up to the whole
                    # article (and tiktoken may load its encoding on first
                    # use); keep that CPU work off the shared event loop.
                    truncated, _ = await asyncio.to_thread(
                        _truncate_to_token_limit,
                        content,
                        config.max_output_tokens,
                        config.truncation_message,
                    )
                    return truncated
                except UnsafeURLError as exc:
                    return _format_error(str(exc))
                except Exception as exc:
                    logger.info(
                        "Public article retrieval failed: %s", type(exc).__name__
                    )
                    return _format_error(
                        "Unable to retrieve page content. The site may require "
                        "JavaScript or is blocking automated access."
                    )

            async def _research_response_fn(
                url: str, output_mode: Literal["full", "research"] = "full"
            ) -> str:
                """Scrape public content within the shared tool concurrency limit."""
                async with slots:
                    return await _fetch_response(url, output_mode)

            async def _response_fn(url: str) -> str:
                """Scrape public content within the shared tool concurrency limit."""
                return await _research_response_fn(url)

            research_description = (
                " Use output_mode=research for article research: the complete "
                "converted source can be archived with retrievable excerpts. "
                "Retrieve omitted context before making claims; a preview cannot "
                "establish absence. Use full (default) for code, documents or "
                "verbatim reading."
                if config.enable_research_mode
                else ""
            )
            yield ToolDefinition.from_fn(
                _research_response_fn if config.enable_research_mode else _response_fn,
                description=config.description
                or (
                    "Scrape public web content and convert to markdown with source "
                    "URL and fetch time. Uses bounded anonymous article caching and "
                    "connection-time public DNS validation; document converters only "
                    "receive local response files." + research_description
                ),
            )
