"""Source citation verification for NeMo Agent Toolkit.

Registers one typed evidence dispatcher with NAT:

  verify_claim      Fetch a source URL and assess whether it actually
                    supports a specific claim.  Returns a structured
                    verdict (supported / partially_supported / unsupported /
                    source_unreachable) with evidence excerpts.

  audit_citations   Deterministically audit a markdown answer's inline
                    citations and reference URLs against an optional source
                    ledger captured from tool results.

  plan_sources      Choose an allowed source/tool strategy from a small
                    source registry before research begins.

Designed to combat hallucination compounding in autonomous agent cycles
where uncited or incorrectly cited claims accumulate in memory over time.

Reuses webscrape's pinned public HTTP fetch and local-file conversion for
source retrieval without consuming a tool call. Claim verification is driven
by a provider-neutral critic using any LLM configured in NeMo Agent Toolkit.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from itertools import islice
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from pydantic import BaseModel, ConfigDict, Field
from source_verifier.critic import CriticResponseError, LLMClaimCritic
from webscrape.webscrape_function import (
    _httpx_timeout_from_seconds,
    _is_challenge_page,
    _is_valid_content,
    _scrape_with_httpx_result,
    _validate_url,
)

logger = logging.getLogger(__name__)

SourceVerifierOperation = Literal["verify_claim", "plan_sources", "audit_citations"]
_ALL_OPERATIONS = ("verify_claim", "plan_sources", "audit_citations")
_DISPATCH_DESCRIPTION = (
    "Evidence dispatcher with a required operation. "
    "operation=verify_claim uses claim, source_url, and optional context to check "
    "one exact public-source claim before storing a finding. "
    "operation=plan_sources uses research_question, optional selected_sources_json, "
    "disabled_sources_json, and depth to recommend a source strategy. "
    "operation=audit_citations uses answer_markdown, optional source_urls_json, "
    "and require_references to check numbered Markdown citations. "
    "Planning does not gather evidence or authorize extra work; citation auditing "
    "does not establish factual support or validate briefing HTML."
)


class SourceVerifierInput(BaseModel):
    """One callable schema for all evidence operations."""

    model_config = ConfigDict(extra="forbid")

    operation: SourceVerifierOperation
    claim: str = Field(default="", description="Exact final claim for verify_claim.")
    source_url: str = Field(
        default="", description="Public source URL for verify_claim."
    )
    context: str = Field(default="", description="Optional claim context.")
    research_question: str = Field(default="", description="Required for plan_sources.")
    selected_sources_json: str = Field(
        default="", description="Source IDs as a JSON array or comma-separated text."
    )
    disabled_sources_json: str = Field(default="", description="Source IDs to exclude.")
    depth: Literal["auto", "quick", "deep"] = "auto"
    answer_markdown: str = Field(
        default="", description="Required for audit_citations."
    )
    source_urls_json: str = Field(default="", description="Observed source URL ledger.")
    require_references: bool = True


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
_REFERENCE_SECTION_RE = re.compile(
    r"^(?:#{2,3}\s+(?:Sources|References)|\*\*References:?\*\*)",
    re.MULTILINE | re.IGNORECASE,
)
_CITATION_LINE_RE = re.compile(r"^(\s*[-*]?\s*)\[(\d+)\](\s+.+)$")
_INLINE_CITATION_RE = re.compile(r"(?<!\w)\[(\d+)\](?!\w)")
_SOURCE_OMISSION_MARKER = "\n\n[... source content omitted ...]\n\n"
_CLAIM_STOPWORDS = {
    "about",
    "after",
    "against",
    "before",
    "from",
    "into",
    "that",
    "their",
    "there",
    "these",
    "this",
    "those",
    "with",
}


def _claim_focused_excerpt(
    content: str,
    claim: str,
    max_chars: int,
) -> tuple[str, bool]:
    """Keep beginning, claim-dense, and ending spans within a hard bound."""

    if len(content) <= max_chars:
        return content, False

    terms = [
        term
        for term in dict.fromkeys(re.findall(r"[\w.-]{4,}", claim.casefold()))
        if term not in _CLAIM_STOPWORDS
    ][:16]
    lowered = content.casefold()
    match_positions: list[int] = []
    for term in terms:
        match_positions.extend(
            match.start() for match in islice(re.finditer(re.escape(term), lowered), 32)
        )

    if not match_positions:
        available = max_chars - len(_SOURCE_OMISSION_MARKER)
        head_chars = (available + 1) // 2
        tail_chars = available - head_chars
        return (
            content[:head_chars] + _SOURCE_OMISSION_MARKER + content[-tail_chars:]
        ), True

    content_budget = max_chars - (2 * len(_SOURCE_OMISSION_MARKER))
    side_chars = content_budget // 4
    focus_chars = content_budget - (2 * side_chars)

    def match_score(position: int) -> int:
        start = max(0, position - (focus_chars // 2))
        window = lowered[start : start + focus_chars]
        return sum(term in window for term in terms)

    focus_position = max(match_positions, key=match_score)
    focus_start = max(0, focus_position - (focus_chars // 2))
    focus_start = min(focus_start, len(content) - focus_chars)
    spans = [
        (0, side_chars),
        (focus_start, focus_start + focus_chars),
        (len(content) - side_chars, len(content)),
    ]
    merged: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    excerpt = _SOURCE_OMISSION_MARKER.join(content[start:end] for start, end in merged)
    return excerpt[:max_chars], True


def _default_source_registry() -> list[dict[str, Any]]:
    """Default Daedalus source registry used by plan_sources."""
    return [
        {
            "id": "curated_domains",
            "name": "Curated Knowledge Domains",
            "description": (
                "Milvus-backed curated corpora for established reference questions."
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
                "Authenticated user's uploaded documents and shared upload collections."
            ),
            "tools": ["user_document_tool"],
            "default_enabled": False,
            "requires_auth": True,
        },
        {
            "id": "workspace_data",
            "name": "Workspace Data",
            "description": "Authenticated user's Gmail, Calendar, and Docs data.",
            "tools": [
                "gmail_mcp_server",
                "calendar_mcp_server",
                "docs_mcp_server",
            ],
            "default_enabled": False,
            "requires_auth": True,
        },
        {
            "id": "nvidia_docs",
            "name": "Official NVIDIA Docs",
            "description": (
                "Official NVIDIA product documentation via one routed docs search."
            ),
            "tools": ["nvidia_docs_tool"],
            "default_enabled": True,
            "requires_auth": False,
        },
        {
            "id": "x_mcp",
            "name": "X AI MCP",
            "description": "Read-only social signals and updates.",
            "tools": ["x_mcp_server"],
            "default_enabled": True,
            "requires_auth": False,
        },
        *[
            {
                "id": source_id,
                "name": name,
                "description": description,
                "tools": [tool],
                "default_enabled": False,
                "requires_auth": True,
            }
            for source_id, name, description, tool in (
                (
                    "cluster_state",
                    "Live Kubernetes State",
                    "Current cluster resources and workload evidence.",
                    "k8s_mcp_server",
                ),
                (
                    "network_state",
                    "Live UniFi State",
                    "Current network inventory, device state, and statistics.",
                    "unifi_mcp_server",
                ),
                (
                    "repository_data",
                    "GitHub Repository Evidence",
                    "Read-only source, commits, releases, issues, and pull requests.",
                    "github_mcp_server",
                ),
                (
                    "fantasy_data",
                    "ESPN Fantasy Evidence",
                    "Read-only league, roster, draft, and player data.",
                    "espn_mcp_server",
                ),
            )
        ],
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


class VerificationLLMError(RuntimeError):
    """The configured verification LLM could not be invoked."""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class SourceVerifierConfig(FunctionBaseConfig, name="source_verifier"):
    """Configuration for the source_verifier function."""

    llm_name: LLMRef = Field(
        default="verifier_llm",
        description=(
            "Provider-neutral reference to the LLM used as the claim critic. "
            "The name must identify an entry in the workflow's llms section."
        ),
    )
    max_source_chars: int = Field(
        default=80000,
        ge=1000,
        le=500000,
        description="Maximum source content length in characters before truncation.",
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
    description: str = Field(default=_DISPATCH_DESCRIPTION)
    enabled_operations: list[SourceVerifierOperation] | None = Field(
        default=None,
        description=(
            "Optional allow-list of operations to register. Supported values: "
            "verify_claim, audit_citations, plan_sources. When omitted, all "
            "operations are enabled. An empty list disables every operation."
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
# Provider-neutral NeMo Agent Toolkit LLM adapter
# ---------------------------------------------------------------------------
async def _call_llm(
    builder: Builder,
    config: SourceVerifierConfig,
    system_prompt: str,
    user_prompt: str,
) -> str:
    """Invoke the configured critic through the toolkit's LangChain wrapper."""
    try:
        llm = await builder.get_llm(
            config.llm_name,
            wrapper_type=LLMFrameworkEnum.LANGCHAIN,
        )
        from langchain_core.messages import HumanMessage, SystemMessage

        result = await llm.ainvoke(
            [
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt),
            ]
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

        text = str(result).strip()
        if text:
            return text
        raise VerificationLLMError("verification LLM returned an empty response")

    except Exception as exc:
        logger.error("Verification LLM call failed: %s", exc)
        if isinstance(exc, VerificationLLMError):
            raise
        raise VerificationLLMError(str(exc)) from exc


async def _fetch_source(url: str, config: SourceVerifierConfig) -> FetchResult:
    """Fetch through pinned public transports and convert only local files."""
    # Validate URL
    try:
        normalized_url, _ = _validate_url(url, ["http", "https"])
    except ValueError as exc:
        return FetchResult(status="invalid_url", error=str(exc))

    # F-001: source URLs come from LLM output / stored memories. Reject
    # non-http(s) schemes and hosts resolving to non-public addresses.
    try:
        validate_public_url(normalized_url, check_dns=True)
    except UnsafeURLError as exc:
        return FetchResult(status="invalid_url", error=str(exc))

    truncation_msg = "\n\n[Source content truncated for verification]"

    try:
        content, outcome = await asyncio.wait_for(
            _scrape_with_httpx_result(
                normalized_url,
                token_limit=config.max_fetch_tokens,
                truncation_msg=truncation_msg,
                allowed_schemes=["http", "https"],
                timeout=_httpx_timeout_from_seconds(config.fetch_timeout),
            ),
            timeout=config.fetch_timeout,
        )
        if content and _is_valid_content(content):
            return FetchResult(status="ok", content=content)
        if outcome == "blocked" or (content and _is_challenge_page(content)):
            return FetchResult(
                status="challenge_page",
                error="Content appears to be a challenge page",
            )
        return FetchResult(
            status="unreachable",
            error=f"Controlled fetch returned {outcome}",
        )
    except UnsafeURLError as exc:
        return FetchResult(status="invalid_url", error=str(exc))
    except TimeoutError:
        return FetchResult(
            status="unreachable", error=f"Fetch timed out after {config.fetch_timeout}s"
        )
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
    except Exception as exc:
        return FetchResult(status="unreachable", error=str(exc))


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
                "google doc",
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
    q = question.lower()
    for source_id, aliases in (
        ("cluster_state", ("cluster", "kubernetes", "k8s", "pods")),
        ("network_state", ("unifi", "home network")),
        ("repository_data", ("github", "repository", "gitops")),
        ("fantasy_data", ("fantasy", "roster", "waivers")),
    ):
        if any(alias in q for alias in aliases):
            preferred.append(source_id)
    if flags["docs"]:
        preferred.append("nvidia_docs")
    if flags["has_url"]:
        preferred.append("known_url_scrape")
    if flags["current"]:
        preferred.extend(["curated_feeds", "perplexity_search"])
    if flags["broad"] or depth == "deep":
        preferred.extend(["curated_domains", "perplexity_search"])
    if flags["news_or_cards"]:
        preferred.append("perplexity_search")

    preferred.append("curated_domains")
    preferred.append("perplexity_search")

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
        "perplexity_search": "Use Perplexity internet search for ranked web sources, snippets, publication dates, and freshness metadata.",
        "known_url_scrape": "Use only after a specific URL is already known.",
        "uploaded_documents": "Use when the question is about authenticated uploaded documents.",
        "workspace_data": "Use when the question is about authenticated Google Workspace data.",
        "nvidia_docs": "Route official NVIDIA product documentation questions to the docs specialist.",
    }
    reason = reasons.get(
        source_id, "Use this selected source when it matches the user's constraints."
    )
    if depth == "deep" and source_id == "perplexity_search":
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
        workspace_tools: list[dict[str, str]] = []
        matches = (
            ("gmail_mcp_server", ("email", "gmail", "inbox", "draft")),
            ("calendar_mcp_server", ("calendar", "schedule", "free time")),
            ("docs_mcp_server", ("google doc", "document")),
        )
        for tool, aliases in matches:
            if any(alias in q for alias in aliases):
                workspace_tools.append({"tool": tool})
        if workspace_tools:
            return workspace_tools
        return [{"tool": tool} for tool, _aliases in matches]
    if source_id == "nvidia_docs":
        product_aliases = (
            ("openshell", ("openshell", "open shell")),
            ("aistore", ("aistore", "ai store")),
            ("aiperf", ("aiperf", "ai perf")),
            ("nvcf", ("nvcf", "cloud function")),
            ("dsx", ("dsx",)),
            ("dynamo", ("dynamo",)),
        )
        for product, aliases in product_aliases:
            if any(alias in q for alias in aliases):
                return [{"tool": "nvidia_docs_tool", "product": product}]
        return [{"tool": "nvidia_docs_tool"}]
    return []


def _safe_audit_url(url: str) -> tuple[bool, str | None]:
    parsed = urlparse(url.strip())
    hostname = (parsed.hostname or "").lower()
    if hostname in _PLACEHOLDER_HOSTS:
        return False, "placeholder_url"
    try:
        validate_public_url(url, check_dns=True)
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
# Registered function
# ---------------------------------------------------------------------------
@register_function(
    config_type=SourceVerifierConfig,
    framework_wrappers=[LLMFrameworkEnum.LANGCHAIN],
)
async def source_verifier_function(config: SourceVerifierConfig, builder: Builder):
    enabled = set(
        _ALL_OPERATIONS
        if config.enabled_operations is None
        else config.enabled_operations
    )

    async def _invoke_critic(system_prompt: str, user_prompt: str) -> str:
        return await _call_llm(builder, config, system_prompt, user_prompt)

    critic = LLMClaimCritic(
        llm_name=str(config.llm_name),
        invoke=_invoke_critic,
    )

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
            unsupported/source_unreachable), uncalibrated confidence, evidence
            excerpt, reasoning, critic metadata, and any claim issues found.
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

        content = fetch.content or ""
        content, source_truncated = _claim_focused_excerpt(
            content,
            claim,
            config.max_source_chars,
        )

        try:
            parsed = await critic.verify(
                claim=claim.strip(),
                source_url=source_url.strip(),
                source_content=content,
                context=context.strip(),
            )
        except (VerificationLLMError, CriticResponseError) as exc:
            issue = (
                "verification_llm_error"
                if isinstance(exc, VerificationLLMError)
                else "verification_response_error"
            )
            return json.dumps(
                {
                    "verdict": "error",
                    "confidence": 0.0,
                    "source_url": source_url,
                    "source_reachable": True,
                    "evidence": None,
                    "reasoning": str(exc),
                    "claim_issues": [issue],
                    "critic": {
                        "type": "llm",
                        "llm_name": str(config.llm_name),
                        "confidence_calibrated": False,
                        "status": "error",
                    },
                }
            )

        # Enrich with source metadata
        parsed["source_url"] = source_url
        parsed["source_reachable"] = True
        parsed["source_truncated"] = source_truncated
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
        approval_recommended = (
            preferred_depth != "quick" and broad and len(recommended) >= 3
        )

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
                "approval_hint": (
                    "Advisory cost hint only. Honor the request's approval policy and "
                    "existing authorization; do not reconfirm an authorized workflow."
                ),
                "execution_contract": (
                    "Use only relevant selected sources; reuse completed reads and "
                    "parallelize independent calls. Tool names identify capabilities, "
                    "not proof of connectivity. For MCP groups select an exposed leaf."
                ),
                "source_ledger_contract": {
                    "capture_fields": ["url", "title", "tool", "source_id"],
                    "audit_tool": "source_verifier_tool",
                    "audit_operation": "audit_citations",
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
        if source_urls_json.lstrip().startswith(("[", "{")):
            try:
                json.loads(source_urls_json)
            except json.JSONDecodeError:
                allowed_norms = {}
                invalid.append(
                    {
                        "reason": "invalid_source_ledger",
                        "detail": "Source ledger JSON is malformed.",
                    }
                )

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
            if source_urls_json.strip() and normalized not in allowed_norms:
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
    # NAT consumes this factory as an async context manager: exactly one yield.
    # Multiple yields expose only the first operation and break cleanup.
    # ------------------------------------------------------------------
    async def source_verifier(
        operation: SourceVerifierOperation,
        claim: str = "",
        source_url: str = "",
        context: str = "",
        research_question: str = "",
        selected_sources_json: str = "",
        disabled_sources_json: str = "",
        depth: str = "auto",
        answer_markdown: str = "",
        source_urls_json: str = "",
        require_references: bool = True,
    ) -> str:
        if operation not in enabled:
            return json.dumps(
                {
                    "passed": False,
                    "error": "operation_disabled",
                    "operation": operation,
                    "enabled_operations": sorted(enabled),
                }
            )
        required = {
            "verify_claim": {"claim": claim, "source_url": source_url},
            "plan_sources": {"research_question": research_question},
            "audit_citations": {"answer_markdown": answer_markdown},
        }[operation]
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            return json.dumps(
                {
                    "passed": False,
                    "error": "missing_arguments",
                    "operation": operation,
                    "required_fields": missing,
                }
            )
        if operation == "verify_claim":
            return await verify_claim(claim, source_url, context)
        if operation == "plan_sources":
            return await plan_sources(
                research_question, selected_sources_json, disabled_sources_json, depth
            )
        return await audit_citations(
            answer_markdown, source_urls_json, require_references
        )

    try:
        yield FunctionInfo.from_fn(
            source_verifier,
            input_schema=SourceVerifierInput,
            description=config.description,
        )

    except GeneratorExit:
        logger.warning("source_verifier function exited early!")
    finally:
        logger.info("Cleaning up source_verifier function.")
