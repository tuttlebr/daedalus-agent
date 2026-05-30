import asyncio
import html
import importlib.util
import logging
import os
import re
from typing import Any

import fastfeedparser
import httpx
from cachetools import TTLCache
from markitdown import MarkItDown
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from pydantic import BaseModel, Field, HttpUrl

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

logger = logging.getLogger(__name__)

HTML_TAG_RE = re.compile(r"<[^>]+>")
WHITESPACE_RE = re.compile(r"\s+")


class RssEntry(BaseModel):
    """RSS feed entry model."""

    title: str
    link: str
    published: str | None = None
    author: str | None = None
    description: str | None = None
    feed_scope: str | None = None
    feed_url: str | None = None


class RssFeedFunctionConfig(FunctionBaseConfig, name="rss_feed"):
    """
    Configuration for RSS feed function with reranking support.

    This function fetches RSS feeds, reranks entries based on user queries,
    and scrapes the top-ranked result.
    """

    # Reranker configuration (required)
    reranker_endpoint: HttpUrl | None = Field(
        default=None, description="The endpoint URL for the reranker service"
    )
    reranker_model: str | None = Field(
        default=None,
        description=(
            "The reranker model to use " "(e.g., 'nvidia/nv-rerankqa-mistral-4b-v3')"
        ),
    )
    reranker_api_key: str | None = Field(
        default=None,
        description=(
            "API key for the reranker service. Can also be set via "
            "NVIDIA_API_KEY env var"
        ),
    )
    reranker_max_passage_tokens: int = Field(
        default=192,
        ge=16,
        le=2048,
        description="Maximum tokens to send per RSS entry to the reranker",
    )
    reranker_max_total_tokens: int = Field(
        default=7000,
        ge=512,
        le=8192,
        description=(
            "Approximate total token budget for reranker query plus passages. "
            "Keep below the NVCF ranking limit."
        ),
    )

    # Cache configuration
    cache_ttl_hours: float = Field(
        default=4.0, description="Cache TTL in hours for RSS feed data"
    )
    cache_backend: str = Field(
        default="memory",
        description="Cache backend type (currently only 'memory' is supported)",
    )

    # Request configuration
    timeout: float = Field(default=30.0, description="Request timeout in seconds")
    user_agent: str = Field(
        default="daedalus-rss-reader/1.0",
        description="User-Agent header for RSS feed requests",
    )
    max_entries: int = Field(
        default=20, description="Maximum number of RSS entries to process"
    )

    # RSS Feed URL configuration
    feed_url: str | None = Field(
        default=None, description="RSS feed URL to monitor and search"
    )
    feeds: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Optional map of feed_scope names to RSS feed URLs. When set, the "
            "tool can search one named feed or all feeds with feed_scope='auto'."
        ),
    )

    # Web scraping configuration
    scrape_max_output_tokens: int = Field(
        default=64000,
        ge=100,
        le=128000,
        description="Maximum number of tokens in scraped content",
    )
    scrape_truncation_message: str = Field(
        default=(
            "\n\n---\n\n" "_**Note:** Content truncated to fit within token limit._"
        ),
        description="Message appended when content is truncated",
    )


class RssSearchRequest(BaseModel):
    """Request model for RSS feed search."""

    query: str = Field(..., description="User query to rerank RSS entries against")
    feed_scope: str = Field(
        "auto",
        description=(
            "Named feed scope to search, or 'auto' to search every configured feed."
        ),
    )
    description: str | None = Field(
        None, description="Optional description of the search"
    )


class RssSearchResponse(BaseModel):
    """Response model for RSS feed search."""

    success: bool
    query: str
    feed_url: str
    feed_scope: str | None = None
    top_result: dict[str, Any] | None = None
    scraped_content: str | None = None
    error: str | None = None
    entries_count: int = 0
    cached: bool = False


def _count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    """Count the number of tokens in a text string."""
    if not TIKTOKEN_AVAILABLE:
        # Fallback: estimate ~4 characters per token
        return len(text) // 4

    try:
        encoding = tiktoken.get_encoding(encoding_name)
        return len(encoding.encode(text, disallowed_special=()))
    except Exception:
        # Fallback if encoding fails
        return len(text) // 4


def truncate_text(text: str, max_tokens: int = 1000) -> str:
    """
    Truncate text to fit within a token limit using tiktoken encoding with fallback to character-based truncation.

    Args:
        text (str): The text to truncate
        max_tokens (int): Maximum number of tokens allowed

    Returns:
        str: Truncated text
    """
    # Attempt to use tiktoken for token-based truncation
    if _can_use_tiktoken():
        try:
            encoder = tiktoken.get_encoding("cl100k_base")
            tokens = encoder.encode(text)

            if len(tokens) <= max_tokens:
                return text

            return encoder.decode(tokens[:max_tokens])
        except Exception as e:
            # Fallback to character-based truncation for any errors
            logger.debug("Failed to use tiktoken for truncation: %s", str(e))

    # Fallback to character-based truncation
    char_limit = max_tokens * 4  # Rough approximation: 1 token ≈ 4 characters
    return text[:char_limit] if len(text) > char_limit else text


def _can_use_tiktoken() -> bool:
    """Check if tiktoken is available."""
    return importlib.util.find_spec("tiktoken") is not None


def _normalize_reranker_text(text: str | None) -> str:
    """Normalize RSS text before it is sent to the reranker."""
    if not text:
        return ""
    text = html.unescape(text)
    text = HTML_TAG_RE.sub(" ", text)
    return WHITESPACE_RE.sub(" ", text).strip()


def _reranker_error_message(response: httpx.Response) -> str:
    """Build a useful, bounded reranker HTTP error message."""
    body = response.text.strip()
    if body:
        body = WHITESPACE_RE.sub(" ", body)
        body = body[:1000]
        return f"Reranker request failed with HTTP {response.status_code}: {body}"
    return f"Reranker request failed with HTTP {response.status_code}"


def _reranker_passage_token_limit(
    query: str,
    entry_count: int,
    max_passage_tokens: int,
    max_total_tokens: int,
) -> int:
    """Choose a per-passage token cap that keeps the total request bounded."""
    if entry_count <= 0:
        return max_passage_tokens

    query_tokens = _count_tokens(query)
    # Leave room for JSON framing and reranker prompt overhead.
    available = max_total_tokens - query_tokens - 256
    dynamic_limit = max(16, available // entry_count)
    return max(16, min(max_passage_tokens, dynamic_limit))


def _build_reranker_passages(
    query: str,
    entries: list[RssEntry],
    max_passage_tokens: int,
    max_total_tokens: int,
) -> tuple[list[dict[str, str]], list[int]]:
    """Create compact reranker passages and their original entry indexes."""
    token_limit = _reranker_passage_token_limit(
        query=query,
        entry_count=len(entries),
        max_passage_tokens=max_passage_tokens,
        max_total_tokens=max_total_tokens,
    )
    passages: list[dict[str, str]] = []
    entry_indexes: list[int] = []

    for index, entry in enumerate(entries):
        title = _normalize_reranker_text(entry.title)
        description = _normalize_reranker_text(entry.description)

        parts = []
        if title:
            parts.append(f"Title: {title}")
        if description and description != title:
            parts.append(f"Summary: {description}")
        if entry.feed_scope:
            parts.append(f"Feed: {entry.feed_scope}")
        if entry.published:
            parts.append(f"Published: {_normalize_reranker_text(entry.published)}")

        passage_text = truncate_text("\n".join(parts), token_limit).strip()
        if not passage_text:
            continue

        passages.append({"text": passage_text})
        entry_indexes.append(index)

    return passages, entry_indexes


def _scrape_content(url: str, max_tokens: int, truncation_msg: str) -> tuple[str, bool]:
    """Scrape content from URL using markitdown."""
    # F-001: feed-supplied links are attacker-influenceable. Reject non-http(s)
    # schemes (blocks file:// local-file reads) and literal internal IPs before
    # handing the URL to MarkItDown. The cluster network policy covers the
    # hostname-resolves-to-internal case.
    try:
        validate_public_url(url, check_dns=False)
    except UnsafeURLError as exc:
        logger.warning("Blocked SSRF-unsafe feed link '%s': %s", url, exc)
        return f"Error: {exc}", False

    try:
        md = MarkItDown(enable_plugins=True)
        url_markdown = md.convert(url)

        title_text = url_markdown.title if url_markdown.title else url
        header = f"# {title_text}\n\n_Source: {url}_\n\n"
        full_content = header + (url_markdown.text_content or "")

        content = truncate_text(full_content, max_tokens)
        was_truncated = len(content) < len(full_content)
        return content, was_truncated
    except Exception as e:
        logger.error("Failed to scrape content from %s: %s", url, e)
        raise


@register_function(config_type=RssFeedFunctionConfig)
async def rss_feed_function(
    config: RssFeedFunctionConfig,
    builder: Builder,
):
    """
    RSS feed function with reranking and web scraping.

    This function fetches RSS feeds, caches them with a 4-hour TTL,
    reranks entries based on user queries, and scrapes the top result.
    """

    # Initialize cache (TTL in seconds)
    cache_ttl_seconds = config.cache_ttl_hours * 3600
    cache = TTLCache(maxsize=1000, ttl=cache_ttl_seconds)

    # Initialize HTTP client
    headers = {"User-Agent": config.user_agent}

    def _configured_feeds() -> dict[str, str]:
        feeds = {k: v for k, v in (config.feeds or {}).items() if k and v}
        if not feeds and config.feed_url:
            feeds["default"] = config.feed_url
        return feeds

    async def parse_rss_feed(feed_url: str, feed_scope: str) -> list[RssEntry]:
        """Parse RSS feed and extract entries."""
        try:
            # Check cache first
            cache_key = f"rss_feed:{feed_url}"
            cached_data = cache.get(cache_key)
            if cached_data is not None:
                logger.info("Using cached RSS feed data for %s", feed_url)
                return cached_data

            # Fetch and parse RSS feed
            async with httpx.AsyncClient(
                headers=headers, timeout=config.timeout
            ) as client:
                response = await client.get(feed_url)
                response.raise_for_status()

            # Parse with fastfeedparser
            parsed = fastfeedparser.parse(response.text)

            entries = []
            for entry in parsed.entries[: config.max_entries]:
                # Extract required and optional fields
                rss_entry = RssEntry(
                    title=entry.get("title", ""),
                    link=entry.get("link", ""),
                    published=entry.get("published", None),
                    author=entry.get("author", None),
                    description=entry.get("description", None),
                    feed_scope=feed_scope,
                    feed_url=feed_url,
                )

                # Only include entries with both title and link
                if rss_entry.title and rss_entry.link:
                    entries.append(rss_entry)

            # Cache the parsed entries
            cache[cache_key] = entries
            logger.info("Cached %d RSS entries for %s", len(entries), feed_url)

            return entries

        except Exception as e:
            logger.error("Failed to parse RSS feed %s: %s", feed_url, str(e))
            return []  # Return empty results silently as requested

    async def rerank_entries(query: str, entries: list[RssEntry]) -> RssEntry | None:
        """Rerank RSS entries based on query and return top result."""
        if not entries:
            return None

        # Check if reranker is configured
        if not config.reranker_endpoint or not config.reranker_model:
            raise ValueError(
                "Reranker configuration is required. Please set "
                "reranker_endpoint and reranker_model in the configuration."
            )
        # Get API key
        api_key = config.reranker_api_key or os.getenv("NVIDIA_API_KEY")
        if not api_key:
            raise ValueError(
                "No API key provided for reranker. Set reranker_api_key "
                "in config or NVIDIA_API_KEY environment variable."
            )

        try:
            # Prepare reranker request
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            }

            passages, entry_indexes = _build_reranker_passages(
                query=query,
                entries=entries,
                max_passage_tokens=config.reranker_max_passage_tokens,
                max_total_tokens=config.reranker_max_total_tokens,
            )
            if not passages:
                logger.warning("No non-empty passages available for reranking")
                return None

            payload = {
                "model": config.reranker_model,
                "query": {"text": query},
                "passages": passages,
            }

            # Make reranker request
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                response = await client.post(
                    str(config.reranker_endpoint),
                    headers=headers,
                    json=payload,
                )
                if response.status_code >= 400:
                    raise ValueError(_reranker_error_message(response))
                response.raise_for_status()

            # Process response
            result = response.json()
            rankings = result.get("rankings", [])

            if not rankings:
                logger.warning("No rankings returned from reranker")
                return None

            # Sort by logit score (higher is better)
            rankings.sort(key=lambda x: x["logit"], reverse=True)

            # Get the top-ranked entry
            top_ranking = rankings[0]
            passage_index = top_ranking["index"]

            if 0 <= passage_index < len(entry_indexes):
                return entries[entry_indexes[passage_index]]
            else:
                logger.error("Invalid index %d from reranker", passage_index)
                return None

        except Exception as e:
            logger.error("Reranking failed: %s", str(e))
            raise

    async def _perform_search(query: str, feed_scope: str) -> dict[str, Any]:
        """Internal helper: rerank RSS entries and scrape the top result.

        Returns the structured RssSearchResponse as a dict. Errors are reported
        via the `success`/`error` fields rather than raised, so callers (the
        public `search_rss` tool) can format them for the LLM.
        """
        try:
            search_request = RssSearchRequest(query=query, feed_scope=feed_scope)

            feeds = _configured_feeds()
            if not feeds:
                return RssSearchResponse(
                    success=False,
                    query=search_request.query,
                    feed_url="",
                    feed_scope=search_request.feed_scope,
                    error=(
                        "RSS feed URL not configured. Please set feed_url or feeds "
                        "in configuration."
                    ),
                ).model_dump()

            requested_scope = (search_request.feed_scope or "auto").strip()
            if requested_scope == "auto":
                selected_feeds = feeds
            elif requested_scope in feeds:
                selected_feeds = {requested_scope: feeds[requested_scope]}
            else:
                return RssSearchResponse(
                    success=False,
                    query=search_request.query,
                    feed_url="",
                    feed_scope=requested_scope,
                    error=(
                        f"Unknown feed_scope '{requested_scope}'. Available scopes: "
                        f"{', '.join(sorted(feeds))}"
                    ),
                ).model_dump()

            # Check cache status
            cache_keys = [f"rss_feed:{url}" for url in selected_feeds.values()]
            is_cached = all(cache_key in cache for cache_key in cache_keys)

            # Parse RSS feed
            nested_entries = await asyncio.gather(
                *(
                    parse_rss_feed(feed_url, scope)
                    for scope, feed_url in selected_feeds.items()
                )
            )
            entries = [entry for group in nested_entries for entry in group]
            feed_url_display = ",".join(selected_feeds.values())

            if not entries:
                return RssSearchResponse(
                    success=True,
                    query=search_request.query,
                    feed_url=feed_url_display,
                    feed_scope=requested_scope,
                    entries_count=0,
                    cached=is_cached,
                    error="No entries found in RSS feed",
                ).model_dump()

            logger.info(
                "Found %d entries across RSS feed scope %s",
                len(entries),
                requested_scope,
            )

            # Rerank entries
            top_entry = await rerank_entries(search_request.query, entries)

            if not top_entry:
                return RssSearchResponse(
                    success=True,
                    query=search_request.query,
                    feed_url=feed_url_display,
                    feed_scope=requested_scope,
                    entries_count=len(entries),
                    cached=is_cached,
                    error="No suitable entry found after reranking",
                ).model_dump()

            # Scrape the top-ranked URL (wrapped in to_thread since markitdown is synchronous)
            logger.info("Scraping top-ranked result: %s", top_entry.link)
            try:
                scraped_content, was_truncated = await asyncio.to_thread(
                    _scrape_content,
                    top_entry.link,
                    config.scrape_max_output_tokens,
                    config.scrape_truncation_message,
                )
                if was_truncated:
                    logger.info("Content was truncated to fit token limit")
            except Exception as e:
                logger.error("Failed to scrape content: %s", str(e))
                # Return the RSS entry info without scraped content
                return RssSearchResponse(
                    success=True,
                    query=search_request.query,
                    feed_url=feed_url_display,
                    feed_scope=requested_scope,
                    top_result={
                        "title": top_entry.title,
                        "link": top_entry.link,
                        "published": top_entry.published,
                        "author": top_entry.author,
                        "description": top_entry.description,
                        "feed_scope": top_entry.feed_scope,
                        "feed_url": top_entry.feed_url,
                    },
                    scraped_content=None,
                    entries_count=len(entries),
                    cached=is_cached,
                    error=f"Failed to scrape content: {str(e)}",
                ).model_dump()

            # Prepare response
            return RssSearchResponse(
                success=True,
                query=search_request.query,
                feed_url=feed_url_display,
                feed_scope=requested_scope,
                top_result={
                    "title": top_entry.title,
                    "link": top_entry.link,
                    "published": top_entry.published,
                    "author": top_entry.author,
                    "description": top_entry.description,
                    "feed_scope": top_entry.feed_scope,
                    "feed_url": top_entry.feed_url,
                },
                scraped_content=scraped_content,
                entries_count=len(entries),
                cached=is_cached,
            ).model_dump()

        except ValueError as e:
            # Reranker configuration errors
            return RssSearchResponse(
                success=False,
                query=query,
                feed_url=",".join(_configured_feeds().values()),
                error=str(e),
            ).model_dump()
        except Exception as e:
            logger.error("RSS feed search error: %s", str(e), exc_info=True)
            return RssSearchResponse(
                success=False,
                query=query,
                feed_url=",".join(_configured_feeds().values()),
                error=f"Unexpected error: {str(e)}",
            ).model_dump()

    async def search_rss(
        query: str,
        feed_scope: str = "auto",
    ) -> str:
        """Search configured RSS feeds and return scraped content of the top
        reranked entry.

        Args:
            query: Search query to rerank RSS entries against.
            feed_scope: Named feed scope to search, or "auto" to search every
                configured feed and pick the single best entry across them.

        Returns:
            Scraped markdown of the top entry, or an "Error: <reason>"
            string when no feed is reachable or no relevant entry is found.
        """
        result = await _perform_search(query, feed_scope)
        if not result["success"]:
            return f"Error: {result['error']}"
        if result["scraped_content"]:
            return result["scraped_content"]
        return f"Error: No relevant content found for query '{query}'."

    try:
        yield FunctionInfo.from_fn(
            search_rss,
            description=(
                "Search configured RSS feeds and return the scraped content of "
                "the most relevant entry. Args: query and optional feed_scope "
                "('auto' or one configured feed name). Returns markdown of the "
                "top-ranked article, or 'Error: ...' if no feed yields a match."
            ),
        )

    except GeneratorExit:
        logger.warning("RSS feed function exited early!")
    finally:
        logger.info("Cleaning up RSS feed function.")
