import asyncio
import json
import logging
import mimetypes
import os
import re
import tempfile
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
from nat_helpers.public_content import (
    AnonymousPublicClient,
    ArticleChallengeError,
    EmptyArticleError,
)
from nat_helpers.public_content import is_challenge_page as _is_challenge_page
from nat_helpers.public_content import public_content_session
from nat_helpers.safe_http import PublicAsyncHTTPTransport, ResponseSizeError
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from pydantic import Field, StrictInt

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

logger = logging.getLogger(__name__)

# Embedded URLs may contain parentheses and apostrophes; _trim_embedded_url
# removes only unbalanced closing parentheses and trailing prose punctuation.
_HTTP_URL_RE = re.compile(r"https?://[^\s<>\]\"]+", re.IGNORECASE)
_URL_FIELD_NAMES = ("url", "link", "href", "source_url", "input_message")
_TRAILING_URL_PUNCTUATION = ".,;:"

# Cap on redirect hops we will manually follow while re-validating each target.
_MAX_REDIRECTS = 10

# Default schemes accepted for fetched (including redirected) URLs.
_ALLOWED_FETCH_SCHEMES = ("https", "http")

# Status codes reported as the site denying anonymous automated access.
_ACCESS_DENIED_STATUS_CODES = frozenset({401, 403, 407, 451})


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
        # Page text such as "<|endoftext|>" is content, not a control token.
        return len(encoding.encode(text, disallowed_special=()))
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
        return f"# {title_text}\n\n_Source: {url}_\n\n" + (result.text_content or "")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _convert_public_resource(content: bytes, url: str, content_type: str) -> str:
    """Convert an already-fetched non-HTML public resource from a local file.

    ``PublicContentSession`` converts HTML with its shared article converter
    and calls this for other media. Every tool sharing the session cache uses
    this converter, so a cached article does not depend on which tool fetched
    it first.
    """
    return _bytes_to_markdown(content, url, content_type=content_type)


# ---------------------------------------------------------------------------
# Redirect-safe fetch (robots.txt)
# ---------------------------------------------------------------------------


async def _get_following_safe_redirects(
    client: httpx.AsyncClient,
    url: str,
    *,
    allowed_schemes: list[str] | None = None,
    max_redirects: int = _MAX_REDIRECTS,
) -> httpx.Response:
    """GET *url*, manually following redirects after SSRF-validating each hop.

    The supplied *client* must be configured with ``follow_redirects=False`` so
    redirects surface here; every redirect target is checked with
    ``validate_public_url`` before it is fetched, closing the
    ``https://attacker.com -> http://169.254.169.254/`` bypass. Raises
    ``UnsafeURLError`` if any hop targets a non-public address or disallowed
    scheme.
    """
    current_url = url
    for _ in range(max_redirects + 1):
        response = await client.get(current_url)
        if not response.is_redirect:
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

    raise UnsafeURLError(
        f"Exceeded maximum of {max_redirects} redirects while fetching '{url}'."
    )


def _httpx_timeout_from_seconds(timeout_seconds: float):
    short_timeout = min(5.0, timeout_seconds)
    return httpx.Timeout(
        timeout_seconds,
        connect=short_timeout,
        read=timeout_seconds,
        write=short_timeout,
        pool=short_timeout,
    )


# ---------------------------------------------------------------------------
# Shared article retrieval failures
# ---------------------------------------------------------------------------

RetrievalFailureKind = Literal[
    "unsafe",
    "too_large",
    "blocked",
    "http_status",
    "timeout",
    "connection",
    "no_content",
    "failed",
]


def _describe_retrieval_failure(
    exc: BaseException, timeout: float
) -> tuple[RetrievalFailureKind, str]:
    """Classify a ``PublicContentSession.article`` failure for the caller.

    The generic JavaScript/blocking explanation is reserved for failures that
    have no more specific cause; a 404, a timeout, or an empty document must
    not be reported as the site blocking automated access.
    """
    if isinstance(exc, ResponseSizeError):
        return "too_large", str(exc)
    if isinstance(exc, UnsafeURLError):
        return "unsafe", str(exc)
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        reason = exc.response.reason_phrase or "error"
        if status in _ACCESS_DENIED_STATUS_CODES:
            return (
                "blocked",
                f"The site returned HTTP {status} ({reason}) and is blocking "
                "automated access.",
            )
        return "http_status", f"The site returned HTTP {status} ({reason})."
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)):
        return (
            "timeout",
            f"The site did not respond in time (timeout {timeout:g}s).",
        )
    if isinstance(exc, httpx.TransportError):
        return (
            "connection",
            f"Could not connect to the site ({type(exc).__name__}).",
        )
    if isinstance(exc, ArticleChallengeError):
        return "blocked", "The site is blocking automated access."
    if isinstance(exc, EmptyArticleError):
        return "no_content", "The page returned no extractable content."
    return (
        "failed",
        "Unable to retrieve page content. The site may require JavaScript or "
        "is blocking automated access.",
    )


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


def _is_complete_http_url(candidate: str) -> bool:
    """Return whether *candidate* is exactly one absolute HTTP(S) URL."""
    if any(character.isspace() for character in candidate):
        return False
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return False
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def _trim_embedded_url(url: str) -> str:
    """Remove prose delimiters that follow a URL embedded in surrounding text.

    Parentheses and apostrophes are valid URL characters (for example
    ``/wiki/Python_(programming_language)``). Only a closing parenthesis
    without a matching opening one, such as a Markdown link's ``)``, is
    treated as a delimiter.
    """
    while True:
        trimmed = url.rstrip(_TRAILING_URL_PUNCTUATION).rstrip("'")
        if trimmed.endswith(")") and trimmed.count(")") > trimmed.count("("):
            trimmed = trimmed[:-1]
        if trimmed == url:
            return url
        url = trimmed


def _extract_url_candidate(url_candidate: str) -> str:
    normalized_url = url_candidate.strip()
    if not normalized_url:
        raise ValueError("No URL supplied.")

    # A model-supplied URL argument is used exactly as given. Text extraction
    # below is only for URLs wrapped in prose, Markdown, JSON or angle brackets.
    if _is_complete_http_url(normalized_url):
        return normalized_url

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
        return _trim_embedded_url(match.group(0))

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
                        converter=_convert_public_resource,
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
                except Exception as exc:
                    kind, message = _describe_retrieval_failure(exc, config.timeout)
                    logger.info(
                        "Public article retrieval failed (%s): %s",
                        kind,
                        type(exc).__name__,
                    )
                    return _format_error(message)

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
