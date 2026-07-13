import asyncio
import json
import logging
import os
import re
import tempfile
from collections.abc import Iterable
from urllib.parse import ParseResult, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from markitdown import MarkItDown
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from pydantic import Field

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

try:
    from playwright.async_api import async_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

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

# Signatures that indicate a bot-protection / challenge page rather than real content.
# At least 2 must match to flag as a challenge page.
_CHALLENGE_SIGNATURES = [
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
]

_CHALLENGE_TITLE_MARKERS = [
    "just a moment",
    "attention required",
    "checking your browser",
    "one more step",
    "access denied",
    "please wait",
]

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
_MARKITDOWN_FALLBACK_TIMEOUT = 20.0
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


class WebscrapeFunctionConfig(FunctionBaseConfig, name="webscrape"):
    """Configuration for the webscrape function."""

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
    use_browser_fallback: bool = Field(
        default=True,
        description=(
            "Fall back to a headless browser when simple scraping fails "
            "or returns bot-protection pages."
        ),
    )
    browser_timeout: float = Field(
        default=45.0,
        ge=5.0,
        le=120.0,
        description="Timeout in seconds for browser-based scraping.",
    )
    timeout: float = Field(
        default=30.0,
        ge=5.0,
        le=120.0,
        description="Timeout in seconds for non-browser HTTP scraping.",
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


def _is_challenge_page(text: str) -> bool:
    """Return True if *text* (HTML or markdown) looks like a bot-protection page."""
    lower = text[:5000].lower()
    hits = sum(1 for sig in _CHALLENGE_SIGNATURES if sig in lower)
    return hits >= 2


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


def _html_to_markdown(
    html: str,
    url: str,
    title: str | None = None,
    token_limit: int | None = None,
    truncation_msg: str = "",
) -> str:
    """Convert an HTML string to formatted markdown via a temp file + MarkItDown."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            suffix=".html", mode="w", delete=False, encoding="utf-8"
        ) as f:
            f.write(html)
            tmp_path = f.name

        result = MarkItDown(enable_plugins=True).convert(tmp_path)
        title_text = title or result.title or url
        header = f"# {title_text}\n\n_Source: {url}_\n\n"
        full_content = header + (result.text_content or "")

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
                validate_public_url(
                    next_url,
                    allowed_schemes=allowed_schemes or list(_ALLOWED_FETCH_SCHEMES),
                    check_dns=False,
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
# Scraping strategies (ordered from fastest to most capable)
# ---------------------------------------------------------------------------


def _scrape_with_markitdown(
    url: str, token_limit: int | None = None, truncation_msg: str = ""
) -> str:
    """Direct MarkItDown URL conversion fallback."""
    md = MarkItDown(enable_plugins=True)
    result = md.convert(url)

    title_text = result.title if result.title else url
    header = f"# {title_text}\n\n_Source: {url}_\n\n"
    full_content = header + (result.text_content or "")

    if token_limit is not None:
        full_content, was_truncated = _truncate_to_token_limit(
            full_content, token_limit, truncation_msg
        )
        if was_truncated:
            logger.info("Content from %s truncated to %d tokens", url, token_limit)

    return full_content


def _httpx_timeout_from_seconds(timeout_seconds: float):
    short_timeout = min(5.0, timeout_seconds)
    return httpx.Timeout(
        timeout_seconds,
        connect=short_timeout,
        read=timeout_seconds,
        write=short_timeout,
        pool=short_timeout,
    )


async def _scrape_with_markitdown_with_timeout(
    url: str,
    token_limit: int | None = None,
    truncation_msg: str = "",
    timeout: float = _MARKITDOWN_FALLBACK_TIMEOUT,
) -> str:
    return await asyncio.wait_for(
        asyncio.to_thread(
            _scrape_with_markitdown,
            url,
            token_limit=token_limit,
            truncation_msg=truncation_msg,
        ),
        timeout=timeout,
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
        headers=headers, follow_redirects=False, timeout=timeout
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

    if not _response_looks_like_html(response):
        logger.info(
            "httpx response for %s is not HTML (content-type=%s)",
            url,
            response.headers.get("content-type", ""),
        )
        return None, "non_html"

    html = response.text
    if _is_challenge_page(html):
        logger.info("httpx response for %s is a challenge page", url)
        return None, "blocked"

    markdown = await asyncio.to_thread(
        _html_to_markdown,
        html,
        url,
        token_limit=token_limit,
        truncation_msg=truncation_msg,
    )
    if not _is_valid_content(markdown):
        return markdown, "invalid"

    return markdown, "ok"


async def _scrape_with_httpx(
    url: str,
    token_limit: int | None = None,
    truncation_msg: str = "",
    allowed_schemes: list[str] | None = None,
    timeout=_HTTPX_TIMEOUT,
) -> str | None:
    """Strategy 1: httpx with browser-like headers (handles simple UA checks)."""
    markdown, _ = await _scrape_with_httpx_result(
        url,
        token_limit=token_limit,
        truncation_msg=truncation_msg,
        allowed_schemes=allowed_schemes,
        timeout=timeout,
    )
    return markdown


async def _scrape_with_browser(
    url: str,
    token_limit: int | None = None,
    truncation_msg: str = "",
    timeout: float = 45.0,
) -> str | None:
    """Strategy 3: headless Chromium via Playwright (JS rendering + challenge bypass)."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )
        try:
            context = await browser.new_context(
                user_agent=_BROWSER_USER_AGENT,
                viewport={"width": 1920, "height": 1080},
            )
            page = await context.new_page()
            await page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=int(timeout * 1000),
            )

            # Wait for Cloudflare / bot-protection challenges to resolve
            for _ in range(15):
                title = await page.title()
                if not any(s in title.lower() for s in _CHALLENGE_TITLE_MARKERS):
                    break
                await page.wait_for_timeout(2000)

            # Let the network settle so dynamic content finishes loading
            try:
                await page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass  # nosec B110 - networkidle timeout is expected and non-fatal

            # Scroll to bottom to trigger any lazy-loaded content
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(1000)

            title = await page.title()
            html = await page.content()
        finally:
            await browser.close()

    if _is_challenge_page(html):
        logger.warning("Browser scrape of %s still returned a challenge page", url)
        return None

    return await asyncio.to_thread(
        _html_to_markdown,
        html,
        url,
        title=title,
        token_limit=token_limit,
        truncation_msg=truncation_msg,
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


@register_function(config_type=WebscrapeFunctionConfig)
async def webscrape_function(config: WebscrapeFunctionConfig, builder: Builder):
    headers = {"User-Agent": config.user_agent}

    async def _response_fn(url: str) -> str:
        """Scrape a URL and return its content as markdown.

        Three strategies are tried in order, escalating when the prior one
        fails or returns a bot-protection challenge page:
          1. httpx with browser-like headers, timeout, retries, and redirect checks
          2. MarkItDown direct conversion for non-HTML/document fallbacks
          3. Headless Chromium via Playwright (handles JS & Cloudflare challenges)
        """
        try:
            sanitized_input = url.strip()
        except AttributeError:
            return _format_error("Input must be a URL string.")

        try:
            url, parsed_url = _validate_url(sanitized_input, config.allowed_schemes)
        except ValueError as exc:
            logger.info("URL validation failed for '%s': %s", sanitized_input, exc)
            return _format_error(str(exc))

        # F-001: block SSRF-unsafe targets (non-http(s) schemes, literal internal
        # IPs / cloud-metadata) before any fetch strategy runs. The cluster
        # network policy covers the hostname-resolves-to-internal case.
        try:
            validate_public_url(
                url, allowed_schemes=config.allowed_schemes, check_dns=False
            )
        except UnsafeURLError as exc:
            logger.warning("Blocked SSRF-unsafe URL '%s': %s", sanitized_input, exc)
            return _format_error(str(exc))

        if config.respect_robots_txt:
            try:
                # follow_redirects=False so each redirect hop is SSRF-validated
                # inside _check_robots before being followed (F-002a).
                async with httpx.AsyncClient(
                    headers=headers, follow_redirects=False
                ) as client:
                    await _check_robots(
                        url=url,
                        parsed_url=parsed_url,
                        client=client,
                        user_agent=config.user_agent,
                        allowed_schemes=config.allowed_schemes,
                    )
            except PermissionError as exc:
                logger.info("robots.txt disallowed scraping for %s: %s", url, exc)
                return _format_error(str(exc))

        last_nonblocked_output = None
        browser_attempted = False

        async def _try_browser() -> str | None:
            nonlocal browser_attempted
            browser_attempted = True
            if not config.use_browser_fallback:
                return None
            if not PLAYWRIGHT_AVAILABLE:
                logger.warning(
                    "Browser fallback enabled but playwright is not installed; "
                    "install with: pip install playwright && playwright install chromium"
                )
                return None

            try:
                browser_output = await _scrape_with_browser(
                    url,
                    token_limit=config.max_output_tokens,
                    truncation_msg=config.truncation_message,
                    timeout=config.browser_timeout,
                )
                if browser_output and _is_valid_content(browser_output):
                    return browser_output
                if browser_output and not _is_challenge_page(browser_output):
                    return browser_output
            except Exception as exc:
                logger.warning("Browser scraping failed for %s: %s", url, exc)
            return None

        # --- Strategy 1: httpx with browser-like headers ---
        httpx_output = None
        httpx_outcome = "not_attempted"
        try:
            httpx_output, httpx_outcome = await _scrape_with_httpx_result(
                url,
                token_limit=config.max_output_tokens,
                truncation_msg=config.truncation_message,
                allowed_schemes=config.allowed_schemes,
                timeout=_httpx_timeout_from_seconds(config.timeout),
            )
            if httpx_output and _is_valid_content(httpx_output):
                return httpx_output
            if httpx_output and not _is_challenge_page(httpx_output):
                last_nonblocked_output = httpx_output
        except UnsafeURLError as exc:
            logger.warning("Blocked unsafe redirect while scraping %s: %s", url, exc)
            return _format_error(str(exc))
        except Exception as exc:
            logger.info("httpx scraping failed for %s: %s", url, exc)
            httpx_outcome = "error"

        # A 401/403/challenge page is unlikely to be improved by another raw
        # HTTP client. Try the browser before falling back to direct MarkItDown.
        if httpx_outcome == "blocked":
            browser_output = await _try_browser()
            if browser_output:
                return browser_output

        # --- Strategy 2: MarkItDown direct conversion ---
        markdown_output = None
        try:
            markdown_output = await _scrape_with_markitdown_with_timeout(
                url,
                token_limit=config.max_output_tokens,
                truncation_msg=config.truncation_message,
                timeout=min(config.timeout, _MARKITDOWN_FALLBACK_TIMEOUT),
            )
        except TimeoutError:
            logger.info(
                "MarkItDown scraping timed out for %s after %.1fs",
                url,
                _MARKITDOWN_FALLBACK_TIMEOUT,
            )
        except Exception as exc:
            logger.info("MarkItDown scraping failed for %s: %s", url, exc)

        if markdown_output and _is_valid_content(markdown_output):
            return markdown_output

        if markdown_output:
            if not _is_challenge_page(markdown_output):
                last_nonblocked_output = markdown_output
            logger.info(
                "MarkItDown output for %s was not valid page content; "
                "escalating to fallback strategies",
                url,
            )

        # --- Strategy 3: Headless browser via Playwright ---
        if not browser_attempted:
            browser_output = await _try_browser()
            if browser_output:
                return browser_output

        if last_nonblocked_output:
            return last_nonblocked_output

        return _format_error(
            "Unable to retrieve page content. The site may require JavaScript "
            "or is blocking automated access."
        )

    try:
        yield FunctionInfo.from_fn(
            _response_fn,
            description=(
                "Scrape web content from URLs and convert to clean markdown. "
                "Uses a controlled HTTP fetch first, with automatic fallback to "
                "MarkItDown direct conversion and a headless browser for sites "
                "with JavaScript rendering or bot protection."
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up webscrape workflow.")
