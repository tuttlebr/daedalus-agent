"""Perplexity Search API web search with compact result rendering."""

import asyncio
import json
import logging
import os
import secrets
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlparse

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

MAX_RESULTS = 20
DEFAULT_MAX_RESULTS = 5
MAX_QUERIES = 5
MAX_FILTER_VALUES = 20
_CONTEXT_SIZES = {"low", "medium", "high"}
_RECENCY_FILTERS = {"hour", "day", "week", "month", "year"}
_PROVIDER_DATE_FORMAT = "%m/%d/%Y"
_ISO_DATE_FORMAT = "%Y-%m-%d"

SearchRecencyFilter = Annotated[
    Literal["", "hour", "day", "week", "month", "year"],
    Field(
        description=(
            "Optional publication recency: hour, day, week, month, or year. "
            "Do not combine it with exact publication or last-updated dates; "
            "exact dates take precedence."
        ),
    ),
]
DateFilter = Annotated[
    str,
    Field(
        description=(
            "Optional exact date in MM/DD/YYYY or YYYY-MM-DD format. "
            "ISO dates are normalized before calling Perplexity."
        ),
    ),
]
QueryText = Annotated[str, Field(min_length=1)]
MultiQuery = Annotated[
    list[QueryText],
    Field(min_length=2, max_length=MAX_QUERIES),
]
SearchQuery = Annotated[
    QueryText | MultiQuery,
    Field(
        description=(
            "One specific, standalone search query, or 2-5 distinct related "
            "subqueries for a multifaceted research task. Rewrite vague or "
            "conversational wording before calling: preserve the user's intent "
            "and named entities, add relevant context and time frames, and use "
            "precise terminology without inventing constraints."
        ),
    ),
]


class PerplexitySearchConfig(FunctionBaseConfig, name="perplexity_search"):
    """Configuration for the Perplexity Search API function."""

    description: str | None = None

    api_key: str = Field(
        default_factory=lambda: os.environ.get("PERPLEXITY_SEARCH_API_KEY", ""),
        description=(
            "Perplexity Search API key. Falls back to the "
            "PERPLEXITY_SEARCH_API_KEY environment variable."
        ),
    )
    base_url: str = Field(
        default="https://api.perplexity.ai/search",
        description="Perplexity Search API endpoint.",
    )
    timeout: float = Field(
        default=30.0,
        description="HTTP timeout in seconds for the Perplexity Search request.",
    )
    default_max_results: int = Field(
        default=DEFAULT_MAX_RESULTS,
        ge=1,
        le=MAX_RESULTS,
        description="Default number of results to request; keep this small.",
    )
    default_search_context_size: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="Default amount of extracted content per result page.",
    )
    rate_limit_max_retries: int = Field(
        default=2,
        ge=0,
        le=5,
        description="Bounded retries after Perplexity returns HTTP 429.",
    )
    rate_limit_backoff_seconds: float = Field(
        default=1.0,
        ge=0.0,
        le=30.0,
        description="Base delay for exponential HTTP 429 backoff with jitter.",
    )


def _clamp_max_results(value: int | None, default: int) -> int:
    """Clamp max_results to the Perplexity API's supported 1..20 range."""
    try:
        parsed = int(value if value else default)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, MAX_RESULTS))


def _normalize_query(query: str | list[str]) -> str | list[str]:
    """Validate and normalize one query or a compact multi-query request."""
    if isinstance(query, str):
        normalized = query.strip()
        if not normalized:
            raise ValueError("query is required.")
        return normalized

    if not isinstance(query, list):
        raise TypeError("query must be a string or a list of query strings.")
    if not 2 <= len(query) <= MAX_QUERIES:
        raise ValueError(
            "query lists must contain 2 to 5 distinct subqueries; use a string "
            "for a single search."
        )

    normalized_queries: list[str] = []
    seen: set[str] = set()
    for item in query:
        if not isinstance(item, str) or not item.strip():
            raise ValueError("each query list item must be a non-empty string.")
        normalized = item.strip()
        dedupe_key = normalized.casefold()
        if dedupe_key in seen:
            raise ValueError("query list items must be distinct subqueries.")
        seen.add(dedupe_key)
        normalized_queries.append(normalized)
    return normalized_queries


def _split_filter_values(value: str, *, lowercase: bool = False) -> list[str]:
    """Parse comma-separated filter values into the API's string-array shape."""
    if not value:
        return []

    values = []
    for item in value.split(","):
        normalized = item.strip()
        if not normalized:
            continue
        values.append(normalized.lower() if lowercase else normalized)
        if len(values) >= MAX_FILTER_VALUES:
            break
    return values


def _display_link(url: str) -> str:
    host = urlparse(url).netloc
    return host.removeprefix("www.") if host else url


def _normalize_date_filter(value: str, field_name: str) -> str:
    """Validate an exact date and normalize ISO input for Perplexity."""
    normalized = value.strip()
    if not normalized:
        return ""

    try:
        datetime.strptime(normalized, _PROVIDER_DATE_FORMAT)
        return normalized
    except ValueError:
        pass

    try:
        parsed = datetime.strptime(normalized, _ISO_DATE_FORMAT)
    except ValueError as exc:
        message = (
            f"{field_name} must be a valid date in MM/DD/YYYY or YYYY-MM-DD format."
        )
        raise ValueError(message) from exc
    return parsed.strftime(_PROVIDER_DATE_FORMAT)


def _build_request_payload(
    *,
    query: str | list[str],
    country: str = "",
    max_results: int | None = None,
    default_max_results: int = DEFAULT_MAX_RESULTS,
    search_context_size: str = "medium",
    search_recency_filter: str = "",
    search_domain_filter: str = "",
    search_language_filter: str = "",
    search_after_date_filter: str = "",
    search_before_date_filter: str = "",
    last_updated_after_filter: str = "",
    last_updated_before_filter: str = "",
) -> dict:
    """Build the JSON request body expected by the Perplexity Search API."""
    payload: dict[str, object] = {
        "query": query,
        "max_results": _clamp_max_results(max_results, default_max_results),
    }

    normalized_country = country.strip().upper()
    if normalized_country:
        payload["country"] = normalized_country

    normalized_context_size = search_context_size.strip().lower()
    if normalized_context_size in _CONTEXT_SIZES:
        payload["search_context_size"] = normalized_context_size

    domains = _split_filter_values(search_domain_filter)
    if domains:
        payload["search_domain_filter"] = domains

    languages = _split_filter_values(search_language_filter, lowercase=True)
    if languages:
        payload["search_language_filter"] = languages

    exact_date_filters = {}
    for key, value in (
        ("search_after_date_filter", search_after_date_filter),
        ("search_before_date_filter", search_before_date_filter),
        ("last_updated_after_filter", last_updated_after_filter),
        ("last_updated_before_filter", last_updated_before_filter),
    ):
        normalized = _normalize_date_filter(value, key)
        if normalized:
            exact_date_filters[key] = normalized
    payload.update(exact_date_filters)

    normalized_recency = search_recency_filter.strip().lower()
    if normalized_recency in _RECENCY_FILTERS and not exact_date_filters:
        payload["search_recency_filter"] = normalized_recency

    return payload


def _extract_results(
    raw_results: list[dict], max_results: int = MAX_RESULTS
) -> list[dict]:
    """Map Perplexity result objects to the shared SearchResults UI schema."""
    results: list[dict] = []
    for item in raw_results[:max_results]:
        if not isinstance(item, dict):
            continue

        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or item.get("link") or "").strip()
        if not title or not url:
            continue

        entry = {
            "position": len(results) + 1,
            "title": title,
            "link": url,
            "displayed_link": _display_link(url),
        }
        for key in ("snippet", "date", "last_updated"):
            value = item.get(key)
            if value:
                entry[key] = str(value)
        results.append(entry)
    return results


def _query_display(query: str | list[str]) -> str:
    if isinstance(query, str):
        return query
    return "; ".join(query)


def _build_payload(
    data: dict,
    query: str | list[str],
    max_results: int = MAX_RESULTS,
) -> dict:
    """Build compact structured payload for the frontend <searchresults> tag."""
    query_display = _query_display(query)
    organic_results = _extract_results(data.get("results", []), max_results)
    payload: dict = {
        "query": query_display,
        "search_info": {
            "total_results": len(organic_results),
            "query_displayed": query_display,
        },
    }
    if isinstance(query, list):
        payload["queries"] = query
    if data.get("id"):
        payload["search_id"] = data["id"]
    if data.get("server_time"):
        payload["server_time"] = data["server_time"]
    if organic_results:
        payload["organic_results"] = organic_results
    return payload


def _build_markdown_summary(payload: dict) -> str:
    """Create compact markdown for LLM reasoning and source citation."""
    query = payload.get("query", "")
    queries = payload.get("queries", [])
    if queries:
        lines = [f"## Perplexity Search Results for {len(queries)} related queries"]
        lines.extend(f"- {item}" for item in queries)
    else:
        lines = [f'## Perplexity Search Results for "{query}"']

    results = payload.get("organic_results", [])
    if not results:
        lines.append("No results returned.")
        return "\n".join(lines)

    lines.append("")
    for result in results:
        title = result.get("title", "")
        link = result.get("link", "")
        date = f" ({result['date']})" if result.get("date") else ""
        lines.append(f"{result.get('position', '')}. [{title}]({link}){date}")

        snippet = result.get("snippet")
        if snippet:
            lines.append(f"   {snippet}")

        last_updated = result.get("last_updated")
        if last_updated:
            lines.append(f"   Last updated: {last_updated}")

    return "\n".join(lines)


async def _post_with_rate_limit_backoff(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    headers: dict[str, str],
    payload: dict,
    max_retries: int,
    base_delay: float,
):
    """POST once plus bounded exponential retries for provider rate limits."""
    for attempt in range(max_retries + 1):
        response = await client.post(base_url, headers=headers, json=payload)
        if response.status_code != 429 or attempt >= max_retries:
            return response

        jitter = base_delay * secrets.randbelow(1_001) / 1_000 if base_delay else 0.0
        delay = base_delay * (2**attempt) + jitter
        logger.warning(
            "Perplexity Search rate limited attempt %d/%d; retrying in %.2fs",
            attempt + 1,
            max_retries + 1,
            delay,
        )
        await asyncio.sleep(delay)

    raise RuntimeError("unreachable")


def _http_error_for_user(response) -> str:
    """Translate provider failures into safe, user-actionable tool output."""

    status_code = int(getattr(response, "status_code", 0) or 0)
    error_code = ""
    error_type = ""
    error_message = ""
    try:
        body = response.json()
    except (TypeError, ValueError):
        body = {}
    if isinstance(body, dict):
        error = body.get("error", body)
        if isinstance(error, dict):
            error_code = str(error.get("code") or "").casefold()
            error_type = str(error.get("type") or "").casefold()
            error_message = " ".join(str(error.get("message") or "").split())

    normalized_error_message = error_message.casefold()

    quota_exhausted = (
        "insufficient_quota" in {error_code, error_type}
        or "exceeded your current quota" in normalized_error_message
        or "quota" in normalized_error_message
    )
    if quota_exhausted:
        return (
            "Error: Perplexity Search is unavailable because the server-side "
            "API quota is exhausted. Report this limitation to the user. It "
            "requires an operator billing or quota change; do not retry this "
            "tool in the same turn."
        )
    if status_code == 429:
        return (
            "Error: Perplexity Search is temporarily unavailable because the "
            "server-side rate limit was reached. Report this limitation to the "
            "user and do not retry this tool in the same turn."
        )
    if status_code in {401, 403}:
        return (
            "Error: Perplexity Search is unavailable because its operator-managed "
            "server credential was rejected. Report this limitation to the user; "
            "user authorization cannot fix it, and this tool must not be retried "
            "in the same turn."
        )
    if status_code == 400:
        detail = error_message[:400]
        if detail:
            return (
                "Error: Perplexity Search rejected the request arguments: "
                f"{detail} Correct the arguments before retrying."
            )
        return (
            "Error: Perplexity Search rejected the request arguments. Correct "
            "the arguments before retrying."
        )
    return (
        f"Error: Perplexity Search failed with provider status {status_code}. "
        "Report the provider failure to the user and do not retry this tool "
        "unchanged in the same turn."
    )


@register_function(config_type=PerplexitySearchConfig)
async def perplexity_search_function(config: PerplexitySearchConfig, builder: Builder):
    api_key = config.api_key or os.environ.get("PERPLEXITY_SEARCH_API_KEY", "")

    async def _search(
        query: SearchQuery,
        country: str = "",
        max_results: int = 0,
        search_context_size: Literal["", "low", "medium", "high"] = "",
        search_recency_filter: SearchRecencyFilter = "",
        search_domain_filter: str = "",
        search_language_filter: str = "",
        search_after_date_filter: DateFilter = "",
        search_before_date_filter: DateFilter = "",
        last_updated_after_filter: DateFilter = "",
        last_updated_before_filter: DateFilter = "",
    ) -> str:
        """Search the web with the Perplexity Search API.

        Args:
            query: One specific, standalone search query, or 2-5 distinct
                related subqueries for a multifaceted research task. Rewrite
                vague or conversational wording into precise search terms,
                preserving intent while adding relevant context and time frames.
            country: Optional ISO 3166-1 alpha-2 country code, such as "US".
            max_results: Number of results to request. Values are clamped to 1..20.
                Use 0 for the configured default of 5. Prefer 3 for a focused
                lookup and 5 for broader discovery; request more only when the
                task genuinely needs wider coverage.
            search_context_size: Extracted page context size: low, medium, or high.
                Leave blank to use the configured default.
            search_recency_filter: Publication recency filter: hour, day, week,
                month, or year. Do not combine with exact date filters; exact
                dates take precedence.
            search_domain_filter: Optional comma-separated domains to include.
            search_language_filter: Optional comma-separated ISO 639-1 language codes.
            search_after_date_filter: Return results published after an
                MM/DD/YYYY or YYYY-MM-DD date.
            search_before_date_filter: Return results published before an
                MM/DD/YYYY or YYYY-MM-DD date.
            last_updated_after_filter: Return results updated after an
                MM/DD/YYYY or YYYY-MM-DD date.
            last_updated_before_filter: Return results updated before an
                MM/DD/YYYY or YYYY-MM-DD date.
        """
        if not api_key:
            return (
                "Error: No Perplexity Search API key configured. Set the "
                "PERPLEXITY_SEARCH_API_KEY environment variable."
            )

        try:
            normalized_query = _normalize_query(query)
        except (TypeError, ValueError) as exc:
            return f"Error: {exc}"

        normalized_country = country.strip()
        if normalized_country and len(normalized_country) != 2:
            return "Error: country must be a two-letter ISO 3166-1 alpha-2 code."

        try:
            payload = _build_request_payload(
                query=normalized_query,
                country=normalized_country,
                max_results=max_results,
                default_max_results=config.default_max_results,
                search_context_size=(
                    search_context_size or config.default_search_context_size
                ),
                search_recency_filter=search_recency_filter,
                search_domain_filter=search_domain_filter,
                search_language_filter=search_language_filter,
                search_after_date_filter=search_after_date_filter,
                search_before_date_filter=search_before_date_filter,
                last_updated_after_filter=last_updated_after_filter,
                last_updated_before_filter=last_updated_before_filter,
            )
        except ValueError as exc:
            return f"Error: {exc}"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                response = await _post_with_rate_limit_backoff(
                    client,
                    base_url=config.base_url,
                    headers=headers,
                    payload=payload,
                    max_retries=config.rate_limit_max_retries,
                    base_delay=config.rate_limit_backoff_seconds,
                )
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Perplexity Search returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return _http_error_for_user(exc.response)
        except httpx.RequestError as exc:
            logger.error("Perplexity Search request failed: %s", exc)
            return "Error: Could not reach Perplexity Search."
        except ValueError as exc:
            logger.error("Perplexity Search returned invalid JSON: %s", exc)
            return "Error: Perplexity Search returned invalid JSON."

        result_payload = _build_payload(
            data,
            normalized_query,
            int(payload["max_results"]),
        )
        summary = _build_markdown_summary(result_payload)
        search_tag = f"<searchresults>{json.dumps(result_payload)}</searchresults>"
        return f"{summary}\n\n{search_tag}"

    try:
        yield FunctionInfo.from_fn(
            _search,
            description=config.description
            or (
                "Search the web using Perplexity's first-party Search API and "
                "return ranked URLs with snippets, publication dates, and "
                "last-updated metadata. Use for broad web discovery, current "
                "information, source lookup, and citation candidate gathering. "
                "Before calling, rewrite vague or conversational wording as a "
                "specific standalone query with relevant context, time frames, "
                "and precise terminology while preserving user intent. Use one "
                "query for a focused lookup; use 2-5 distinct related subqueries "
                "in one call only when a multifaceted research task needs broader "
                "coverage. Prefer 3 results for focused lookup and 5 for broader "
                "discovery; request more only when genuinely necessary. "
                "Provider rate limits receive bounded exponential retries with "
                "jitter before an explicit failure is returned. "
                "Supports optional country, domain, language, recency, and date "
                "filters. Exact dates accept MM/DD/YYYY or YYYY-MM-DD and take "
                "precedence over recency. Returns compact markdown plus structured "
                "searchresults data for rich UI rendering. Provider quota, "
                "rate-limit, and credential failures are explicit and must be "
                "reported to the user."
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up perplexity_search function.")
