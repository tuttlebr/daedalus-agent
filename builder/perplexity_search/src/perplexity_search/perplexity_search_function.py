"""Perplexity Search API web search with compact result rendering."""

import json
import logging
import os
from typing import Literal
from urllib.parse import urlparse

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

MAX_RESULTS = 20
MAX_FILTER_VALUES = 20
_CONTEXT_SIZES = {"low", "medium", "high"}
_RECENCY_FILTERS = {"hour", "day", "week", "month", "year"}


class PerplexitySearchConfig(FunctionBaseConfig, name="perplexity_search"):
    """Configuration for the Perplexity Search API function."""

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
        default=10,
        ge=1,
        le=MAX_RESULTS,
        description="Default number of results to request.",
    )
    default_search_context_size: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="Default amount of extracted content per result page.",
    )


def _clamp_max_results(value: int | None, default: int) -> int:
    """Clamp max_results to the Perplexity API's supported 1..20 range."""
    try:
        parsed = int(value if value else default)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, MAX_RESULTS))


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


def _build_request_payload(
    *,
    query: str,
    country: str = "",
    max_results: int | None = None,
    default_max_results: int = 10,
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

    normalized_recency = search_recency_filter.strip().lower()
    if normalized_recency in _RECENCY_FILTERS:
        payload["search_recency_filter"] = normalized_recency

    domains = _split_filter_values(search_domain_filter)
    if domains:
        payload["search_domain_filter"] = domains

    languages = _split_filter_values(search_language_filter, lowercase=True)
    if languages:
        payload["search_language_filter"] = languages

    for key, value in (
        ("search_after_date_filter", search_after_date_filter),
        ("search_before_date_filter", search_before_date_filter),
        ("last_updated_after_filter", last_updated_after_filter),
        ("last_updated_before_filter", last_updated_before_filter),
    ):
        normalized = value.strip()
        if normalized:
            payload[key] = normalized

    return payload


def _extract_results(raw_results: list[dict]) -> list[dict]:
    """Map Perplexity result objects to the shared SearchResults UI schema."""
    results: list[dict] = []
    for item in raw_results[:MAX_RESULTS]:
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


def _build_payload(data: dict, query: str) -> dict:
    """Build compact structured payload for the frontend <searchresults> tag."""
    organic_results = _extract_results(data.get("results", []))
    payload: dict = {
        "query": query,
        "search_info": {
            "total_results": len(organic_results),
            "query_displayed": query,
        },
    }
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


@register_function(config_type=PerplexitySearchConfig)
async def perplexity_search_function(config: PerplexitySearchConfig, builder: Builder):
    api_key = config.api_key or os.environ.get("PERPLEXITY_SEARCH_API_KEY", "")

    async def _search(
        query: str,
        country: str = "",
        max_results: int = 0,
        search_context_size: Literal["", "low", "medium", "high"] = "",
        search_recency_filter: Literal["", "hour", "day", "week", "month", "year"] = "",
        search_domain_filter: str = "",
        search_language_filter: str = "",
        search_after_date_filter: str = "",
        search_before_date_filter: str = "",
        last_updated_after_filter: str = "",
        last_updated_before_filter: str = "",
    ) -> str:
        """Search the web with the Perplexity Search API.

        Args:
            query: Search query string.
            country: Optional ISO 3166-1 alpha-2 country code, such as "US".
            max_results: Number of results to request. Values are clamped to 1..20.
                Use 0 to use the configured default.
            search_context_size: Extracted page context size: low, medium, or high.
                Leave blank to use the configured default.
            search_recency_filter: Publication recency filter: hour, day, week,
                month, or year.
            search_domain_filter: Optional comma-separated domains to include.
            search_language_filter: Optional comma-separated ISO 639-1 language codes.
            search_after_date_filter: Return results published after MM/DD/YYYY.
            search_before_date_filter: Return results published before MM/DD/YYYY.
            last_updated_after_filter: Return results updated after MM/DD/YYYY.
            last_updated_before_filter: Return results updated before MM/DD/YYYY.
        """
        if not api_key:
            return (
                "Error: No Perplexity Search API key configured. Set the "
                "PERPLEXITY_SEARCH_API_KEY environment variable."
            )

        normalized_query = (query or "").strip()
        if not normalized_query:
            return "Error: query is required."

        normalized_country = country.strip()
        if normalized_country and len(normalized_country) != 2:
            return "Error: country must be a two-letter ISO 3166-1 alpha-2 code."

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
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                response = await client.post(
                    config.base_url,
                    headers=headers,
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Perplexity Search returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return (
                f"Error: Perplexity Search returned status {exc.response.status_code}."
            )
        except httpx.RequestError as exc:
            logger.error("Perplexity Search request failed: %s", exc)
            return f"Error: Could not reach Perplexity Search: {exc}"
        except ValueError as exc:
            logger.error("Perplexity Search returned invalid JSON: %s", exc)
            return "Error: Perplexity Search returned invalid JSON."

        result_payload = _build_payload(data, normalized_query)
        summary = _build_markdown_summary(result_payload)
        search_tag = f"<searchresults>{json.dumps(result_payload)}</searchresults>"
        return f"{summary}\n\n{search_tag}"

    try:
        yield FunctionInfo.from_fn(
            _search,
            description=(
                "Search the web using Perplexity's first-party Search API and "
                "return ranked URLs with snippets, publication dates, and "
                "last-updated metadata. Use for broad web discovery, current "
                "information, source lookup, and citation candidate gathering. "
                "Supports optional country, domain, language, recency, and date "
                "filters. Returns compact markdown plus structured searchresults "
                "data for rich UI rendering."
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up perplexity_search function.")
