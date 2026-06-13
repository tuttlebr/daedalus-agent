"""Source citation verification for NeMo Agent Toolkit.

Registers source-governance tools with NAT:

  verify_claim      Fetch a source URL and assess whether it actually
                    supports a specific claim.  Returns a structured
                    verdict (supported / partially_supported / unsupported /
                    source_unreachable) with evidence excerpts.

  verify_memory     Verify an existing memory entry's citations and logic.
                    Routes by memory type: findings get source-checked,
                    syntheses get logic-checked, reports are skipped.

  audit_memories    Batch-verify a set of memories (output of get_memory).
                    Returns a structured audit report with per-memory
                    verdicts and an aggregate summary.

  audit_citations   Deterministically audit a markdown answer's inline
                    citations and reference URLs against an optional source
                    ledger captured from tool results.

  plan_sources      Choose an allowed source/tool strategy from a small
                    source registry before research begins.

Designed to combat hallucination compounding in autonomous agent cycles
where uncited or incorrectly cited claims accumulate in memory over time.

Reuses webscrape's URL fetching (markitdown + httpx) for lightweight
source retrieval without consuming a tool call, and follows the
content_distiller LLM call pattern for verification assessment.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import httpx
from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from pydantic import Field
from webscrape.webscrape_function import (
    _BROWSER_HEADERS,
    _BROWSER_USER_AGENT,
    _get_following_safe_redirects,
    _html_to_markdown,
    _is_challenge_page,
    _is_valid_content,
    _scrape_with_markitdown,
    _validate_url,
)

logger = logging.getLogger(__name__)

# Regex to extract markdown links: [text](url)
_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]*)\]\((https?://[^)]+)\)")
_PLACEHOLDER_HOSTS = {"example.com", "example.org", "example.net"}
_TRACKING_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "source",
}
_URL_RE = re.compile(r"https?://[^\s<>\"'\]]+")
_URL_TRIM_CHARS = ".,;)]>"
# Max redirects to follow (with per-hop SSRF revalidation) for link reachability.
_MAX_LINK_REDIRECTS = 10
_REFERENCE_SECTION_RE = re.compile(
    r"^(?:#{2,3}\s+(?:Sources|References)|\*\*References:?\*\*)",
    re.MULTILINE | re.IGNORECASE,
)
_CITATION_LINE_RE = re.compile(r"^(\s*[-*]?\s*)\[(\d+)\](\s+.+)$")
_INLINE_CITATION_RE = re.compile(r"(?<!\w)\[(\d+)\](?!\w)")


def _default_source_registry() -> list[dict[str, Any]]:
    """Default Daedalus source registry used by plan_sources."""
    return [
        {
            "id": "curated_domains",
            "name": "Curated Knowledge Domains",
            "description": (
                "Milvus-backed curated corpora for established reference " "questions."
            ),
            "tools": ["domain_retriever_tool"],
            "default_enabled": True,
            "requires_auth": False,
        },
        {
            "id": "curated_feeds",
            "name": "Curated Recent Feeds",
            "description": (
                "Trusted RSS feeds for current source-specific updates and "
                "announcements."
            ),
            "tools": ["curated_feed_search_tool"],
            "default_enabled": True,
            "requires_auth": False,
        },
        {
            "id": "google_search",
            "name": "Internet Search (SerpAPI)",
            "description": (
                "SerpAPI results for internet research, news, discovery, "
                "shopping, images, and quick URL lookup."
            ),
            "tools": ["serpapi_search_tool"],
            "default_enabled": True,
            "requires_auth": False,
        },
        {
            "id": "perplexity_search",
            "name": "Internet Search (Perplexity)",
            "description": (
                "Perplexity Search API ranked web results with snippets, "
                "publication dates, and freshness metadata."
            ),
            "tools": ["perplexity_search_tool"],
            "default_enabled": True,
            "requires_auth": False,
        },
        {
            "id": "known_url_scrape",
            "name": "Known URL Scrape",
            "description": "Fetch and convert a specific URL already known.",
            "tools": ["webscrape_tool"],
            "default_enabled": True,
            "requires_auth": False,
        },
        {
            "id": "uploaded_documents",
            "name": "Uploaded Documents",
            "description": (
                "Authenticated user's uploaded documents and shared upload "
                "collections."
            ),
            "tools": ["user_document_tool"],
            "default_enabled": False,
            "requires_auth": True,
        },
        {
            "id": "workspace_data",
            "name": "Workspace Data",
            "description": "Authenticated user's Gmail and Calendar data.",
            "tools": ["gmail_mcp_server", "calendar_mcp_server"],
            "default_enabled": False,
            "requires_auth": True,
        },
        {
            "id": "nvidia_docs",
            "name": "Official NVIDIA Docs",
            "description": (
                "Official NVIDIA product documentation via direct MCP docs " "servers."
            ),
            "tools": [
                "dynamo_mcp_server",
                "openshell_mcp_server",
                "aistore_mcp_server",
                "aiperf_mcp_server",
                "nvcf_mcp_server",
                "dsx_mcp_server",
            ],
            "default_enabled": True,
            "requires_auth": False,
        },
    ]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class FetchResult:
    """Result of fetching a source URL."""

    status: str  # ok, unreachable, forbidden, challenge_page, invalid_url, empty
    content: str | None = None
    status_code: int | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class SourceVerifierConfig(FunctionBaseConfig, name="source_verifier"):
    """Configuration for the source_verifier function."""

    fast_llm_name: str = Field(
        default="distill_llm",
        description=(
            "LLM for lightweight verification (single claim checks). "
            "Should be a fast, cost-effective model (e.g. Haiku-class). "
            "Falls back to llm_name if unavailable."
        ),
    )
    llm_name: str = Field(
        default="tool_calling_llm",
        description=(
            "LLM for complex verification (synthesis analysis). "
            "Also used as fallback when fast_llm_name is unavailable."
        ),
    )
    max_source_chars: int = Field(
        default=80000,
        ge=1000,
        le=500000,
        description="Maximum source content length in characters before truncation.",
    )
    max_output_tokens: int = Field(
        default=4096,
        ge=256,
        le=16384,
        description="Maximum tokens for the verification LLM response.",
    )
    wrapper_type: str = Field(
        default="LANGCHAIN",
        description="LLM wrapper type: LANGCHAIN or OPENAI.",
    )
    fetch_timeout: float = Field(
        default=30.0,
        ge=5.0,
        le=120.0,
        description="Timeout in seconds for URL fetching.",
    )
    max_fetch_tokens: int = Field(
        default=20000,
        ge=1000,
        le=64000,
        description="Maximum tokens of fetched source content to pass to the verification LLM.",
    )
    enabled_operations: list[str] | None = Field(
        default=None,
        description=(
            "Optional allow-list of operations to register. Supported values: "
            "verify_claim, verify_memory, audit_memories, audit_citations, "
            "plan_sources. When omitted, all operations are registered."
        ),
    )
    source_registry: list[dict[str, Any]] = Field(
        default_factory=_default_source_registry,
        description=(
            "Source registry used by plan_sources. Entries support id, name, "
            "description, tools, default_enabled, and requires_auth."
        ),
    )


# ---------------------------------------------------------------------------
# LLM helper (local copy from content_distiller pattern)
# ---------------------------------------------------------------------------
async def _call_llm(
    builder: Builder,
    config: SourceVerifierConfig,
    system_prompt: str,
    user_prompt: str,
    llm_name: str | None = None,
) -> str:
    """Make a secondary LLM call for verification assessment."""
    try:
        wrapper = LLMFrameworkEnum(config.wrapper_type)
    except (ValueError, TypeError):
        wrapper = LLMFrameworkEnum.LANGCHAIN

    use_langchain = wrapper == LLMFrameworkEnum.LANGCHAIN

    llm_kwargs = {
        "max_tokens": config.max_output_tokens,
    }

    target_llm = llm_name or config.llm_name
    try:
        try:
            llm_callable = await builder.get_llm(target_llm, wrapper_type=wrapper)
        except Exception:
            if target_llm != config.llm_name:
                logger.info(
                    "LLM '%s' unavailable, falling back to '%s'",
                    target_llm,
                    config.llm_name,
                )
                llm_callable = await builder.get_llm(
                    config.llm_name, wrapper_type=wrapper
                )
            else:
                raise

        if use_langchain:
            from langchain_core.messages import HumanMessage, SystemMessage

            langchain_llm = llm_callable.bind(**llm_kwargs)
            messages = [
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt),
            ]
            result = await langchain_llm.ainvoke(messages)
        else:
            result = await llm_callable.invoke(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                **llm_kwargs,
            )

        if hasattr(result, "content"):
            content = result.content
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list) and content:
                for block in content:
                    if isinstance(block, str) and block.strip():
                        return block.strip()
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text", "")
                        if isinstance(text, str) and text.strip():
                            return text.strip()
        if isinstance(result, dict):
            content = result.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
        if isinstance(result, str) and result.strip():
            return result.strip()

        logger.warning("LLM returned unexpected type=%s", type(result))
        return str(result)

    except Exception as exc:
        logger.error("Verification LLM call failed: %s", exc)
        return f"Error: Verification LLM call failed: {exc}"


# ---------------------------------------------------------------------------
# URL fetching helper
# ---------------------------------------------------------------------------
async def _scrape_with_httpx_safe(
    url: str, max_tokens: int | None = None, truncation_msg: str = ""
) -> str | None:
    """httpx scrape that SSRF-validates every redirect hop (F-002a).

    Mirrors webscrape's httpx strategy but follows redirects manually via
    ``_get_following_safe_redirects`` so a redirect to an internal/metadata
    address is rejected (``UnsafeURLError``) instead of silently fetched.
    """
    headers = {**_BROWSER_HEADERS, "User-Agent": _BROWSER_USER_AGENT}
    async with httpx.AsyncClient(
        headers=headers, follow_redirects=False, timeout=30.0
    ) as client:
        response = await _get_following_safe_redirects(
            client, url, allowed_schemes=["http", "https"]
        )

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


async def _fetch_source(url: str, config: SourceVerifierConfig) -> FetchResult:
    """Fetch a URL using webscrape strategies (markitdown -> httpx).

    Skips the Playwright browser fallback to stay lightweight.
    Returns a FetchResult with status and content.
    """
    # Validate URL
    try:
        normalized_url, _ = _validate_url(url, ["http", "https"])
    except ValueError as exc:
        return FetchResult(status="invalid_url", error=str(exc))

    # F-001: source URLs come from LLM output / stored memories. Reject non-http(s)
    # schemes and literal internal IPs before fetching (network policy covers the
    # hostname-resolves-to-internal case).
    try:
        validate_public_url(normalized_url, check_dns=False)
    except UnsafeURLError as exc:
        return FetchResult(status="invalid_url", error=str(exc))

    truncation_msg = "\n\n[Source content truncated for verification]"

    # Strategy 1: MarkItDown (fastest, no JS)
    try:
        content = await asyncio.to_thread(
            _scrape_with_markitdown,
            normalized_url,
            max_tokens=config.max_fetch_tokens,
            truncation_msg=truncation_msg,
        )
        if _is_valid_content(content):
            return FetchResult(status="ok", content=content)
    except Exception as exc:
        logger.debug("markitdown failed for %s: %s", normalized_url, exc)

    # Strategy 2: httpx with browser-like headers (redirect hops SSRF-validated)
    try:
        content = await asyncio.wait_for(
            _scrape_with_httpx_safe(
                normalized_url,
                max_tokens=config.max_fetch_tokens,
                truncation_msg=truncation_msg,
            ),
            timeout=config.fetch_timeout,
        )
        if content and _is_valid_content(content):
            return FetchResult(status="ok", content=content)
        if content is None:
            return FetchResult(status="unreachable", error="httpx returned no content")
        return FetchResult(
            status="challenge_page", error="Content appears to be a challenge page"
        )
    except UnsafeURLError as exc:
        # F-002a: a redirect pointed at a non-public address; refuse to follow it.
        return FetchResult(status="invalid_url", error=str(exc))
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        if code == 403:
            return FetchResult(
                status="forbidden", status_code=403, error="HTTP 403 Forbidden"
            )
        if code == 404:
            return FetchResult(
                status="unreachable", status_code=404, error="HTTP 404 Not Found"
            )
        return FetchResult(status="unreachable", status_code=code, error=f"HTTP {code}")
    except TimeoutError:
        return FetchResult(
            status="unreachable", error=f"Fetch timed out after {config.fetch_timeout}s"
        )
    except Exception as exc:
        return FetchResult(status="unreachable", error=str(exc))


def _extract_markdown_links(text: str) -> list[dict]:
    """Extract all markdown links from text."""
    return [
        {"text": m.group(1), "url": m.group(2)}
        for m in _MARKDOWN_LINK_RE.finditer(text)
    ]


async def _check_link_reachable(url: str, timeout: float = 10.0) -> bool:
    """Check if a URL is reachable via HEAD request.

    F-002b: the URL comes from memory text (LLM/attacker-influenceable) via regex,
    so SSRF-validate it before fetching and treat an unsafe target as unreachable.
    Redirects are followed manually so each hop is revalidated, closing the
    ``https://attacker.com -> http://169.254.169.254/`` bypass.
    """
    try:
        validate_public_url(url, check_dns=False)
    except UnsafeURLError:
        return False
    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
            current_url = url
            for _ in range(_MAX_LINK_REDIRECTS + 1):
                resp = await client.head(current_url)
                if not resp.is_redirect:
                    return resp.is_success
                location = resp.headers.get("location")
                if not location:
                    return resp.is_success
                next_url = urljoin(current_url, location)
                validate_public_url(next_url, check_dns=False)
                current_url = next_url
            return False
    except Exception:
        return False


def _parse_llm_json(raw: str) -> dict:
    """Extract and parse JSON from an LLM response that may include markdown fences."""
    text = raw.strip()
    if text.startswith("```"):
        # Strip markdown code fences
        lines = text.split("\n")
        lines = lines[1:]  # drop opening fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def _normalize_audit_url(url: str) -> str:
    """Normalize a URL for citation-audit comparison."""
    parsed = urlparse(url.strip())
    query = urlencode(
        sorted(
            (key, value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            if key.lower() not in _TRACKING_PARAMS
        )
    )
    return urlunparse(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path.rstrip("/") or "/",
            "",
            query,
            "",
        )
    )


def _extract_urls(text: str) -> list[str]:
    """Extract HTTP(S) URLs from markdown or plain text."""
    urls: list[str] = []
    seen: set[str] = set()
    for match in _URL_RE.finditer(text):
        url = match.group(0).rstrip(_URL_TRIM_CHARS)
        normalized = _normalize_audit_url(url)
        if normalized not in seen:
            seen.add(normalized)
            urls.append(url)
    return urls


def _parse_source_urls(source_urls_json: str) -> list[str]:
    """Parse a source ledger passed as JSON, newline text, or comma text."""
    if not source_urls_json or not source_urls_json.strip():
        return []

    text = source_urls_json.strip()
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return _extract_urls(text)

    urls: list[str] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                urls.extend(_extract_urls(item))
            elif isinstance(item, dict):
                for key in ("url", "source_url", "href"):
                    value = item.get(key)
                    if isinstance(value, str):
                        urls.extend(_extract_urls(value))
                        break
    elif isinstance(raw, dict):
        for key in ("urls", "source_urls", "sources", "references"):
            value = raw.get(key)
            if isinstance(value, list):
                urls.extend(_parse_source_urls(json.dumps(value)))
                break
        else:
            for key in ("url", "source_url", "href"):
                value = raw.get(key)
                if isinstance(value, str):
                    urls.extend(_extract_urls(value))
                    break

    deduped: list[str] = []
    seen: set[str] = set()
    for url in urls:
        normalized = _normalize_audit_url(url)
        if normalized not in seen:
            seen.add(normalized)
            deduped.append(url)
    return deduped


def _source_entry_value(entry: dict[str, Any], key: str, default: Any) -> Any:
    value = entry.get(key, default)
    return default if value is None else value


def _normalize_source_entry(entry: dict[str, Any]) -> dict[str, Any]:
    source_id = str(_source_entry_value(entry, "id", "")).strip().lower()
    tools = _source_entry_value(entry, "tools", [])
    if isinstance(tools, str):
        tools = [item.strip() for item in tools.split(",") if item.strip()]
    elif isinstance(tools, list):
        tools = [str(item).strip() for item in tools if str(item).strip()]
    else:
        tools = []

    name = str(
        _source_entry_value(
            entry,
            "name",
            source_id.replace("_", " ").title(),
        )
    ).strip()
    description = str(_source_entry_value(entry, "description", "")).strip()

    return {
        "id": source_id,
        "name": name,
        "description": description,
        "tools": tools,
        "default_enabled": bool(_source_entry_value(entry, "default_enabled", True)),
        "requires_auth": bool(_source_entry_value(entry, "requires_auth", False)),
    }


def _parse_source_ids(raw: str) -> tuple[set[str] | None, list[str]]:
    """Parse source IDs from JSON, comma text, or newline text.

    Returns None when the caller omitted the value, preserving the distinction
    between "use defaults" and "explicitly use no data sources".
    """
    if raw is None or not str(raw).strip():
        return None, []

    text = str(raw).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = re.split(r"[\n,]", text)

    values: list[Any]
    if isinstance(parsed, dict):
        for key in ("sources", "source_ids", "selected_sources", "disabled_sources"):
            value = parsed.get(key)
            if isinstance(value, list):
                values = value
                break
        else:
            values = [parsed.get("id", "")]
    elif isinstance(parsed, list):
        values = parsed
    else:
        values = [parsed]

    source_ids = {str(value).strip().lower() for value in values if str(value).strip()}
    return source_ids, sorted(source_ids)


def _question_flags(question: str) -> dict[str, bool]:
    q = question.lower()
    return {
        "has_url": bool(_extract_urls(question)),
        "current": any(
            token in q
            for token in (
                "latest",
                "current",
                "today",
                "this week",
                "recent",
                "news",
                "released",
                "version",
            )
        ),
        "broad": any(
            token in q
            for token in (
                "comprehensive",
                "deep research",
                "report",
                "roadmap",
                "strategy",
                "survey",
                "compare across",
                "market",
                "landscape",
            )
        ),
        "docs": any(
            token in q
            for token in (
                "nvidia docs",
                "api",
                "configuration",
                "deployment",
                "troubleshoot",
                "dynamo",
                "openshell",
                "aiperf",
                "nvcf",
                "dsx",
            )
        ),
        "uploaded": any(
            token in q
            for token in (
                "uploaded",
                "my document",
                "my pdf",
                "the pdf",
                "documentref",
            )
        ),
        "workspace": any(
            token in q
            for token in (
                "my email",
                "gmail",
                "inbox",
                "my calendar",
                "schedule",
                "free time",
            )
        ),
        "news_or_cards": any(
            token in q for token in ("news", "image", "shopping", "google")
        ),
    }


def _preferred_source_ids(question: str, depth: str) -> list[str]:
    flags = _question_flags(question)
    preferred: list[str] = []

    if flags["uploaded"]:
        preferred.append("uploaded_documents")
    if flags["workspace"]:
        preferred.append("workspace_data")
    if flags["docs"]:
        preferred.append("nvidia_docs")
    if flags["has_url"]:
        preferred.append("known_url_scrape")
    if flags["current"]:
        preferred.extend(["curated_feeds", "perplexity_search", "google_search"])
    if flags["broad"] or depth == "deep":
        preferred.extend(["curated_domains", "perplexity_search", "google_search"])
    if flags["news_or_cards"]:
        preferred.append("google_search")

    preferred.append("curated_domains")
    preferred.append("perplexity_search")
    preferred.append("google_search")

    ordered: list[str] = []
    seen: set[str] = set()
    for source_id in preferred:
        if source_id not in seen:
            seen.add(source_id)
            ordered.append(source_id)
    return ordered


def _source_reason(source_id: str, question: str, depth: str) -> str:
    flags = _question_flags(question)
    reasons = {
        "curated_domains": "Use curated corpora for stable background and primary reference passages.",
        "curated_feeds": "Use recent trusted feeds for current announcements or latest-source checks.",
        "google_search": "Use SerpAPI internet search for discovery, news cards, images, shopping, or corroboration.",
        "perplexity_search": "Use Perplexity internet search for ranked web sources, snippets, publication dates, and freshness metadata.",
        "known_url_scrape": "Use only after a specific URL is already known.",
        "uploaded_documents": "Use when the question is about authenticated uploaded documents.",
        "workspace_data": "Use when the question is about authenticated email or calendar data.",
        "nvidia_docs": "Route official NVIDIA product documentation questions to the docs specialist.",
    }
    reason = reasons.get(
        source_id, "Use this selected source when it matches the user's constraints."
    )
    if depth == "deep" and source_id in {"google_search", "perplexity_search"}:
        reason += " Deep research should pair internet search with independent curated or known-URL sources when available."
    if flags["current"] and source_id == "curated_domains":
        reason += " Pair with a current source before making latest/current claims."
    return reason


def _tool_hints(source_id: str, question: str) -> list[dict[str, str]]:
    q = question.lower()
    if source_id == "curated_domains":
        domain = "nvidia"
        if any(token in q for token in ("kubernetes", "k8s", "helm", "pod")):
            domain = "kubernetes"
        elif any(token in q for token in ("semianalysis", "gpu market", "capex")):
            domain = "semianalysis"
        elif any(token in q for token in ("veterinary", "clinic", "vet")):
            domain = "veterinarian"
        elif any(token in q for token in ("mental health", "therapy", "clinical")):
            domain = "mentalhealth"
        return [{"tool": "domain_retriever_tool", "domain": domain}]

    if source_id == "curated_feeds":
        feed_scope = "auto"
        if "nvidia" in q:
            feed_scope = "nvidia_blog"
        if any(token in q for token in ("developer", "cuda", "nemo", "inference")):
            feed_scope = "nvidia_developer"
        if any(token in q for token in ("press", "partnership", "earnings")):
            feed_scope = "nvidia_newsroom"
        if "semianalysis" in q:
            feed_scope = "semianalysis"
        return [{"tool": "curated_feed_search_tool", "feed_scope": feed_scope}]

    if source_id == "google_search":
        search_type = "organic"
        if "news" in q or "latest" in q or "recent" in q:
            search_type = "news"
        elif "image" in q:
            search_type = "images"
        elif "shopping" in q:
            search_type = "shopping"
        return [{"tool": "serpapi_search_tool", "search_type": search_type}]

    if source_id == "perplexity_search":
        hint = {"tool": "perplexity_search_tool"}
        if "latest" in q or "recent" in q or "news" in q:
            hint["search_recency_filter"] = "week"
        return [hint]

    if source_id == "known_url_scrape":
        return [{"tool": "webscrape_tool"}]
    if source_id == "uploaded_documents":
        return [{"tool": "user_document_tool"}]
    if source_id == "workspace_data":
        return [{"tool": "gmail_mcp_server"}, {"tool": "calendar_mcp_server"}]
    if source_id == "nvidia_docs":
        return [
            {"tool": "dynamo_mcp_server"},
            {"tool": "openshell_mcp_server"},
            {"tool": "aistore_mcp_server"},
            {"tool": "aiperf_mcp_server"},
            {"tool": "nvcf_mcp_server"},
            {"tool": "dsx_mcp_server"},
        ]
    return []


def _safe_audit_url(url: str) -> tuple[bool, str | None]:
    parsed = urlparse(url.strip())
    hostname = (parsed.hostname or "").lower()
    if hostname in _PLACEHOLDER_HOSTS:
        return False, "placeholder_url"
    try:
        validate_public_url(url, check_dns=False)
    except UnsafeURLError as exc:
        return False, f"unsafe_url: {exc}"
    return True, None


def _renumber_markdown_citations(
    body: str,
    reference_lines: list[str],
    valid_numbers: set[int],
) -> tuple[str, str, dict[int, int]]:
    ordered = sorted(valid_numbers)
    mapping = {old: new for new, old in enumerate(ordered, 1)}

    def replace_inline(match: re.Match[str]) -> str:
        old = int(match.group(1))
        if old not in mapping:
            return ""
        return f"[{mapping[old]}]"

    repaired_body = _INLINE_CITATION_RE.sub(replace_inline, body)
    repaired_ref_lines: list[str] = []
    for line in reference_lines:
        match = _CITATION_LINE_RE.match(line)
        if not match:
            repaired_ref_lines.append(line)
            continue
        old = int(match.group(2))
        if old not in mapping:
            continue
        repaired_ref_lines.append(f"{match.group(1)}[{mapping[old]}]{match.group(3)}")
    return repaired_body, "\n".join(repaired_ref_lines).strip(), mapping


# ---------------------------------------------------------------------------
# LLM prompts
# ---------------------------------------------------------------------------
_VERIFY_CLAIM_SYSTEM = """\
Role: source verification specialist.

Goal: determine whether the provided source content supports the given claim.

Rules:
- Mark a claim as "supported" only when the source explicitly states or directly
  implies the claim with specific evidence.
- Absence of contradiction is NOT support. The source must actively confirm.
- For claims about "current", "latest", "officially disclosed", leadership,
  titles, versions, dates, or numeric values, every decision-critical field
  must be supported by the source.
- A version-specific release note is not proof of latest/current unless the
  source itself says it is latest/current. Prefer official latest/ docs pages,
  release indexes, or package indexes for latest/current claims.
- Placeholder URLs such as example.com are not valid support.
- "partially_supported" means the source confirms some aspects but not others,
  or the source's numbers/details differ slightly from the claim. A partially
  supported claim is not safe to store as a durable finding.
- "unsupported" means the source does not contain evidence for the claim, or
  actively contradicts it.
- "insufficient_context" means the source content is too short, generic, or
  off-topic to make a determination.

Output: return JSON only, with no markdown fences, using exactly these fields:
{
  "verdict": "supported" | "partially_supported" | "unsupported" | "insufficient_context",
  "confidence": <float 0.0-1.0>,
  "evidence": "<direct quote or close paraphrase from source, max 200 words, or null if none>",
  "reasoning": "<1-2 sentences explaining your assessment>",
  "claim_issues": ["<specific factual error or unsupported assertion>", ...]
}"""

_VERIFY_SYNTHESIS_SYSTEM = """\
Role: synthesis verification specialist.

Goal: assess whether a synthesis memory's cross-domain conclusions are logically
warranted by its constituent claims.

Assess whether:
1. The stated connections follow logically from the constituent claims.
2. The conclusions are warranted (not overgeneralized).
3. There are any logical leaps, unsupported generalizations, or spurious
   connections.

Output: return JSON only, with no markdown fences, using exactly these fields:
{
  "verdict": "sound" | "partially_sound" | "unsound",
  "confidence": <float 0.0-1.0>,
  "reasoning": "<2-3 sentences explaining your assessment>",
  "logic_issues": ["<specific logical problem>", ...]
}"""


# ---------------------------------------------------------------------------
# Registered function
# ---------------------------------------------------------------------------
@register_function(config_type=SourceVerifierConfig)
async def source_verifier_function(config: SourceVerifierConfig, builder: Builder):
    enabled = set(config.enabled_operations or [])

    def _enabled(operation: str) -> bool:
        return not enabled or operation in enabled

    # ------------------------------------------------------------------
    # Tool 1 -- verify_claim
    # ------------------------------------------------------------------
    async def verify_claim(
        claim: str,
        source_url: str,
        context: str = "",
    ) -> str:
        """Verify whether a source URL actually supports a specific claim.

        Fetches the URL, analyzes the content with an LLM, and returns a
        structured verdict. Call this BEFORE storing any finding in memory
        to prevent citation hallucination.

        Args:
            claim: The factual claim to verify. Should be a clear,
                specific statement (e.g., the BLUF from a finding).
            source_url: The URL that allegedly supports the claim.
            context: Optional context about how the claim will be used
                (e.g., "storing as a finding about GPU performance").

        Returns:
            JSON verdict with: verdict (supported/partially_supported/
            unsupported/source_unreachable), confidence score, evidence
            excerpt, reasoning, and any claim issues found.
        """
        if not claim or not claim.strip():
            return json.dumps(
                {
                    "verdict": "error",
                    "source_url": source_url,
                    "reasoning": "No claim provided to verify.",
                }
            )

        if not source_url or not source_url.strip():
            return json.dumps(
                {
                    "verdict": "source_unreachable",
                    "confidence": 0.0,
                    "source_url": "",
                    "source_reachable": False,
                    "fetch_status": "missing",
                    "evidence": None,
                    "reasoning": "No source URL provided. Cannot verify without a source.",
                    "claim_issues": ["No source_url supplied"],
                }
            )

        parsed_url = urlparse(source_url.strip())
        hostname = (parsed_url.hostname or "").lower()
        if hostname in _PLACEHOLDER_HOSTS:
            return json.dumps(
                {
                    "verdict": "unsupported",
                    "confidence": 1.0,
                    "source_url": source_url,
                    "source_reachable": False,
                    "fetch_status": "placeholder_url",
                    "evidence": None,
                    "reasoning": "Placeholder URLs cannot support factual claims.",
                    "claim_issues": ["placeholder_source_url"],
                }
            )

        # Fetch the source
        fetch = await _fetch_source(source_url.strip(), config)

        if fetch.status != "ok":
            return json.dumps(
                {
                    "verdict": "source_unreachable",
                    "confidence": 0.0,
                    "source_url": source_url,
                    "source_reachable": False,
                    "fetch_status": fetch.status,
                    "evidence": None,
                    "reasoning": f"Could not fetch source: {fetch.error or fetch.status}.",
                    "claim_issues": [
                        f"source_url {fetch.status}: {fetch.error or 'no content'}"
                    ],
                }
            )

        # Truncate source content if needed
        content = fetch.content or ""
        if len(content) > config.max_source_chars:
            content = content[: config.max_source_chars] + "\n\n[Content truncated]"

        # Build verification prompt
        context_line = f"\nCONTEXT: {context}" if context else ""
        user_prompt = (
            f"CLAIM: {claim}\n"
            f"{context_line}\n"
            f"SOURCE URL: {source_url}\n\n"
            f"SOURCE CONTENT:\n{content}\n\n"
            f"Assess whether this source supports the claim. Be conservative."
        )

        raw = await _call_llm(
            builder,
            config,
            _VERIFY_CLAIM_SYSTEM,
            user_prompt,
            llm_name=config.fast_llm_name,
        )

        # Parse and enrich the LLM response
        parsed = _parse_llm_json(raw)
        if not parsed:
            # LLM didn't return valid JSON; wrap the raw response
            return json.dumps(
                {
                    "verdict": "error",
                    "source_url": source_url,
                    "source_reachable": True,
                    "reasoning": f"Verification LLM returned unparseable response: {raw[:500]}",
                    "claim_issues": ["verification_parse_error"],
                }
            )

        # Enrich with source metadata
        parsed["source_url"] = source_url
        parsed["source_reachable"] = True
        return json.dumps(parsed, indent=2)

    # ------------------------------------------------------------------
    # Tool 2 -- plan_sources
    # ------------------------------------------------------------------
    async def plan_sources(
        research_question: str,
        selected_sources_json: str = "",
        disabled_sources_json: str = "",
        depth: str = "auto",
    ) -> str:
        """Plan the source strategy for a research request.

        Args:
            research_question: The user's research request.
            selected_sources_json: Optional JSON/list/comma source IDs to use.
                When omitted, default-enabled sources are available.
            disabled_sources_json: Optional JSON/list/comma source IDs to
                exclude for this request.
            depth: auto, quick, or deep.

        Returns:
            JSON source plan with selected sources, recommended tool sequence,
            unknown source IDs, blocked tools, and citation-ledger contract.
        """
        question = (research_question or "").strip()
        normalized_depth = (depth or "auto").strip().lower()
        if normalized_depth not in {"auto", "quick", "deep"}:
            normalized_depth = "auto"

        if not question:
            return json.dumps(
                {
                    "passed": False,
                    "reason": "research_question is required",
                    "selected_sources": [],
                    "recommended_tool_sequence": [],
                },
                indent=2,
            )

        registry = [
            entry
            for entry in (
                _normalize_source_entry(item) for item in config.source_registry
            )
            if entry["id"]
        ]
        by_id = {entry["id"]: entry for entry in registry}
        default_ids = {
            entry["id"] for entry in registry if entry.get("default_enabled", True)
        }

        selected, requested_ids = _parse_source_ids(selected_sources_json)
        disabled, disabled_ids = _parse_source_ids(disabled_sources_json)
        selected_ids = set(default_ids if selected is None else selected)
        disabled = disabled or set()

        unknown_sources = sorted((selected_ids | disabled) - set(by_id))
        selected_ids = (selected_ids - disabled) & set(by_id)

        preferred_depth = (
            "deep"
            if normalized_depth == "auto" and _question_flags(question)["broad"]
            else normalized_depth
        )
        preferred_ids = _preferred_source_ids(question, preferred_depth)
        ordered_ids = [
            source_id for source_id in preferred_ids if source_id in selected_ids
        ]
        ordered_ids.extend(
            sorted(
                source_id for source_id in selected_ids if source_id not in ordered_ids
            )
        )

        selected_sources = [by_id[source_id] for source_id in ordered_ids]
        recommended = [
            {
                "source_id": source["id"],
                "name": source["name"],
                "tools": source["tools"],
                "reason": _source_reason(source["id"], question, preferred_depth),
                "hints": _tool_hints(source["id"], question),
            }
            for source in selected_sources
        ]
        blocked_tools = [
            tool
            for source_id in sorted(disabled & set(by_id))
            for tool in by_id[source_id]["tools"]
        ]
        warnings: list[str] = []
        if requested_ids:
            warnings.append(f"selected source override applied: {requested_ids}")
        if disabled_ids:
            warnings.append(f"disabled source override applied: {disabled_ids}")
        if unknown_sources:
            warnings.append(f"unknown source ids ignored: {unknown_sources}")
        if not selected_sources:
            warnings.append("no usable sources selected")

        broad = _question_flags(question)["broad"] or preferred_depth == "deep"
        approval_recommended = broad and len(recommended) >= 3

        return json.dumps(
            {
                "passed": bool(selected_sources),
                "depth": preferred_depth,
                "available_sources": registry,
                "selected_sources": selected_sources,
                "recommended_tool_sequence": recommended,
                "blocked_tools": blocked_tools,
                "unknown_sources": unknown_sources,
                "warnings": warnings,
                "approval_recommended": approval_recommended,
                "source_ledger_contract": {
                    "capture_fields": ["url", "title", "tool", "source_id"],
                    "audit_tool": "citation_auditor_tool.audit_citations",
                    "rule": (
                        "Only final URLs observed from selected source tools may "
                        "appear in the References section."
                    ),
                },
            },
            indent=2,
        )

    # ------------------------------------------------------------------
    # Tool 3 -- audit_citations
    # ------------------------------------------------------------------
    async def audit_citations(
        answer_markdown: str,
        source_urls_json: str = "",
        require_references: bool = True,
    ) -> str:
        """Audit markdown citations against an optional source URL ledger.

        This is a deterministic guard inspired by AI-Q's source registry:
        the agent provides its draft answer and the URLs it actually saw in
        tool results. The audit validates reference URLs, strips orphaned
        inline citations, and returns repaired markdown for one revision pass.

        Args:
            answer_markdown: Draft answer or report with inline [N] citations.
            source_urls_json: Optional JSON/list/text of source URLs observed in
                tool outputs. When provided, every reference URL must match it
                after lightweight normalization.
            require_references: If true, fail when a references/sources section
                is missing or no valid citations remain.

        Returns:
            JSON with passed, valid_citations, invalid_citations, warnings, and
            repaired_markdown.
        """
        if not answer_markdown or not answer_markdown.strip():
            return json.dumps(
                {
                    "passed": False,
                    "valid_citations": [],
                    "invalid_citations": [
                        {
                            "reason": "missing_answer_markdown",
                            "detail": "No answer_markdown was provided.",
                        }
                    ],
                    "warnings": [],
                    "repaired_markdown": "",
                },
                indent=2,
            )

        allowed_urls = _parse_source_urls(source_urls_json)
        allowed_norms = {_normalize_audit_url(url): url for url in allowed_urls}
        invalid: list[dict] = []
        warnings: list[str] = []
        valid: list[dict] = []

        match = _REFERENCE_SECTION_RE.search(answer_markdown)
        if not match:
            if require_references:
                invalid.append(
                    {
                        "reason": "missing_references_section",
                        "detail": "No References or Sources section was found.",
                    }
                )
            for url in _extract_urls(answer_markdown):
                safe, reason = _safe_audit_url(url)
                if not safe:
                    invalid.append({"reason": reason, "url": url})
            return json.dumps(
                {
                    "passed": not invalid,
                    "allowed_source_count": len(allowed_urls),
                    "valid_citations": valid,
                    "invalid_citations": invalid,
                    "warnings": warnings,
                    "repaired_markdown": answer_markdown.strip(),
                },
                indent=2,
            )

        body = answer_markdown[: match.start()]
        ref_section = answer_markdown[match.start() :]
        reference_lines = ref_section.splitlines()
        valid_numbers: set[int] = set()
        seen_ref_urls: dict[str, int] = {}

        for line in reference_lines:
            line_match = _CITATION_LINE_RE.match(line)
            if not line_match:
                continue
            number = int(line_match.group(2))
            urls = _extract_urls(line_match.group(3))
            if not urls:
                invalid.append(
                    {
                        "number": number,
                        "reason": "missing_reference_url",
                        "line": line.strip(),
                    }
                )
                continue
            url = urls[0]
            normalized = _normalize_audit_url(url)
            safe, reason = _safe_audit_url(url)
            if not safe:
                invalid.append(
                    {
                        "number": number,
                        "reason": reason,
                        "url": url,
                        "line": line.strip(),
                    }
                )
                continue
            if allowed_norms and normalized not in allowed_norms:
                invalid.append(
                    {
                        "number": number,
                        "reason": "url_not_in_source_ledger",
                        "url": url,
                        "line": line.strip(),
                    }
                )
                continue
            if normalized in seen_ref_urls:
                canonical = seen_ref_urls[normalized]
                invalid.append(
                    {
                        "number": number,
                        "reason": f"duplicate_of_citation_{canonical}",
                        "url": url,
                        "line": line.strip(),
                    }
                )
                continue

            seen_ref_urls[normalized] = number
            valid_numbers.add(number)
            valid.append({"number": number, "url": url})

        inline_numbers = {int(value) for value in _INLINE_CITATION_RE.findall(body)}
        orphaned = sorted(inline_numbers - valid_numbers)
        if orphaned:
            invalid.append(
                {
                    "reason": "orphaned_inline_citations",
                    "numbers": orphaned,
                }
            )
        uncited = sorted(valid_numbers - inline_numbers)
        if uncited:
            warnings.append(f"references not cited in body: {uncited}")

        if require_references and not valid_numbers:
            invalid.append(
                {
                    "reason": "no_valid_citations",
                    "detail": "No reference entries survived validation.",
                }
            )

        repaired_body, repaired_refs, renumber_map = _renumber_markdown_citations(
            body,
            reference_lines,
            valid_numbers,
        )
        repaired = repaired_body.rstrip()
        if repaired_refs:
            repaired = f"{repaired}\n\n{repaired_refs}".strip()

        return json.dumps(
            {
                "passed": not invalid,
                "allowed_source_count": len(allowed_urls),
                "valid_citations": valid,
                "invalid_citations": invalid,
                "warnings": warnings,
                "renumber_map": renumber_map,
                "repaired_markdown": repaired,
            },
            indent=2,
        )

    # ------------------------------------------------------------------
    # Tool 4 -- verify_memory
    # ------------------------------------------------------------------
    async def verify_memory(
        memory_text: str,
        metadata_json: str = "",
    ) -> str:
        """Verify an existing memory entry's citations and claims.

        Routes verification by memory type:
        - finding/project_update: verifies source_url supports the BLUF claim
        - synthesis: assesses whether stated connections are logically sound
        - cycle_report/dream: skipped (meta-observations, not factual claims)

        Also checks reachability of all inline markdown links.

        Args:
            memory_text: The full memory text (BLUF + context + source link).
            metadata_json: JSON string of the memory's metadata
                (key_value_pairs). Should include 'type' and 'source_url'.

        Returns:
            JSON verification report with status, issues, inline link
            checks, and a recommendation (retain/flag_for_review/remove).
        """
        # Parse metadata
        try:
            metadata = json.loads(metadata_json) if metadata_json else {}
        except (json.JSONDecodeError, TypeError):
            metadata = {}

        mem_type = metadata.get("type", "unknown")
        source_url = metadata.get("source_url", "")

        # Extract inline links from memory text
        inline_links = _extract_markdown_links(memory_text)

        # Skip non-factual memory types
        if mem_type in ("cycle_report", "dream"):
            return json.dumps(
                {
                    "memory_type": mem_type,
                    "verification_status": "skipped",
                    "source_url_status": "n/a",
                    "claim_verdict": None,
                    "inline_links": [],
                    "issues": [],
                    "recommendation": "retain",
                }
            )

        issues: list[str] = []

        # Check inline link reachability (concurrent)
        link_results = []
        if inline_links:
            reachable_checks = await asyncio.gather(
                *[_check_link_reachable(link["url"]) for link in inline_links],
                return_exceptions=True,
            )
            for link, reachable in zip(inline_links, reachable_checks):
                is_ok = reachable is True
                link_results.append({"url": link["url"], "reachable": is_ok})
                if not is_ok:
                    issues.append(f"Inline link unreachable: {link['url']}")

        # Handle synthesis type separately
        if mem_type == "synthesis":
            synthesis_prompt = (
                f"SYNTHESIS MEMORY:\n{memory_text}\n\n"
                f"METADATA: {json.dumps(metadata)}\n\n"
                f"Assess the logical soundness of this synthesis."
            )
            raw = await _call_llm(
                builder,
                config,
                _VERIFY_SYNTHESIS_SYSTEM,
                synthesis_prompt,
                llm_name=config.llm_name,
            )
            parsed = _parse_llm_json(raw)
            verdict_map = {
                "sound": "verified",
                "partially_sound": "partially_verified",
                "unsound": "failed",
            }
            synth_verdict = parsed.get("verdict", "")
            status = verdict_map.get(synth_verdict, "failed")
            if parsed.get("logic_issues"):
                issues.extend(parsed["logic_issues"])

            recommendation = "retain"
            if status == "failed":
                recommendation = "flag_for_review"
            elif issues:
                recommendation = "flag_for_review"

            return json.dumps(
                {
                    "memory_type": mem_type,
                    "verification_status": status,
                    "source_url_status": "n/a",
                    "claim_verdict": parsed,
                    "inline_links": link_results,
                    "issues": issues,
                    "recommendation": recommendation,
                },
                indent=2,
            )

        # For findings and project_updates: verify source_url
        if not source_url:
            # Try to extract URL from inline links as fallback
            if inline_links:
                source_url = inline_links[0]["url"]
            else:
                issues.append("No source_url in metadata and no inline links found")
                return json.dumps(
                    {
                        "memory_type": mem_type,
                        "verification_status": "failed",
                        "source_url_status": "missing",
                        "claim_verdict": None,
                        "inline_links": link_results,
                        "issues": issues,
                        "recommendation": "flag_for_review",
                    },
                    indent=2,
                )

        # Extract the BLUF claim (first sentence or up to first period)
        claim = memory_text.strip()
        if claim.startswith("BLUF:"):
            claim = claim[5:].strip()
        # Use up to the first two sentences as the claim
        sentences = claim.split(". ")
        if len(sentences) > 2:
            claim = ". ".join(sentences[:2]) + "."

        # Call verify_claim internally
        claim_result_raw = await verify_claim(
            claim=claim,
            source_url=source_url,
            context=f"Verifying a stored {mem_type} memory",
        )
        claim_result = json.loads(claim_result_raw)

        # Determine overall status
        verdict = claim_result.get("verdict", "")
        if verdict == "supported":
            status = "verified"
        elif verdict == "partially_supported":
            status = "partially_verified"
        elif verdict == "source_unreachable":
            status = "partially_verified"
            issues.append("Source URL is currently unreachable")
        else:
            status = "failed"

        if claim_result.get("claim_issues"):
            issues.extend(claim_result["claim_issues"])

        source_url_status = "reachable"
        if not claim_result.get("source_reachable", True):
            source_url_status = "unreachable"

        recommendation = "retain"
        if status == "failed":
            recommendation = "remove"
        elif status == "partially_verified" or issues:
            recommendation = "flag_for_review"

        return json.dumps(
            {
                "memory_type": mem_type,
                "verification_status": status,
                "source_url_status": source_url_status,
                "claim_verdict": claim_result,
                "inline_links": link_results,
                "issues": issues,
                "recommendation": recommendation,
            },
            indent=2,
        )

    # ------------------------------------------------------------------
    # Tool 5 -- audit_memories
    # ------------------------------------------------------------------
    async def audit_memories(
        memories_json: str,
        verify_sources: bool = True,
    ) -> str:
        """Batch-verify a set of memories for citation quality.

        Pass the output of get_memory as memories_json. Each memory should
        have 'text' and optionally 'metadata' fields. Checks each memory's
        sources and claims, returns a structured audit report.

        Usage: call get_memory(query=..., top_k=N) first, then pass the
        results here for verification.

        Args:
            memories_json: JSON string containing an array of memory objects.
                Each object should have at minimum a 'text' field and ideally
                a 'metadata' field with 'type' and 'source_url'. The format
                from get_memory is accepted directly.
            verify_sources: If true (default), fetch and verify source URLs.
                If false, only check link reachability and metadata
                completeness (faster but less thorough).

        Returns:
            JSON audit report with per-memory verdicts, aggregate counts,
            and a human-readable summary with recommendations.
        """
        try:
            memories = json.loads(memories_json) if memories_json else []
        except (json.JSONDecodeError, TypeError):
            return json.dumps(
                {
                    "error": "Invalid memories_json: could not parse as JSON array.",
                    "total_memories": 0,
                }
            )

        if not isinstance(memories, list):
            # Try to handle a single memory object
            if isinstance(memories, dict):
                memories = [memories]
            else:
                return json.dumps(
                    {
                        "error": "memories_json must be a JSON array of memory objects.",
                        "total_memories": 0,
                    }
                )

        if not memories:
            return json.dumps(
                {
                    "total_memories": 0,
                    "verified": 0,
                    "failed": 0,
                    "skipped": 0,
                    "unreachable": 0,
                    "results": [],
                    "summary": "No memories to audit.",
                }
            )

        results = []
        counts = {
            "verified": 0,
            "partially_verified": 0,
            "failed": 0,
            "skipped": 0,
            "unreachable": 0,
        }

        for mem in memories:
            if isinstance(mem, str):
                # Plain text memory with no metadata
                mem = {"text": mem}

            text = mem.get("text", mem.get("memory", ""))
            metadata = mem.get("metadata", mem.get("key_value_pairs", {}))
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except (json.JSONDecodeError, TypeError):
                    metadata = {}

            # Get the inner key_value_pairs if present
            if "key_value_pairs" in metadata:
                metadata = metadata["key_value_pairs"]

            if not text:
                results.append(
                    {
                        "memory_preview": "(empty)",
                        "type": metadata.get("type", "unknown"),
                        "verification_status": "skipped",
                        "issues": ["Empty memory text"],
                    }
                )
                counts["skipped"] += 1
                continue

            preview = text[:120] + "..." if len(text) > 120 else text

            if not verify_sources:
                # Lightweight check: metadata completeness + link reachability
                mem_type = metadata.get("type", "unknown")
                mem_issues = []
                if mem_type in ("finding", "project_update") and not metadata.get(
                    "source_url"
                ):
                    links = _extract_markdown_links(text)
                    if not links:
                        mem_issues.append("Missing source_url and no inline links")
                results.append(
                    {
                        "memory_preview": preview,
                        "type": mem_type,
                        "verification_status": "skipped"
                        if not mem_issues
                        else "flag_for_review",
                        "issues": mem_issues,
                    }
                )
                if mem_issues:
                    counts["failed"] += 1
                else:
                    counts["skipped"] += 1
                continue

            # Full verification
            result_raw = await verify_memory(
                memory_text=text,
                metadata_json=json.dumps(metadata),
            )
            result = json.loads(result_raw)
            status = result.get("verification_status", "failed")

            # Count unreachable as a separate category
            source_status = result.get("source_url_status", "")
            if source_status == "unreachable":
                counts["unreachable"] += 1
            elif status in counts:
                counts[status] += 1
            else:
                counts["failed"] += 1

            results.append(
                {
                    "memory_preview": preview,
                    "type": result.get("memory_type", "unknown"),
                    "verification_status": status,
                    "source_url": metadata.get("source_url", ""),
                    "issues": result.get("issues", []),
                    "recommendation": result.get("recommendation", ""),
                }
            )

        # Build summary
        total = len(memories)
        parts = []
        if counts["verified"]:
            parts.append(f"{counts['verified']} verified")
        if counts["partially_verified"]:
            parts.append(f"{counts['partially_verified']} partially verified")
        if counts["failed"]:
            parts.append(f"{counts['failed']} failed")
        if counts["unreachable"]:
            parts.append(f"{counts['unreachable']} unreachable")
        if counts["skipped"]:
            parts.append(f"{counts['skipped']} skipped")

        summary = f"{total} memories audited: {', '.join(parts)}."

        failed_items = [r for r in results if r.get("verification_status") == "failed"]
        if failed_items:
            summary += f" {len(failed_items)} memories should be reviewed or removed."

        return json.dumps(
            {
                "total_memories": total,
                "verified": counts["verified"],
                "partially_verified": counts["partially_verified"],
                "failed": counts["failed"],
                "unreachable": counts["unreachable"],
                "skipped": counts["skipped"],
                "results": results,
                "summary": summary,
            },
            indent=2,
        )

    # ------------------------------------------------------------------
    # Register all tools with NAT
    # ------------------------------------------------------------------
    try:
        if _enabled("verify_claim"):
            yield FunctionInfo.from_fn(
                verify_claim,
                description=(
                    "Verify whether a source URL actually supports a claimed fact. "
                    "Fetches the URL, uses LLM analysis to assess support. Returns "
                    "structured verdict: supported/partially_supported/unsupported/"
                    "source_unreachable with evidence excerpts and confidence score. "
                    "Call this on the exact final claim BEFORE storing any finding "
                    "in memory to prevent citation hallucination. Store memory only "
                    "when verdict is 'supported'; do not store partially_supported, "
                    "unsupported, or source_unreachable claims."
                ),
            )

        if _enabled("plan_sources"):
            yield FunctionInfo.from_fn(
                plan_sources,
                description=(
                    "Plan a research source strategy from Daedalus's source "
                    "registry. Args: research_question, optional "
                    "selected_sources_json, disabled_sources_json, and depth "
                    "(auto/quick/deep). Returns selected sources, recommended "
                    "tool sequence, blocked tools, warnings, approval hint, and "
                    "the citation source-ledger contract. Use before deep "
                    "research and when the user requests source inclusions or "
                    "exclusions."
                ),
            )

        if _enabled("audit_citations"):
            yield FunctionInfo.from_fn(
                audit_citations,
                description=(
                    "Deterministically audit a markdown answer's [N] citations "
                    "and References/Sources URLs against an optional JSON source "
                    "ledger captured from tool results. Returns passed, "
                    "invalid_citations, warnings, and repaired_markdown. Use before "
                    "finalizing citation-backed research reports; revise once when "
                    "passed is false."
                ),
            )

        if _enabled("verify_memory"):
            yield FunctionInfo.from_fn(
                verify_memory,
                description=(
                    "Verify an existing memory entry's citations and logical "
                    "soundness. Pass the memory text and its metadata JSON. "
                    "For findings: checks source_url reachability and verifies "
                    "claims against the source. For syntheses: assesses whether "
                    "connections are logically sound. Returns verification status, "
                    "issues, and recommendation (retain/flag_for_review/remove)."
                ),
            )

        if _enabled("audit_memories"):
            yield FunctionInfo.from_fn(
                audit_memories,
                description=(
                    "Batch-verify a set of memories for citation quality. First "
                    "call get_memory to retrieve memories, then pass the results "
                    "here as memories_json. Returns a structured audit report with "
                    "per-memory verdicts, aggregate counts (verified/failed/"
                    "unreachable/skipped), and recommendations. Use during memory "
                    "maintenance cycles to catch dead links and unsupported claims."
                ),
            )

    except GeneratorExit:
        logger.warning("source_verifier function exited early!")
    finally:
        logger.info("Cleaning up source_verifier function.")
