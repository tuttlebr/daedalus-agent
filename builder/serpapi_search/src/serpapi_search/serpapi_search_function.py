"""Structured SerpAPI search with data extraction and rich UI rendering."""

from __future__ import annotations

import json
import logging
import os

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Limits for extraction (keeps LLM context compact)
# ---------------------------------------------------------------------------
MAX_ORGANIC = 8
MAX_TOP_STORIES = 5
MAX_NEWS = 5
MAX_IMAGES = 8
MAX_SHOPPING = 6
MAX_VIDEOS = 4
MAX_RELATED_QUESTIONS = 4
MAX_RELATED_SEARCHES = 6


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class SerpApiSearchConfig(FunctionBaseConfig, name="serpapi_search"):
    """Configuration for the SerpAPI structured search function."""

    api_key: str = Field(
        default_factory=lambda: os.environ.get("SERPAPI_KEY", ""),
        description="SerpAPI key. Falls back to the SERPAPI_KEY environment variable.",
    )
    base_url: str = Field(
        default="https://serpapi.com/search.json",
        description="SerpAPI search endpoint.",
    )
    timeout: float = Field(
        default=30.0,
        description="HTTP timeout in seconds for the SerpAPI request.",
    )


# ---------------------------------------------------------------------------
# Extractors: pull only the fields the UI needs from each section
# ---------------------------------------------------------------------------


def _extract_organic(raw: list[dict]) -> list[dict]:
    results = []
    for item in raw[:MAX_ORGANIC]:
        entry: dict = {}
        for key in (
            "position",
            "title",
            "link",
            "displayed_link",
            "snippet",
            "date",
            "favicon",
        ):
            if key in item:
                entry[key] = item[key]
        # thumbnail is useful if present
        if "thumbnail" in item:
            entry["thumbnail"] = item["thumbnail"]
        if entry.get("title") and entry.get("link"):
            results.append(entry)
    return results


def _extract_knowledge_graph(raw: dict) -> dict | None:
    if not raw or not raw.get("title"):
        return None
    kg: dict = {}
    for key in (
        "title",
        "type",
        "description",
        "image",
        "website",
        "founded",
        "headquarters",
        "stock_price",
    ):
        if key in raw:
            kg[key] = raw[key]
    # Source attribution
    src = raw.get("source")
    if isinstance(src, dict):
        kg["source_name"] = src.get("name")
        kg["source_link"] = src.get("link")
    # Social profiles
    profiles = raw.get("profiles")
    if profiles and isinstance(profiles, list):
        kg["profiles"] = [
            {k: p[k] for k in ("name", "link") if k in p} for p in profiles[:5]
        ]
    # Key facts: gather any extra top-level string/number values
    skip = {
        "title",
        "type",
        "description",
        "image",
        "website",
        "source",
        "profiles",
        "kgmid",
        "entity_type",
        "header_images",
        "people_also_search_for",
        "serpapi_link",
    }
    facts: dict = {}
    for k, v in raw.items():
        if k in skip or k.endswith("_link") or k.startswith("serpapi_"):
            continue
        if isinstance(v, (str, int, float)) and k not in kg:
            facts[k] = v
    if facts:
        kg["facts"] = facts
    return kg


def _extract_answer_box(raw: dict) -> dict | None:
    if not raw:
        return None
    ab: dict = {}
    for key in (
        "type",
        "result",
        "answer",
        "snippet",
        "title",
        "link",
        "displayed_link",
        "temperature",
        "weather",
        "location",
        "stock",
        "price",
        "currency",
        "exchange",
    ):
        if key in raw:
            ab[key] = raw[key]
    # price_movement for finance
    pm = raw.get("price_movement")
    if isinstance(pm, dict):
        ab["price_movement"] = {
            k: pm[k] for k in ("movement", "percentage", "value", "date") if k in pm
        }
    return ab if ab else None


def _extract_top_stories(raw) -> list[dict]:
    items = raw if isinstance(raw, list) else []
    # Handle object-with-sections format
    if isinstance(raw, dict):
        for v in raw.values():
            if isinstance(v, list):
                items = v
                break
    results = []
    for item in items[:MAX_TOP_STORIES]:
        entry: dict = {}
        for key in ("title", "link", "source", "date", "thumbnail"):
            if key in item:
                entry[key] = item[key]
        if entry.get("title") and entry.get("link"):
            results.append(entry)
    return results


def _extract_images(raw: list[dict]) -> list[dict]:
    results = []
    for item in raw[:MAX_IMAGES]:
        entry: dict = {}
        for key in ("title", "thumbnail", "original", "source", "link"):
            if key in item:
                entry[key] = item[key]
        if entry.get("thumbnail"):
            results.append(entry)
    return results


def _extract_shopping(raw: list[dict]) -> list[dict]:
    results = []
    for item in raw[:MAX_SHOPPING]:
        entry: dict = {}
        for key in (
            "title",
            "link",
            "product_link",
            "source",
            "price",
            "extracted_price",
            "old_price",
            "rating",
            "reviews",
            "thumbnail",
            "delivery",
        ):
            if key in item:
                entry[key] = item[key]
        if entry.get("title"):
            results.append(entry)
    return results


def _extract_news(raw: list[dict]) -> list[dict]:
    results = []
    for item in raw[:MAX_NEWS]:
        entry: dict = {}
        for key in (
            "title",
            "link",
            "source",
            "date",
            "snippet",
            "thumbnail",
            "favicon",
        ):
            if key in item:
                entry[key] = item[key]
        if entry.get("title") and entry.get("link"):
            results.append(entry)
    return results


def _extract_videos(raw: list[dict]) -> list[dict]:
    results = []
    for item in raw[:MAX_VIDEOS]:
        entry: dict = {}
        for key in (
            "title",
            "link",
            "thumbnail",
            "duration",
            "date",
            "snippet",
            "displayed_link",
        ):
            if key in item:
                entry[key] = item[key]
        if entry.get("title") and entry.get("link"):
            results.append(entry)
    return results


def _extract_related_questions(raw: list[dict]) -> list[dict]:
    results = []
    for item in raw[:MAX_RELATED_QUESTIONS]:
        entry: dict = {}
        for key in ("question", "snippet", "title", "link"):
            if key in item:
                entry[key] = item[key]
        if entry.get("question"):
            results.append(entry)
    return results


def _extract_related_searches(raw: list[dict]) -> list[dict]:
    results = []
    for item in raw[:MAX_RELATED_SEARCHES]:
        q = item.get("query")
        if q:
            results.append({"query": q})
    return results


# ---------------------------------------------------------------------------
# Build the structured payload for the frontend <searchresults> tag
# ---------------------------------------------------------------------------


def _build_payload(data: dict, query: str) -> dict:
    """Extract relevant sections from raw SerpAPI JSON into a compact payload."""
    payload: dict = {"query": query}

    # Search info
    si = data.get("search_information", {})
    if si:
        info: dict = {}
        for k in ("total_results", "time_taken_displayed", "query_displayed"):
            if k in si:
                info[k] = si[k]
        if info:
            payload["search_info"] = info

    # Knowledge graph
    kg = _extract_knowledge_graph(data.get("knowledge_graph", {}))
    if kg:
        payload["knowledge_graph"] = kg

    # Answer box
    ab = _extract_answer_box(data.get("answer_box") or data.get("answer_box_list"))
    if ab:
        payload["answer_box"] = ab

    # Organic results
    organic = _extract_organic(data.get("organic_results", []))
    if organic:
        payload["organic_results"] = organic

    # Top stories
    ts = _extract_top_stories(data.get("top_stories", []))
    if ts:
        payload["top_stories"] = ts

    # Images
    imgs = _extract_images(data.get("images_results", []))
    if imgs:
        payload["images"] = imgs

    # Shopping
    shopping = _extract_shopping(data.get("shopping_results", []))
    if shopping:
        payload["shopping_results"] = shopping

    # News
    news = _extract_news(data.get("news_results", []))
    if news:
        payload["news_results"] = news

    # Videos
    videos = _extract_videos(data.get("video_results", []))
    if videos:
        payload["video_results"] = videos

    # Related questions
    rq = _extract_related_questions(data.get("related_questions", []))
    if rq:
        payload["related_questions"] = rq

    # Related searches
    rs = _extract_related_searches(data.get("related_searches", []))
    if rs:
        payload["related_searches"] = rs

    return payload


# ---------------------------------------------------------------------------
# Build compact markdown summary for LLM reasoning
# ---------------------------------------------------------------------------


def _build_markdown_summary(payload: dict) -> str:
    """Create a compact text summary for LLM input (no raw JSON)."""
    lines: list[str] = []
    query = payload.get("query", "")
    lines.append(f'## Search Results for "{query}"')

    si = payload.get("search_info", {})
    if si.get("total_results"):
        time_str = (
            f" ({si['time_taken_displayed']})" if si.get("time_taken_displayed") else ""
        )
        lines.append(f"*About {si['total_results']} results{time_str}*\n")

    # Answer box
    ab = payload.get("answer_box")
    if ab:
        lines.append("### Direct Answer")
        if ab.get("title"):
            lines.append(f"**{ab['title']}**")
        if ab.get("result"):
            lines.append(ab["result"])
        elif ab.get("answer"):
            lines.append(ab["answer"])
        elif ab.get("snippet"):
            lines.append(ab["snippet"])
        # Finance
        if ab.get("stock") and ab.get("price"):
            pm = ab.get("price_movement", {})
            movement = ""
            if pm.get("movement") and pm.get("percentage"):
                direction = (
                    "+"
                    if pm["movement"] == "Up"
                    else "-"
                    if pm["movement"] == "Down"
                    else ""
                )
                movement = f" ({direction}{pm['percentage']}%)"
            lines.append(
                f"{ab['stock']}: {ab.get('currency', '$')}{ab['price']}{movement}"
            )
        lines.append("")

    # Knowledge graph
    kg = payload.get("knowledge_graph")
    if kg:
        lines.append("### Knowledge Panel")
        title_line = f"**{kg['title']}**"
        if kg.get("type"):
            title_line += f" ({kg['type']})"
        lines.append(title_line)
        if kg.get("description"):
            lines.append(kg["description"])
        if kg.get("website"):
            lines.append(f"Website: {kg['website']}")
        facts = kg.get("facts", {})
        for k, v in list(facts.items())[:5]:
            label = k.replace("_", " ").title()
            lines.append(f"{label}: {v}")
        lines.append("")

    # Organic results
    organic = payload.get("organic_results", [])
    if organic:
        lines.append("### Web Results")
        for r in organic:
            pos = r.get("position", "")
            title = r.get("title", "")
            link = r.get("link", "")
            snippet = r.get("snippet", "")
            date = f" ({r['date']})" if r.get("date") else ""
            lines.append(f"{pos}. [{title}]({link}){date}")
            if snippet:
                lines.append(f"   {snippet}")
        lines.append("")

    # Top stories
    ts = payload.get("top_stories", [])
    if ts:
        lines.append("### Top Stories")
        for s in ts:
            src = f" - {s['source']}" if s.get("source") else ""
            date = f" ({s['date']})" if s.get("date") else ""
            lines.append(f"- [{s.get('title', '')}]({s.get('link', '')}){src}{date}")
        lines.append("")

    # News
    news = payload.get("news_results", [])
    if news:
        lines.append("### News")
        for n in news:
            src = f" - {n['source']}" if n.get("source") else ""
            date = f" ({n['date']})" if n.get("date") else ""
            lines.append(f"- [{n.get('title', '')}]({n.get('link', '')}){src}{date}")
        lines.append("")

    # Videos
    videos = payload.get("video_results", [])
    if videos:
        lines.append("### Videos")
        for v in videos:
            dur = f" [{v['duration']}]" if v.get("duration") else ""
            lines.append(f"- [{v.get('title', '')}]({v.get('link', '')}){dur}")
        lines.append("")

    # Shopping
    shopping = payload.get("shopping_results", [])
    if shopping:
        lines.append("### Shopping")
        for s in shopping:
            price = f" - {s['price']}" if s.get("price") else ""
            src = f" from {s['source']}" if s.get("source") else ""
            lines.append(f"- **{s.get('title', '')}**{price}{src}")
        lines.append("")

    # Related questions
    rq = payload.get("related_questions", [])
    if rq:
        lines.append("### People Also Ask")
        for q in rq:
            lines.append(f"- {q.get('question', '')}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Function registration
# ---------------------------------------------------------------------------


@register_function(config_type=SerpApiSearchConfig)
async def serpapi_search_function(config: SerpApiSearchConfig, builder: Builder):
    api_key = config.api_key or os.environ.get("SERPAPI_KEY", "")

    async def _search(
        query: str,
        search_type: str = "google",
        location: str = "",
        num_results: int = 10,
        time_period: str = "",
    ) -> str:
        """Search the web and return structured results with rich visual cards.

        Args:
            query: The search query string.
            search_type: Search engine to use. One of: "google" (default),
                         "google_news", "google_images", "google_shopping",
                         "google_videos".
            location: Geographic location for localized results (e.g., "Austin, Texas").
            num_results: Number of results to request (default 10, max 20).
            time_period: Time filter. One of: "" (any time), "qdr:h" (past hour),
                         "qdr:d" (past day), "qdr:w" (past week), "qdr:m" (past month),
                         "qdr:y" (past year).
        """
        if not api_key:
            return "**Error:** No SerpAPI key configured. Set the SERPAPI_KEY environment variable."

        engine_map = {
            "google": "google",
            "google_news": "google_news",
            "google_images": "google_images",
            "google_shopping": "google_shopping",
            "google_videos": "google_videos",
        }
        engine = engine_map.get(search_type.lower().strip(), "google")
        num_results = max(1, min(num_results, 20))

        params: dict[str, str | int] = {
            "api_key": api_key,
            "engine": engine,
            "q": query,
            "num": num_results,
        }
        if location:
            params["location"] = location
        if time_period:
            params["tbs"] = time_period

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                response = await client.get(config.base_url, params=params)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "SerpAPI returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return f"**Error:** SerpAPI returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            logger.error("SerpAPI request failed: %s", exc)
            return f"**Error:** Could not reach SerpAPI: {exc}"

        # Extract structured payload
        payload = _build_payload(data, query)

        # Build compact markdown for LLM reasoning
        summary = _build_markdown_summary(payload)

        # Build the rich UI tag
        search_tag = f"<searchresults>{json.dumps(payload)}</searchresults>"

        return f"{summary}\n\n{search_tag}"

    try:
        yield FunctionInfo.from_fn(
            _search,
            description=(
                "Search the web using SerpAPI and return structured results with rich "
                "visual rendering. Results include organic web listings, knowledge graph "
                "panels, answer boxes, top stories, news, images, shopping results, and "
                "videos. The response contains both a compact text summary for reasoning "
                "and structured data for beautiful UI cards. "
                "Supports Google Search (default), Google News, Google Images, Google "
                "Shopping, and Google Videos via the search_type parameter. "
                "Use location for geographically relevant queries. "
                "Use time_period for recency filtering: 'qdr:h' (hour), 'qdr:d' (day), "
                "'qdr:w' (week), 'qdr:m' (month), 'qdr:y' (year)."
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up serpapi_search function.")
