import asyncio
import importlib.util
import logging
import os
from typing import Any

import fastfeedparser
import httpx
from cachetools import TTLCache
from markitdown import MarkItDown
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import BaseModel, Field, HttpUrl

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

logger = logging.getLogger(__name__)


class RssEntry(BaseModel):
    """RSS feed entry model."""

    title: str
    link: str
    published: str | None = None
    author: str | None = None
    description: str | None = None


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
    description: str | None = Field(
        None, description="Optional description of the search"
    )


class RssSearchResponse(BaseModel):
    """Response model for RSS feed search."""

    success: bool
    query: str
    feed_url: str
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


def _scrape_content(url: str, max_tokens: int, truncation_msg: str) -> tuple[str, bool]:
    """Scrape content from URL using markitdown."""
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

    async def parse_rss_feed(feed_url: str) -> list[RssEntry]:
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

            # Extract descriptions (preferred) or titles as passages
            passages = [{"text": entry.description or entry.title} for entry in entries]

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
            top_index = top_ranking["index"]

            if 0 <= top_index < len(entries):
                return entries[top_index]
            else:
                logger.error("Invalid index %d from reranker", top_index)
                return None

        except Exception as e:
            logger.error("Reranking failed: %s", str(e))
            raise

    async def rss_feed_search(request: dict[str, Any]) -> dict[str, Any]:
        """
        Search RSS feed entries using reranking and scrape the top result.

        Args:
            request: Dictionary containing:
                - query: Search query to rerank entries against
                - feed_url: RSS feed URL
                - description: Optional description

        Returns:
            Dictionary containing search results and scraped content
        """
        try:
            # Parse request - handle potential wrapper
            if isinstance(request, dict):
                # Check if the request is wrapped in a 'request' key
                if "request" in request and isinstance(request["request"], dict):
                    logger.debug("Unwrapping request from 'request' key")
                    actual_request = request["request"]
                else:
                    actual_request = request

                logger.debug("Parsed request: %s", actual_request)
                search_request = RssSearchRequest(**actual_request)
            else:
                return RssSearchResponse(
                    success=False,
                    query="",
                    feed_url="",
                    error=(
                        "Invalid request format. Expected dictionary with "
                        "query field."
                    ),
                ).model_dump()

            # Check if feed URL is configured
            if not config.feed_url:
                return RssSearchResponse(
                    success=False,
                    query=search_request.query,
                    feed_url="",
                    error=(
                        "RSS feed URL not configured. Please set feed_url "
                        "in configuration."
                    ),
                ).model_dump()

            # Check cache status
            cache_key = f"rss_feed:{config.feed_url}"
            is_cached = cache_key in cache

            # Parse RSS feed
            entries = await parse_rss_feed(config.feed_url)

            if not entries:
                return RssSearchResponse(
                    success=True,
                    query=search_request.query,
                    feed_url=config.feed_url,
                    entries_count=0,
                    cached=is_cached,
                    error="No entries found in RSS feed",
                ).model_dump()

            logger.info(
                "Found %d entries in RSS feed %s", len(entries), config.feed_url
            )

            # Rerank entries
            top_entry = await rerank_entries(search_request.query, entries)

            if not top_entry:
                return RssSearchResponse(
                    success=True,
                    query=search_request.query,
                    feed_url=config.feed_url,
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
                    feed_url=config.feed_url,
                    top_result={
                        "title": top_entry.title,
                        "link": top_entry.link,
                        "published": top_entry.published,
                        "author": top_entry.author,
                        "description": top_entry.description,
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
                feed_url=config.feed_url,
                top_result={
                    "title": top_entry.title,
                    "link": top_entry.link,
                    "published": top_entry.published,
                    "author": top_entry.author,
                    "description": top_entry.description,
                },
                scraped_content=scraped_content,
                entries_count=len(entries),
                cached=is_cached,
            ).model_dump()

        except ValueError as e:
            # Reranker configuration errors
            # Extract query from potentially wrapped request
            query = ""
            if isinstance(request, dict):
                if "request" in request and isinstance(request["request"], dict):
                    query = request["request"].get("query", "")
                else:
                    query = request.get("query", "")

            return RssSearchResponse(
                success=False, query=query, feed_url=config.feed_url or "", error=str(e)
            ).model_dump()
        except Exception as e:
            logger.error("RSS feed search error: %s", str(e), exc_info=True)
            # Extract query from potentially wrapped request
            query = ""
            if isinstance(request, dict):
                if "request" in request and isinstance(request["request"], dict):
                    query = request["request"].get("query", "")
                else:
                    query = request.get("query", "")

            return RssSearchResponse(
                success=False,
                query=query,
                feed_url=config.feed_url or "",
                error=f"Unexpected error: {str(e)}",
            ).model_dump()

    # Simple wrapper for convenience
    async def search_rss(query: str, description: str = None) -> str:
        """
        Simple RSS feed search that returns formatted results.

        Args:
            query: Search query to rerank RSS entries against
            description: Optional description of the search

        Returns:
            Formatted string with search results or scraped content
        """
        result = await rss_feed_search({"query": query, "description": description})

        if not result["success"]:
            return f"RSS Feed Search Error: {result['error']}"

        if result["scraped_content"]:
            return result["scraped_content"]
        else:
            return f"No relevant content found for query: '{query}'"

    try:
        # Register the main function
        yield FunctionInfo.create(
            single_fn=rss_feed_search,
            description=(
                "Search the configured RSS feed using AI-powered reranking "
                "and scrape the most relevant result. Requires configured "
                "feed_url and reranker endpoint. Caches RSS feeds for 4 "
                "hours to improve performance."
            ),
        )

        # Also register the simple wrapper
        yield FunctionInfo.from_fn(
            search_rss,
            description=(
                "Search the configured RSS feed and return the scraped "
                "content of the most relevant entry based on your query."
            ),
        )

    except GeneratorExit:
        logger.warning("RSS feed function exited early!")
    finally:
        logger.info("Cleaning up RSS feed function.")
