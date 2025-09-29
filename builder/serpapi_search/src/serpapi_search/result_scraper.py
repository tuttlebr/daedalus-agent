"""Utility helpers to enrich SerpAPI results with scraped page content."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Optional, Union

import httpx
from markitdown import MarkItDown
from pydantic import BaseModel, Field

from urllib.parse import ParseResult, urljoin, urlparse
from urllib.robotparser import RobotFileParser

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    TIKTOKEN_AVAILABLE = False

logger = logging.getLogger(__name__)

if not logger.handlers:
    # Fallback configuration when module is executed directly
    logging.basicConfig(level=logging.INFO)


if False:  # pragma: no cover - for type checkers only (avoids circular import at runtime)
    from .serpapi_search_function import SearchResult, TopStory


SerpEntry = Union["SearchResult", "TopStory", Mapping[str, object]]


class SerpLinkScraperSettings(BaseModel):
    """Configuration options that mirror the standalone webscrape function."""

    user_agent: str = Field(
        default="daedalus-serp-scraper/1.0",
        description="User-Agent header to use for robots.txt checks and HTTP requests.",
    )
    respect_robots_txt: bool = Field(
        default=True,
        description="Honor robots.txt directives before scraping content.",
    )
    allowed_schemes: list[str] = Field(
        default_factory=lambda: ["https", "http"],
        description="URL schemes that are permitted to be scraped.",
    )
    max_output_tokens: int = Field(
        default=64000,
        ge=100,
        le=128000,
        description="Maximum number of tokens retained in scraped markdown content.",
    )
    truncation_message: str = Field(
        default="\n\n---\n\n_**Note:** Content truncated to fit within token limit._",
        description="Message appended when content is truncated due to the token limit.",
    )
    max_attempts_per_group: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Maximum number of links to try per group (organic or top stories).",
    )


class ScrapeOutcome(BaseModel):
    """Represents the result of attempting to scrape a single SerpAPI link."""

    source_type: str
    link: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    was_truncated: bool = False
    attempts: int = 0
    error: Optional[str] = None


async def scrape_serp_links(
    *,
    organic_entries: Sequence[SerpEntry],
    top_story_entries: Sequence[SerpEntry],
    settings: Optional[SerpLinkScraperSettings] = None,
) -> tuple[ScrapeOutcome, ScrapeOutcome]:
    """Scrape up to one link from organic results and top stories.

    Args:
        organic_entries: Collection of organic result entries returned by SerpAPI.
        top_story_entries: Collection of top story entries returned by SerpAPI.
        settings: Optional configuration overrides.

    Returns:
        Tuple containing outcomes for organic and top story scraping, in that order.
    """

    config = settings or SerpLinkScraperSettings()
    headers = {"User-Agent": config.user_agent}

    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        organic = await _scrape_group(
            entries=organic_entries,
            source_type="organic",
            config=config,
            client=client,
        )
        top_story = await _scrape_group(
            entries=top_story_entries,
            source_type="top_story",
            config=config,
            client=client,
        )

    return organic, top_story


async def _scrape_group(
    *,
    entries: Sequence[SerpEntry],
    source_type: str,
    config: SerpLinkScraperSettings,
    client: httpx.AsyncClient,
) -> ScrapeOutcome:
    outcome = ScrapeOutcome(source_type=source_type)

    attempts = 0
    for entry in entries:
        if attempts >= config.max_attempts_per_group:
            break

        link, title = _extract_link_and_title(entry)
        if not link:
            continue

        attempts += 1

        try:
            normalized_link, parsed_link = _validate_url(link, config.allowed_schemes)
        except ValueError as exc:
            logger.info(
                "Skipping %s link due to validation error: %s",
                source_type,
                exc,
            )
            outcome.error = str(exc)
            continue

        try:
            if config.respect_robots_txt:
                await _check_robots(
                    url=normalized_link,
                    parsed_url=parsed_link,
                    client=client,
                    user_agent=config.user_agent,
                )

            content, truncated = _prepare_markdown(
                url=normalized_link,
                max_tokens=config.max_output_tokens,
                truncation_msg=config.truncation_message,
            )
        except PermissionError as exc:
            logger.info("Robots.txt disallows scraping %s: %s", normalized_link, exc)
            outcome.error = str(exc)
            continue
        except Exception as exc:  # noqa: BLE001 - defensive catch
            logger.exception("Failed to scrape %s: %s", normalized_link, exc)
            outcome.error = str(exc)
            continue

        outcome.link = normalized_link
        outcome.title = title
        outcome.content = content
        outcome.was_truncated = truncated
        outcome.attempts = attempts
        outcome.error = None
        break

    if outcome.content is None:
        outcome.attempts = attempts
        if outcome.error is None:
            outcome.error = "No valid links to scrape."

    return outcome


def _extract_link_and_title(entry: SerpEntry) -> tuple[Optional[str], Optional[str]]:
    link: Optional[str] = None
    title: Optional[str] = None

    if hasattr(entry, "link"):
        link_value = getattr(entry, "link")
        if isinstance(link_value, str):
            link = link_value
    elif isinstance(entry, Mapping):
        possible_link = entry.get("link")
        if isinstance(possible_link, str):
            link = possible_link

    if hasattr(entry, "title"):
        title_value = getattr(entry, "title")
        if isinstance(title_value, str):
            title = title_value
    elif isinstance(entry, Mapping):
        possible_title = entry.get("title")
        if isinstance(possible_title, str):
            title = possible_title

    return link, title


def _validate_url(url_candidate: str, allowed_schemes: list[str]) -> tuple[str, ParseResult]:
    normalized = url_candidate.strip()
    if "//" not in normalized:
        normalized = f"https://{normalized}"

    parsed = urlparse(normalized)
    allowed_lower = {scheme.lower() for scheme in allowed_schemes}

    if not parsed.scheme or parsed.scheme.lower() not in allowed_lower:
        raise ValueError("URL scheme is not allowed.")

    if not parsed.netloc:
        raise ValueError("URL is missing a host.")

    return normalized, parsed


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
    except httpx.RequestError as exc:  # pragma: no cover - network variability
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


def _count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    if not TIKTOKEN_AVAILABLE:
        return len(text) // 4

    try:
        encoding = tiktoken.get_encoding(encoding_name)
        return len(encoding.encode(text))
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Failed to count tokens with tiktoken: %s. Using approximation.", exc)
        return len(text) // 4


def _truncate_to_token_limit(
    text: str,
    max_tokens: int,
    truncation_msg: str,
    encoding_name: str = "cl100k_base",
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
        for separator in [". ", "! ", "? ", "\n"]:
            last_sep = truncated.rfind(separator)
            if last_sep > len(truncated) * 0.9:
                truncated = truncated[: last_sep + 1]
                break

    return truncated + truncation_msg, True


def _prepare_markdown(
    *,
    url: str,
    max_tokens: int,
    truncation_msg: str,
) -> tuple[str, bool]:
    try:
        md = MarkItDown(enable_plugins=True)
        url_markdown = md.convert(url)

        title_text = url_markdown.title if url_markdown.title else url
        header = f"# {title_text}\n\n_Source: {url}_\n\n"
        full_content = header + (url_markdown.text_content or "")

        content, was_truncated = _truncate_to_token_limit(
            full_content,
            max_tokens,
            truncation_msg,
        )
        return content, was_truncated
    except Exception as exc:  # pragma: no cover - defensive catch
        logger.exception("Failed to convert content from %s to markdown: %s", url, exc)
        raise
