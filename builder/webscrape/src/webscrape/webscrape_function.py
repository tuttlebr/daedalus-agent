import asyncio
import logging
import os
import tempfile
from urllib.parse import ParseResult, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from markitdown import MarkItDown
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
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
    "Accept-Encoding": "gzip, deflate, br",
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
]

_CHALLENGE_TITLE_MARKERS = [
    "just a moment",
    "attention required",
    "checking your browser",
    "one more step",
    "access denied",
    "please wait",
]


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


# ---------------------------------------------------------------------------
# Token counting & truncation
# ---------------------------------------------------------------------------


def _format_error(message: str) -> str:
    return f"**Scrape failed:** {message}"


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
    text: str, max_tokens: int, truncation_msg: str, encoding_name: str = "cl100k_base"
) -> tuple[str, bool]:
    token_count = _count_tokens(text, encoding_name)
    if token_count <= max_tokens:
        return text, False

    left, right = 0, len(text)
    truncation_msg_tokens = _count_tokens(truncation_msg, encoding_name)
    target_tokens = max_tokens - truncation_msg_tokens

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
    max_tokens: int | None = None,
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

        if max_tokens is not None:
            full_content, was_truncated = _truncate_to_token_limit(
                full_content, max_tokens, truncation_msg
            )
            if was_truncated:
                logger.info("Content from %s truncated to %d tokens", url, max_tokens)

        return full_content
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Scraping strategies (ordered from fastest to most capable)
# ---------------------------------------------------------------------------


def _scrape_with_markitdown(
    url: str, max_tokens: int | None = None, truncation_msg: str = ""
) -> str:
    """Strategy 1: direct MarkItDown URL conversion (fastest, no JS support)."""
    md = MarkItDown(enable_plugins=True)
    result = md.convert(url)

    title_text = result.title if result.title else url
    header = f"# {title_text}\n\n_Source: {url}_\n\n"
    full_content = header + (result.text_content or "")

    if max_tokens is not None:
        full_content, was_truncated = _truncate_to_token_limit(
            full_content, max_tokens, truncation_msg
        )
        if was_truncated:
            logger.info("Content from %s truncated to %d tokens", url, max_tokens)

    return full_content


async def _scrape_with_httpx(
    url: str, max_tokens: int | None = None, truncation_msg: str = ""
) -> str | None:
    """Strategy 2: httpx with browser-like headers (handles simple UA checks)."""
    headers = {**_BROWSER_HEADERS, "User-Agent": _BROWSER_USER_AGENT}
    async with httpx.AsyncClient(
        headers=headers, follow_redirects=True, timeout=30.0
    ) as client:
        response = await client.get(url)

    if not response.is_success:
        logger.info("httpx returned status %d for %s", response.status_code, url)
        return None

    html = response.text
    if _is_challenge_page(html):
        logger.info("httpx response for %s is a challenge page", url)
        return None

    return await asyncio.to_thread(
        _html_to_markdown,
        html,
        url,
        max_tokens=max_tokens,
        truncation_msg=truncation_msg,
    )


async def _scrape_with_browser(
    url: str,
    max_tokens: int | None = None,
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
        max_tokens=max_tokens,
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
) -> None:
    robots_url = urljoin(f"{parsed_url.scheme}://{parsed_url.netloc}", "/robots.txt")
    try:
        response = await client.get(robots_url)
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


def _validate_url(
    url_candidate: str, allowed_schemes: list[str]
) -> tuple[str, ParseResult]:
    if not url_candidate:
        raise ValueError("No URL supplied.")

    normalized_url = url_candidate.strip()
    if "//" not in normalized_url:
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

    async def _response_fn(input_message: str) -> str:
        """Scrape a URL and return its content as markdown.

        Three strategies are tried in order, escalating when the prior one
        fails or returns a bot-protection challenge page:
          1. MarkItDown direct conversion (fastest, no JS)
          2. httpx with browser-like headers (fast, bypasses simple UA checks)
          3. Headless Chromium via Playwright (handles JS & Cloudflare challenges)
        """
        try:
            sanitized_input = input_message.strip()
        except AttributeError:
            return _format_error("Input must be a URL string.")

        try:
            url, parsed_url = _validate_url(sanitized_input, config.allowed_schemes)
        except ValueError as exc:
            logger.info("URL validation failed for '%s': %s", sanitized_input, exc)
            return _format_error(str(exc))

        if config.respect_robots_txt:
            try:
                async with httpx.AsyncClient(
                    headers=headers, follow_redirects=True
                ) as client:
                    await _check_robots(
                        url=url,
                        parsed_url=parsed_url,
                        client=client,
                        user_agent=config.user_agent,
                    )
            except PermissionError as exc:
                logger.info("robots.txt disallowed scraping for %s: %s", url, exc)
                return _format_error(str(exc))

        # --- Strategy 1: MarkItDown direct conversion ---
        markdown_output = None
        try:
            markdown_output = await asyncio.to_thread(
                _scrape_with_markitdown,
                url,
                max_tokens=config.max_output_tokens,
                truncation_msg=config.truncation_message,
            )
        except Exception as exc:
            logger.info("MarkItDown scraping failed for %s: %s", url, exc)

        if markdown_output and _is_valid_content(markdown_output):
            return markdown_output

        if markdown_output:
            logger.info(
                "MarkItDown output for %s appears to be a challenge page; "
                "escalating to fallback strategies",
                url,
            )

        # --- Strategy 2: httpx with browser-like headers ---
        try:
            httpx_output = await _scrape_with_httpx(
                url,
                max_tokens=config.max_output_tokens,
                truncation_msg=config.truncation_message,
            )
            if httpx_output and _is_valid_content(httpx_output):
                return httpx_output
        except Exception as exc:
            logger.info("httpx scraping failed for %s: %s", url, exc)

        # --- Strategy 3: Headless browser via Playwright ---
        if config.use_browser_fallback:
            if not PLAYWRIGHT_AVAILABLE:
                logger.warning(
                    "Browser fallback enabled but playwright is not installed; "
                    "install with: pip install playwright && playwright install chromium"
                )
            else:
                try:
                    browser_output = await _scrape_with_browser(
                        url,
                        max_tokens=config.max_output_tokens,
                        truncation_msg=config.truncation_message,
                        timeout=config.browser_timeout,
                    )
                    if browser_output and _is_valid_content(browser_output):
                        return browser_output
                except Exception as exc:
                    logger.warning("Browser scraping failed for %s: %s", url, exc)

        if markdown_output:
            return markdown_output
        return _format_error(
            "Unable to retrieve page content. The site may require JavaScript "
            "or is blocking automated access."
        )

    try:
        yield FunctionInfo.from_fn(
            _response_fn,
            description=(
                "Scrape web content from URLs and convert to clean markdown. "
                "Uses a fast direct approach first, with automatic fallback to "
                "browser-like headers and a headless browser for sites with "
                "JavaScript rendering or bot protection."
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up webscrape workflow.")
