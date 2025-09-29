import logging

import httpx
from markitdown import MarkItDown
from pydantic import Field

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

from urllib.parse import ParseResult
from urllib.parse import urljoin
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

try:
    import tiktoken
    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("tiktoken not available. Token limiting will be disabled.")

logger = logging.getLogger(__name__)


class WebscrapeFunctionConfig(FunctionBaseConfig, name="webscrape"):
    """
    Configuration for the webscrape workflow.
    """

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
        default=8000,
        ge=100,
        le=128000,
        description="Maximum number of tokens in the output markdown. Content will be truncated if it exceeds this limit.",
    )
    truncation_message: str = Field(
        default="\n\n---\n\n_**Note:** Content truncated to fit within token limit._",
        description="Message appended when content is truncated due to token limits.",
    )


def _format_error(message: str) -> str:
    return f"**Scrape failed:** {message}"


def _count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    """Count the number of tokens in a text string."""
    if not TIKTOKEN_AVAILABLE:
        # Rough approximation: 1 token per 4 characters
        return len(text) // 4

    try:
        encoding = tiktoken.get_encoding(encoding_name)
        return len(encoding.encode(text))
    except Exception as exc:
        logger.warning("Failed to count tokens with tiktoken: %s. Using approximation.", exc)
        return len(text) // 4


def _truncate_to_token_limit(text: str, max_tokens: int, truncation_msg: str, encoding_name: str = "cl100k_base") -> tuple[str, bool]:
    """Truncate text to fit within token limit.

    Returns:
        tuple[str, bool]: (truncated_text, was_truncated)
    """
    token_count = _count_tokens(text, encoding_name)

    if token_count <= max_tokens:
        return text, False

    # Binary search to find the right truncation point
    left, right = 0, len(text)
    truncation_msg_tokens = _count_tokens(truncation_msg, encoding_name)
    target_tokens = max_tokens - truncation_msg_tokens

    while left < right:
        mid = (left + right + 1) // 2
        if _count_tokens(text[:mid], encoding_name) <= target_tokens:
            left = mid
        else:
            right = mid - 1

    # Find a good breaking point (paragraph or sentence boundary)
    truncated = text[:left]

    # Try to break at paragraph
    last_para = truncated.rfind('\n\n')
    if last_para > len(truncated) * 0.8:  # If we're not losing too much
        truncated = truncated[:last_para]
    else:
        # Try to break at sentence
        for sep in ['. ', '! ', '? ', '\n']:
            last_sep = truncated.rfind(sep)
            if last_sep > len(truncated) * 0.9:
                truncated = truncated[:last_sep + 1]
                break

    return truncated + truncation_msg, True


def _prepare_markdown(url: str, max_tokens: int = None, truncation_msg: str = "") -> str:
    """Convert web content to markdown using markitdown."""
    try:
        md = MarkItDown(enable_plugins=True)
        # Convert URL directly - markitdown handles the HTTP request
        url_markdown = md.convert(url)

        # Extract title, use URL as fallback
        title_text = url_markdown.title if url_markdown.title else url

        # Format the content with title and source
        header = f"# {title_text}\n\n_Source: {url}_\n\n"
        full_content = header + (url_markdown.text_content or "")

        if max_tokens is not None:
            full_content, was_truncated = _truncate_to_token_limit(full_content, max_tokens, truncation_msg)
            if was_truncated:
                logger.info("Content from %s was truncated to fit within %d token limit", url, max_tokens)

        return full_content
    except Exception as exc:
        logger.exception("Failed to convert content from %s to markdown: %s", url, exc)
        raise


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
        raise PermissionError("robots.txt disallows accessing this URL with the configured user agent.")


def _validate_url(url_candidate: str, allowed_schemes: list[str]) -> tuple[str, ParseResult]:
    if not url_candidate:
        raise ValueError("No URL supplied.")

    normalized_url = url_candidate.strip()
    if "//" not in normalized_url:
        normalized_url = f"https://{normalized_url}"

    parsed = urlparse(normalized_url)

    if not parsed.scheme or parsed.scheme.lower() not in {scheme.lower() for scheme in allowed_schemes}:
        raise ValueError("URL scheme is not allowed.")
    if not parsed.netloc:
        raise ValueError("URL is missing a host.")

    return normalized_url, parsed


@register_function(config_type=WebscrapeFunctionConfig)
async def webscrape_function(
    config: WebscrapeFunctionConfig, builder: Builder
):
    # Create client only for robots.txt checking
    headers = {"User-Agent": config.user_agent}
    client = httpx.AsyncClient(headers=headers, follow_redirects=True)

    async def _response_fn(input_message: str) -> str:
        """
        Scrape web content from a URL and convert it to markdown format.

        Args:
            input_message: The URL to scrape (with or without https:// prefix)

        Returns:
            Markdown-formatted content of the webpage or an error message
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
                await _check_robots(
                    url=url,
                    parsed_url=parsed_url,
                    client=client,
                    user_agent=config.user_agent,
                )
            except PermissionError as exc:
                logger.info("robots.txt disallowed scraping for %s: %s", url, exc)
                return _format_error(str(exc))

        # Since markitdown handles the HTTP request internally, we can't easily
        # enforce max_content_length or check content-type beforehand.
        # We'll rely on markitdown's error handling for these cases.
        try:
            markdown_output = _prepare_markdown(
                url,
                max_tokens=config.max_output_tokens,
                truncation_msg=config.truncation_message
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Markdown conversion failed for %s: %s", url, exc)
            return _format_error("Failed to convert page contents to markdown.")

        return markdown_output

    try:
        yield FunctionInfo.from_fn(
            _response_fn,
            description=(
                "Scrape web content from URLs and convert to clean markdown "
                "format using markitdown. Respects robots.txt by default and "
                "supports various content types including HTML, PDFs, and more."
            )
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        await client.aclose()
        logger.info("Cleaning up webscrape workflow.")
