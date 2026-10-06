import asyncio
import html
import importlib.util
import json
import logging
import mimetypes
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlparse

import fastfeedparser
import httpx
from cachetools import TTLCache
from daedalus_runtime.tools import (
    ToolConfig,
    ToolDefinition,
    ToolRegistry,
    register_tool,
)
from markitdown import MarkItDown
from nat_helpers.phase_timing import phase_timing
from nat_helpers.public_content import AnonymousPublicClient, public_content_session
from nat_helpers.safe_http import (
    PublicAsyncHTTPTransport,
    PublicHTTPTransport,
    get_public_response,
    get_public_response_async,
)
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from nat_helpers.vllm_reranker import (
    build_vllm_rerank_payload,
    parse_vllm_rerank_response,
)
from pydantic import BaseModel, Field, HttpUrl, ValidationError, create_model

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


class RssFeedFunctionConfig(ToolConfig, name="rss_feed"):
    """
    Configuration for RSS feed function with reranking support.

    This function fetches RSS feeds, reranks entries based on user queries,
    and scrapes the top-ranked result.
    """

    description: str | None = None

    # Reranker configuration (required)
    reranker_endpoint: HttpUrl | None = Field(
        default=None, description="The endpoint URL for the reranker service"
    )
    reranker_model: str | None = Field(
        default=None,
        description=(
            "The reranker model to use (e.g., 'nvidia/nv-rerankqa-mistral-4b-v3')"
        ),
    )
    reranker_api_key: str | None = Field(
        default=None,
        description=(
            "Optional API key for the reranker service. Can also be set via "
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
        default=4.0, gt=0, le=24, description="Cache TTL in hours for RSS feed data"
    )

    # Request configuration
    timeout: float = Field(default=30.0, description="Request timeout in seconds")
    user_agent: str = Field(
        default="daedalus-rss-reader/1.0",
        description="User-Agent header for RSS feed requests",
    )
    max_entries: int = Field(
        default=20, ge=1, le=100, description="Maximum number of RSS entries to process"
    )

    feed_concurrency: int = Field(default=4, ge=1, le=16)
    max_batch_queries: int = Field(default=6, ge=1, le=12)
    discovery_excerpt_chars: int = Field(default=800, ge=100, le=2000)

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
        default=8000,
        ge=100,
        le=128000,
        description="Maximum number of tokens in scraped content",
    )
    scrape_timeout: float = Field(
        default=20.0,
        gt=0,
        le=120,
        description=(
            "Overall timeout in seconds for fetching and converting the selected "
            "article."
        ),
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
    content_truncated: bool = False
    error: str | None = None
    entries_count: int = 0
    cached: bool = False


class RssToolSource(BaseModel):
    """Bounded source metadata exposed to the model."""

    title: str
    url: str
    published: str | None = None
    author: str | None = None
    feed_scope: str | None = None
    feed_url: str | None = None


class RssToolResponse(BaseModel):
    """Stable LLM-facing result schema for RSS searches."""

    success: bool
    query: str
    feed_scope: str | None = None
    source: RssToolSource | None = None
    content: str | None = None
    content_truncated: bool = False
    entries_count: int = 0
    cached: bool = False
    error: str | None = None
    feeds: list[dict[str, Any]] = Field(default_factory=list)
    content_fetched_at: str | None = None
    content_cache_status: str | None = None


def _bounded_optional_text(value: Any, max_chars: int) -> str | None:
    text = str(value or "").strip()
    return text[:max_chars] or None


def _format_tool_response(result: dict[str, Any]) -> str:
    top_result = result.get("top_result")
    source = None
    if isinstance(top_result, dict):
        source = RssToolSource(
            title=str(top_result.get("title") or "")[:500],
            url=str(top_result.get("link") or "")[:2048],
            published=_bounded_optional_text(top_result.get("published"), 100),
            author=_bounded_optional_text(top_result.get("author"), 200),
            feed_scope=_bounded_optional_text(top_result.get("feed_scope"), 100),
            feed_url=_bounded_optional_text(top_result.get("feed_url"), 2048),
        )

    content = _bounded_optional_text(result.get("scraped_content"), 1_000_000)
    success = bool(result.get("success")) and content is not None
    error = None
    if not success:
        error = _bounded_optional_text(result.get("error"), 1000) or (
            "No relevant content found"
        )
    response = RssToolResponse(
        success=success,
        query=str(result.get("query") or "")[:1000],
        feed_scope=_bounded_optional_text(result.get("feed_scope"), 100),
        source=source,
        content=content,
        content_truncated=bool(result.get("content_truncated")),
        entries_count=max(0, int(result.get("entries_count") or 0)),
        cached=bool(result.get("cached")),
        error=error,
        feeds=result.get("feeds", []),
        content_fetched_at=result.get("content_fetched_at"),
        content_cache_status=result.get("content_cache_status"),
    )
    return response.model_dump_json(exclude_none=True)


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


def truncate_text(text: str, token_limit: int = 1000) -> str:
    """
    Truncate text to fit within a token limit using tiktoken encoding with fallback to character-based truncation.

    Args:
        text (str): The text to truncate
        token_limit (int): Maximum number of tokens allowed

    Returns:
        str: Truncated text
    """
    # Attempt to use tiktoken for token-based truncation
    if _can_use_tiktoken():
        try:
            encoder = tiktoken.get_encoding("cl100k_base")
            tokens = encoder.encode(text)

            if len(tokens) <= token_limit:
                return text

            return encoder.decode(tokens[:token_limit])
        except Exception as e:
            # Fallback to character-based truncation for any errors
            logger.debug("Failed to use tiktoken for truncation: %s", str(e))

    # Fallback to character-based truncation
    char_limit = token_limit * 4  # Rough approximation: 1 token ≈ 4 characters
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
    """Build a stable error without exposing the upstream response body."""
    return f"Reranker request failed with HTTP {response.status_code}."


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


def _feed_url_rejection_reason(url: str) -> str | None:
    """Return an SSRF rejection reason for a feed URL, or None when safe.

    F-002d: feed URLs can be influenced by tool input (feed_scope selection and
    any agent-supplied feed map), so validate them before fetching. Reject
    non-http(s) schemes, literal internal IPs, and hostnames resolving to
    non-public addresses.
    """
    try:
        validate_public_url(url, check_dns=True)
    except UnsafeURLError as exc:
        return str(exc)
    return None


def _scrape_content(
    url: str,
    token_limit: int | None,
    *,
    fetched_content: bytes | None = None,
    content_type: str = "",
) -> tuple[str, bool]:
    """Fetch through the SSRF-safe transport and convert a local file."""
    # F-001: feed-supplied links are attacker-influenceable. Reject non-http(s)
    # schemes (blocks file:// local-file reads), literal internal IPs, and
    # hostnames resolving to internal addresses before handing the URL to
    # MarkItDown.
    try:
        validate_public_url(url, check_dns=True)
    except UnsafeURLError as exc:
        logger.warning("Blocked SSRF-unsafe feed link (%s)", type(exc).__name__)
        return f"Error: {exc}", False

    try:
        if fetched_content is None:
            with httpx.Client(
                headers={"User-Agent": "daedalus-rss-reader/1.0"},
                follow_redirects=False,
                transport=PublicHTTPTransport(),
                trust_env=False,
                timeout=30.0,
            ) as client:
                response = get_public_response(client, url)
                response.raise_for_status()
            fetched_content = response.content
            content_type = response.headers.get("content-type", "")

        media_type = content_type.split(";", 1)[0].strip().lower()
        suffix = mimetypes.guess_extension(media_type) if media_type else None
        suffix = suffix or os.path.splitext(urlparse(url).path)[1].lower() or ".bin"
        if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix):
            suffix = ".bin"

        md = MarkItDown(enable_plugins=True)
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as file_obj:
                file_obj.write(fetched_content)
                tmp_path = file_obj.name
            url_markdown = md.convert(tmp_path)
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)

        title_text = url_markdown.title if url_markdown.title else url
        header = f"# {title_text}\n\n_Source: {url}_\n\n"
        full_content = header + (url_markdown.text_content or "")

        if token_limit is None and not (url_markdown.text_content or "").strip():
            raise ValueError("Article conversion produced no content")
        content = (
            truncate_text(full_content, token_limit)
            if token_limit is not None
            else full_content
        )
        was_truncated = len(content) < len(full_content)
        return content, was_truncated
    except UnsafeURLError as exc:
        logger.warning("Blocked SSRF-unsafe feed link (%s)", type(exc).__name__)
        return f"Error: {exc}", False
    except Exception as e:
        logger.error("Failed to scrape feed content (%s)", type(e).__name__)
        raise


def _convert_public_article(content: bytes, url: str, content_type: str) -> str:
    markdown, _ = _scrape_content(
        url, None, fetched_content=content, content_type=content_type
    )
    if markdown.startswith("Error: "):
        raise UnsafeURLError("Article URL failed public URL validation.")
    return markdown


async def _scrape_content_with_timeout(
    url: str,
    token_limit: int,
    *,
    timeout: float,
) -> tuple[str, bool]:
    """Bound the complete synchronous fetch and MarkItDown conversion."""

    return await asyncio.wait_for(
        asyncio.to_thread(_scrape_content, url, token_limit),
        timeout=timeout,
    )


@dataclass(frozen=True)
class _FeedSnapshot:
    entries: tuple[RssEntry, ...]
    fetched_at: str
    expires_at: str


def _rss_input_schema(feeds: dict[str, str], max_batch_queries: int) -> type[BaseModel]:
    """Publish exactly the scopes this registered tool can search."""
    scope_type = Literal[("auto", *sorted(feeds))]
    scope_description = "Feed scope: " + ", ".join(["auto", *sorted(feeds)])
    query_type = create_model(
        "RssDiscoveryQuery",
        query=(str, Field(..., min_length=1, max_length=1000)),
        feed_scope=(scope_type, Field(default="auto", description=scope_description)),
    )
    return create_model(
        "RssToolInput",
        query=(str, Field(default="", max_length=1000)),
        feed_scope=(scope_type, Field(default="auto", description=scope_description)),
        mode=(
            Literal["article", "discover"],
            Field(
                default="article",
                description="article retrieves one full article; discover returns feed candidates only",
            ),
        ),
        queries=(
            list[query_type] | None,
            Field(
                default=None,
                min_length=1,
                max_length=max_batch_queries,
                description="Batch of independent searches; requires mode='discover'",
            ),
        ),
        top_k=(
            int,
            Field(default=3, ge=1, le=5, description="Candidates per discovery query"),
        ),
    )


@register_tool(config_type=RssFeedFunctionConfig)
async def rss_feed_function(config: RssFeedFunctionConfig, builder: ToolRegistry):
    """Search feeds with bounded discovery batches and optional article retrieval."""
    feeds = {key: value for key, value in config.feeds.items() if key and value}
    if not feeds and config.feed_url:
        feeds["default"] = config.feed_url
    input_schema = _rss_input_schema(feeds, config.max_batch_queries)
    cache = TTLCache(maxsize=1000, ttl=config.cache_ttl_hours * 3600)
    inflight: dict[str, asyncio.Task[_FeedSnapshot]] = {}
    fetch_slots = asyncio.Semaphore(config.feed_concurrency)
    rerank_slots = asyncio.Semaphore(config.feed_concurrency)

    async with (
        AnonymousPublicClient(
            headers={"User-Agent": config.user_agent},
            timeout=config.timeout,
            follow_redirects=False,
            transport=PublicAsyncHTTPTransport(),
            trust_env=False,
        ) as feed_client,
        httpx.AsyncClient(timeout=config.timeout) as rerank_client,
        public_content_session(builder) as content_session,
    ):

        async def fetch_feed(url: str, scope: str) -> _FeedSnapshot:
            async with fetch_slots, asyncio.timeout(config.timeout):
                with phase_timing("daedalus.rss.feed_fetch", {"feed_scope": scope}):
                    response = await asyncio.wait_for(
                        get_public_response_async(feed_client, url), config.timeout
                    )
                    response.raise_for_status()
                    fetched_at = datetime.now(UTC)
                with phase_timing("daedalus.rss.feed_parse", {"feed_scope": scope}):
                    parsed = await asyncio.to_thread(
                        fastfeedparser.parse, response.text
                    )
                    entries = []
                    for entry in parsed.entries[: config.max_entries]:
                        title, link = entry.get("title", ""), entry.get("link", "")
                        if not title or not link:
                            continue
                        # Discovery never opens links. Reject unsafe schemes and
                        # literal addresses now; the pinned transport validates
                        # hostname DNS and every redirect when an article is read.
                        try:
                            validate_public_url(link, check_dns=False)
                        except UnsafeURLError:
                            continue
                        entries.append(
                            RssEntry(
                                title=title,
                                link=link,
                                published=entry.get("published"),
                                author=entry.get("author"),
                                description=entry.get("description"),
                                feed_url=url,
                            )
                        )
                    snapshot = _FeedSnapshot(
                        tuple(entries),
                        fetched_at.isoformat(),
                        (
                            fetched_at + timedelta(hours=config.cache_ttl_hours)
                        ).isoformat(),
                    )
                    cache[url] = snapshot
                    return snapshot

        async def read_feed(
            scope: str, url: str
        ) -> tuple[list[RssEntry], dict[str, Any]]:
            metadata: dict[str, Any] = {
                "feed_scope": scope,
                "url": url,
                "cached": False,
                "coalesced": False,
            }
            with phase_timing(
                "daedalus.rss.feed_cache", {"feed_scope": scope}
            ) as phase:
                # Cached data performs no DNS or HTTP work. Only public fetches
                # admitted by the safe transport can populate this cache.
                snapshot = cache.get(url)
                if snapshot is not None and datetime.fromisoformat(
                    snapshot.expires_at
                ) <= datetime.now(UTC):
                    cache.pop(url, None)
                    snapshot = None
                metadata["cached"] = snapshot is not None
                phase.set_metadata(cache_hit=snapshot is not None)
            try:
                if snapshot is None:
                    task = inflight.get(url)
                    if task is None:
                        task = asyncio.create_task(fetch_feed(url, scope))
                        inflight[url] = task

                        def forget(done: asyncio.Task, key: str = url) -> None:
                            if inflight.get(key) is done:
                                inflight.pop(key, None)
                            if not done.cancelled():
                                done.exception()  # consume failures if every waiter cancelled

                        task.add_done_callback(forget)
                    else:
                        metadata["coalesced"] = True
                    # One cancelled caller must not cancel another caller's fetch.
                    snapshot = await asyncio.shield(task)
                entries = [
                    entry.model_copy(update={"feed_scope": scope})
                    for entry in snapshot.entries
                ]
                metadata.update(
                    status="available" if entries else "empty",
                    fetched_at=snapshot.fetched_at,
                    expires_at=snapshot.expires_at,
                    entries_count=len(entries),
                )
                return entries, metadata
            except Exception as exc:
                logger.warning(
                    "RSS feed unavailable (scope %s, %s)", scope, type(exc).__name__
                )
                metadata.update(
                    status="unavailable", error="RSS feed fetch or parsing failed."
                )
                return [], metadata

        async def rerank_entries(
            query: str, entries: list[RssEntry], top_k: int
        ) -> list[RssEntry]:
            if not config.reranker_endpoint or not config.reranker_model:
                raise ValueError("Reranker configuration is required.")
            passages, indexes = _build_reranker_passages(
                query,
                entries,
                config.reranker_max_passage_tokens,
                config.reranker_max_total_tokens,
            )
            if not passages:
                return []
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            api_key = config.reranker_api_key or os.getenv("NVIDIA_API_KEY")
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            payload = build_vllm_rerank_payload(
                model=config.reranker_model,
                query=query,
                documents=[passage["text"] for passage in passages],
                top_n=top_k,
            )
            async with rerank_slots:
                with phase_timing(
                    "daedalus.rss.rerank",
                    {"entries_count": len(passages), "top_k": top_k},
                ):
                    response = await asyncio.wait_for(
                        rerank_client.post(
                            str(config.reranker_endpoint),
                            headers=headers,
                            json=payload,
                        ),
                        config.timeout,
                    )
                    if response.status_code >= 400:
                        raise ValueError(_reranker_error_message(response))
                    response.raise_for_status()
                    rankings = parse_vllm_rerank_response(
                        response.json(), document_count=len(passages)
                    )
            return [entries[indexes[item.index]] for item in rankings[:top_k]]

        async def perform_search(
            query: str, scope: str, *, discover: bool, top_k: int
        ) -> dict[str, Any]:
            result: dict[str, Any] = {
                "success": False,
                "query": query,
                "feed_scope": scope,
                "entries_count": 0,
                "cached": False,
                "feeds": [],
            }
            if discover:
                result.update(
                    status="unavailable", sources=[], article_content_verified=False
                )
            if not feeds:
                result["error"] = (
                    "RSS feed URL not configured. Please set feed_url or feeds in configuration."
                )
                return result
            selected = feeds if scope == "auto" else {scope: feeds[scope]}
            groups = await asyncio.gather(
                *(read_feed(name, url) for name, url in selected.items())
            )
            entries = [entry for group, _ in groups for entry in group]
            metadata = [item for _, item in groups]
            result.update(
                feeds=metadata,
                entries_count=len(entries),
                cached=all(item["cached"] for item in metadata),
            )
            failed = any(item["status"] == "unavailable" for item in metadata)
            if not entries:
                result["error"] = (
                    "RSS feeds unavailable."
                    if failed
                    else "No entries found in RSS feed"
                )
                if discover:
                    result.update(
                        status="unavailable" if failed else "empty", success=not failed
                    )
                return result
            try:
                ranked = await rerank_entries(query, entries, top_k if discover else 1)
            except Exception as exc:
                logger.warning("RSS reranking failed (%s)", type(exc).__name__)
                result["error"] = "RSS search configuration or reranking failed."
                return result
            if not ranked:
                result["error"] = "No suitable entry found after reranking"
                if discover:
                    result.update(
                        status="partial" if failed else "empty", success=not failed
                    )
                return result
            if discover:
                result.update(
                    success=True,
                    status="partial" if failed else "ok",
                    sources=[
                        {
                            "title": entry.title[:500],
                            "url": entry.link[:2048],
                            "published": _bounded_optional_text(entry.published, 100),
                            "feed_scope": entry.feed_scope,
                            "excerpt": _normalize_reranker_text(entry.description)[
                                : config.discovery_excerpt_chars
                            ],
                            "fetched_at": next(
                                item["fetched_at"]
                                for item in metadata
                                if item["feed_scope"] == entry.feed_scope
                            ),
                            "evidence": "feed_summary",
                        }
                        for entry in ranked
                    ],
                )
                return result
            top_entry = ranked[0]
            result["top_result"] = top_entry.model_dump()
            try:
                with phase_timing("daedalus.rss.article", {}):
                    article, cache_status = await content_session.article(
                        top_entry.link,
                        timeout=config.scrape_timeout,
                        allowed_schemes=("http", "https"),
                        converter=_convert_public_article,
                    )
                content = truncate_text(
                    article.markdown, config.scrape_max_output_tokens
                )
                result.update(
                    success=True,
                    scraped_content=content,
                    content_truncated=len(content) < len(article.markdown),
                    content_fetched_at=article.fetched_at,
                    content_cache_status=cache_status,
                )
            except TimeoutError:
                result["error"] = "Selected RSS content exceeded the scrape timeout."
            except Exception as exc:
                logger.warning("RSS article retrieval failed (%s)", type(exc).__name__)
                result["error"] = "Failed to scrape the selected RSS content."
            return result

        async def search_rss(
            query: str = "",
            feed_scope: str = "auto",
            mode: str = "article",
            queries: list[dict[str, Any]] | None = None,
            top_k: int = 3,
        ) -> str:
            """Search one full article or discover candidates for independent queries."""
            try:
                request = input_schema(
                    query=query,
                    feed_scope=feed_scope,
                    mode=mode,
                    queries=queries,
                    top_k=top_k,
                )
                if request.queries is not None and (
                    request.mode != "discover" or request.query
                ):
                    raise ValueError(
                        "Use queries only with mode='discover' and omit query."
                    )
                if request.queries is None and not request.query.strip():
                    raise ValueError("Provide query or a discovery queries batch.")
                if request.queries and any(
                    not item.query.strip() for item in request.queries
                ):
                    raise ValueError("Discovery queries must not be blank.")
            except (ValidationError, ValueError):
                return RssToolResponse(
                    success=False,
                    query=str(query)[:1000],
                    feed_scope=feed_scope,
                    error="Invalid RSS search arguments. Use a configured feed_scope, a nonempty query or discovery queries batch, and top_k between 1 and 5.",
                ).model_dump_json(exclude_none=True)
            if request.mode == "discover":
                searches = request.queries or [
                    RssSearchRequest(query=request.query, feed_scope=request.feed_scope)
                ]
                with phase_timing(
                    "daedalus.rss.discovery", {"query_count": len(searches)}
                ):
                    results = await asyncio.gather(
                        *(
                            perform_search(
                                item.query,
                                item.feed_scope,
                                discover=True,
                                top_k=request.top_k,
                            )
                            for item in searches
                        )
                    )
                return json.dumps(
                    {
                        "success": any(item["success"] for item in results),
                        "mode": "discover",
                        "article_content_verified": False,
                        "results": results,
                    }
                )
            return _format_tool_response(
                await perform_search(
                    request.query, request.feed_scope, discover=False, top_k=1
                )
            )

        try:
            yield ToolDefinition.from_fn(
                search_rss,
                input_schema=input_schema,
                description=(
                    (config.description + " " if config.description else "")
                    + "Search curated RSS feeds. mode='article' (default) returns one full article for query. "
                    + "mode='discover' returns top_k compact candidates per query; batch independent searches with queries=[{query,feed_scope}]. "
                    + "Discovery excerpts are feed summaries, not verified article content; retrieve selected URLs for precise claims. "
                    + "Available feed_scope values: "
                    + ", ".join(["auto", *sorted(feeds)])
                    + "."
                ),
            )
        finally:
            for task in list(inflight.values()):
                task.cancel()
            await asyncio.gather(*list(inflight.values()), return_exceptions=True)
