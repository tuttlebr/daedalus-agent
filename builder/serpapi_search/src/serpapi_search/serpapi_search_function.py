import logging
import os
import time
import uuid
from collections.abc import Mapping
from typing import TypedDict

import serpapi
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import BaseModel, Field

from .geolocation_helper import GeolocationResult
from .result_scraper import SerpLinkScraperSettings, scrape_serp_links


class WorkflowMapping(TypedDict, total=False):
    query: object
    q: object
    text: object
    input: object
    message: object
    prompt: object
    location: object
    num: object
    n: object
    limit: object
    page: object
    time_period: object
    api_key: object
    request: "WorkflowMapping"


logger = logging.getLogger(__name__)

# Configure logging level/format if not already configured by the host app
if not logging.getLogger().handlers:
    level_name = os.getenv("LOG_LEVEL") or os.getenv("NAT_LOG_LEVEL") or "INFO"
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # Ensure module logger respects configured level
    logger.setLevel(level)


class SerpapiSearchFunctionConfig(FunctionBaseConfig, name="serpapi_search"):
    """
    Google Search function using SerpAPI for real-time web search results.

    This function provides access to Google search results including organic
    results, related questions, knowledge graph, and more.
    """

    api_key: str | None = Field(
        default=None,
        description=(
            "SerpAPI API key. If not provided, will use SERPAPI_KEY "
            "environment variable"
        ),
    )
    use_geolocation_retriever: bool = Field(
        default=False,
        description="Use geolocation_retriever to resolve location names to canonical forms",
    )
    geolocation_retriever_name: str | None = Field(
        default="geolocation_retriever_tool",
        description="Name of the geolocation retriever to use when use_geolocation_retriever is True",
    )
    default_location: str = Field(
        default="United States",
        description="Default location for searches if not specified in request",
    )
    default_num_results: int = Field(
        default=10,
        description=("Default number of results to return if not specified in request"),
    )


class SearchRequest(BaseModel):
    """Request model for search queries"""

    query: str = Field(..., description="Search query")
    location: str | None = Field(None, description="Location for the search")
    num: int | None = Field(None, description="Number of results to return (1-100)")
    page: int | None = Field(None, description="Page number for pagination")
    time_period: str | None = Field(
        None,
        description=(
            "Time period filter: last_hour, last_day, last_week, "
            "last_month, last_year"
        ),
    )
    api_key: str | None = Field(
        None,
        description=("SerpAPI key for this request. Overrides config/env settings"),
    )


class SearchResult(BaseModel):
    """Simplified search result model"""

    position: int
    title: str
    link: str
    snippet: str
    displayed_link: str | None = None
    date: str | None = None
    source: str | None = None


class TopStory(BaseModel):
    """Top stories result model"""

    position: int
    title: str
    link: str
    source: str | None = None
    date: str | None = None
    thumbnail: str | None = None
    live: bool | None = None
    source_logo: str | None = None


class SearchResponse(BaseModel):
    """Response model for search results"""

    success: bool
    query: str
    total_results: int | None = None
    ai_overview: dict[str, object] | None = None
    answer_box: dict[str, object] | None = None
    organic_results: list[SearchResult] = Field(default_factory=list)
    top_stories: list[TopStory] = Field(default_factory=list)
    hierarchy_levels: list[dict[str, object]] = Field(default_factory=list)
    organic_scrape: dict[str, object] | None = None
    top_story_scrape: dict[str, object] | None = None
    error: str | None = None
    raw_response: dict[str, object] | None = None


@register_function(config_type=SerpapiSearchFunctionConfig)
async def serpapi_search_function(
    config: SerpapiSearchFunctionConfig,
    builder: Builder,
):
    """
    Google Search function using SerpAPI.

    This function performs web searches using Google via the SerpAPI service.
    It returns structured search results including organic results, related
    questions, and related searches.
    """
    # Get default API key from config or environment
    default_api_key = config.api_key or os.getenv("SERPAPI_KEY")

    async def _resolve_location(location_str: str) -> str:
        """Resolve location using geolocation_retriever if configured."""
        if (
            not config.use_geolocation_retriever
            or not config.geolocation_retriever_name
        ):
            return location_str

        try:
            # Get retriever lazily during execution
            geolocation_fn = await builder.get_function(
                config.geolocation_retriever_name
            )

            # Call the retriever function - try .ainvoke() first, then direct call
            if hasattr(geolocation_fn, "ainvoke"):
                result = await geolocation_fn.ainvoke(location_str)
            else:
                result = await geolocation_fn(location_str)

            logger.debug(
                "Geolocation retriever raw result for '%s': %s",
                location_str,
                result,
            )
            geoloc = GeolocationResult.from_retriever_output(result)
            if geoloc:
                # Return the canonical display name
                logger.info(
                    "Resolved location '%s' to '%s'",
                    location_str,
                    geoloc.display_name,
                )
                return geoloc.display_name
        except Exception as exc:
            logger.warning(
                "Failed to resolve location '%s' using retriever: %s. Using original.",
                location_str,
                exc,
            )

        return location_str

    async def _search_function(request: str | WorkflowMapping) -> dict[str, object]:
        """
        Perform a Google search using SerpAPI.

        Args:
            request: Dictionary containing search parameters
                - query (str): Search query (required)
                - location (str): Location for search (optional)
                - num (int): Number of results (optional, 1-100)
                - page (int): Page number for pagination (optional)
                - time_period (str): Time filter (optional)
                - api_key (str): SerpAPI key for this request (optional)

        Returns:
            Dictionary containing search results and metadata
        """
        request_id = uuid.uuid4().hex
        start_time = time.time()
        logger.debug(
            "[%s] Starting search request: type=%s",
            request_id,
            type(request).__name__,
        )

        try:
            # Parse request
            if isinstance(request, str):
                # Handle simple string queries
                logger.info(
                    "[%s] Simple string query: %s",
                    request_id,
                    request,
                )
                search_request = SearchRequest(query=request)
            elif isinstance(request, Mapping):
                raw_dict: WorkflowMapping = request
                # NAT may wrap inputs under a 'request' key
                inner = raw_dict.get("request")
                if isinstance(inner, Mapping):
                    raw_dict = inner  # type: ignore[assignment]

                logger.debug(
                    "[%s] Raw request keys: %s", request_id, list(raw_dict.keys())
                )

                # Normalize to SearchRequest fields
                parsed: dict[str, object] = {}

                # Map possible query fields
                for key in [
                    "query",
                    "q",
                    "text",
                    "input",
                    "message",
                    "prompt",
                ]:
                    if key in raw_dict and raw_dict[key] is not None:
                        parsed["query"] = str(raw_dict[key])
                        break

                # Optional fields
                if "location" in raw_dict and raw_dict["location"] is not None:
                    parsed["location"] = str(raw_dict["location"])

                # Prefer 'num', but accept 'n' or 'limit'
                for nkey in ["num", "n", "limit"]:
                    if nkey in raw_dict and raw_dict[nkey] is not None:
                        try:
                            parsed["num"] = int(raw_dict[nkey])
                        except (ValueError, TypeError) as e:
                            logger.debug(f"Failed to convert '{nkey}' to int: {e}")
                        break

                if "page" in raw_dict and raw_dict["page"] is not None:
                    try:
                        parsed["page"] = int(raw_dict["page"])
                    except (ValueError, TypeError) as e:
                        logger.debug(f"Failed to convert 'page' to int: {e}")

                if "time_period" in raw_dict and raw_dict["time_period"] is not None:
                    parsed["time_period"] = str(raw_dict["time_period"])

                if "api_key" in raw_dict and raw_dict["api_key"] is not None:
                    parsed["api_key"] = str(raw_dict["api_key"])

                if "query" not in parsed or not parsed["query"].strip():
                    present_keys = ", ".join(list(raw_dict.keys())[:10])
                    raise ValueError(
                        "Missing required field 'query'. Acceptable keys: "
                        "query|q|text|input|message|prompt. "
                        f"Present keys: {present_keys}"
                    )

                logger.debug("[%s] Parsed request: %s", request_id, parsed)
                search_request = SearchRequest(**parsed)
            else:
                search_request = SearchRequest(query=str(request))

            # Determine which API key to use
            api_key = search_request.api_key or default_api_key
            if not api_key:
                raise ValueError(
                    "No API key provided. Set SERPAPI_KEY environment "
                    "variable, add to config, or pass in request"
                )

            # Initialize SerpAPI client with the appropriate key
            client = serpapi.Client(api_key=api_key)

            # Resolve location if provided
            resolved_location = None
            if search_request.location:
                resolved_location = await _resolve_location(search_request.location)
            elif config.default_location:
                resolved_location = await _resolve_location(config.default_location)

            # Build search parameters
            search_params = {
                "q": search_request.query,
                "engine": "google",
                "google_domain": "google.com",
                "hl": "en",
                "gl": "us",
                "start": 1,
                "num": search_request.num or config.default_num_results,
            }

            # Add location if available
            if resolved_location:
                search_params["location"] = resolved_location

            # Add optional parameters
            if search_request.page:
                search_params["page"] = search_request.page

            if search_request.time_period:
                search_params["time_period"] = search_request.time_period

            # Log request details (with API key masked)
            safe_params = dict(search_params)
            logger.debug(
                "[%s] Built search params: %s",
                request_id,
                {
                    k: safe_params.get(k)
                    for k in ("q", "location", "num", "page", "time_period")
                },
            )
            logger.info(
                "[%s] SerpAPI request q='%s' loc='%s' num=%s page=%s t='%s'",
                request_id,
                search_request.query,
                safe_params.get("location"),
                safe_params.get("num"),
                safe_params.get("page"),
                search_request.time_period,
            )

            # Perform the search with defensive logging
            try:
                logger.debug("[%s] Calling SerpAPI client.search", request_id)
                response_data = client.search(search_params)
                logger.debug(
                    "[%s] Received response. Keys: %s",
                    request_id,
                    list(response_data.keys()),
                )
            except Exception as search_error:
                # Best-effort extraction of HTTP response if provided by client
                raw_body_snippet = None
                status_code = None
                content_type = None
                try:
                    resp = getattr(search_error, "response", None)
                    if resp is not None:
                        status_code = getattr(resp, "status_code", None)
                        headers = getattr(resp, "headers", None)
                        if headers:
                            content_type = headers.get("Content-Type")
                        text_method = getattr(resp, "text", None)
                        if callable(text_method):
                            body_text = resp.text()
                        else:
                            # Some clients expose .text as property
                            body_text = getattr(resp, "text", None)
                        if body_text is None and hasattr(resp, "content"):
                            body_text = getattr(resp, "content", None)
                        if isinstance(body_text, (bytes, bytearray)):
                            try:
                                body_text = body_text.decode("utf-8", errors="replace")
                            except (UnicodeDecodeError, AttributeError) as e:
                                logger.debug(f"Failed to decode response body: {e}")
                                body_text = None
                        if isinstance(body_text, str):
                            raw_body_snippet = body_text[:500]
                except (AttributeError, TypeError) as e:
                    logger.debug(
                        f"Failed to extract response body for error logging: {e}"
                    )

                body_snippet = None
                if isinstance(raw_body_snippet, str) and len(raw_body_snippet) > 200:
                    body_snippet = raw_body_snippet[:200] + "..."
                else:
                    body_snippet = raw_body_snippet

                logger.exception(
                    "[%s] SerpAPI failed status=%s ctype=%s body=%s err=%s",
                    request_id,
                    status_code,
                    content_type,
                    body_snippet,
                    str(search_error),
                )
                raise

            # Parse organic results
            organic_results_models: list[SearchResult] = []
            organic_results_raw = response_data.get("organic_results", [])
            for idx, result in enumerate(organic_results_raw):
                organic_results_models.append(
                    SearchResult(
                        position=result.get("position", idx + 1),
                        title=result.get("title", ""),
                        link=result.get("link", ""),
                        snippet=result.get("snippet", ""),
                        displayed_link=result.get("displayed_link"),
                        date=result.get("date"),
                        source=result.get("source"),
                    )
                )

            # Parse AI overview (highest priority)
            ai_overview = response_data.get("ai_overview")

            # Parse answer box
            answer_box = response_data.get("answer_box")

            # Parse top stories
            top_stories_models: list[TopStory] = []
            top_stories_raw = response_data.get("top_stories", [])
            for idx, story in enumerate(top_stories_raw):
                top_stories_models.append(
                    TopStory(
                        position=story.get("position", idx + 1),
                        title=story.get("title", ""),
                        link=story.get("link", ""),
                        source=story.get("source"),
                        date=story.get("date"),
                        thumbnail=story.get("thumbnail"),
                        live=story.get("live"),
                        source_logo=story.get("source_logo"),
                    )
                )

            organic_results_payload = [
                item.model_dump() for item in organic_results_models
            ]
            top_stories_payload = [item.model_dump() for item in top_stories_models]

            # Build hierarchy levels
            hierarchy_levels: list[dict[str, object]] = []

            # Level 0: AI Overview (highest priority)
            level_zero_data = {"ai_overview": ai_overview} if ai_overview else {}
            hierarchy_levels.append(
                {
                    "level": 0,
                    "description": "ai_overview",
                    "available": bool(level_zero_data),
                    "data": level_zero_data,
                }
            )

            # Level 1: Answer Box
            level_one_data = {"answer_box": answer_box} if answer_box else {}
            hierarchy_levels.append(
                {
                    "level": 1,
                    "description": "answer_box",
                    "available": bool(level_one_data),
                    "data": level_one_data,
                }
            )

            # Level 2: Answer Box + Organic Results
            level_two_data: dict[str, object] = {}
            if answer_box:
                level_two_data["answer_box"] = answer_box
            if organic_results_payload:
                level_two_data["organic_results"] = organic_results_payload
            hierarchy_levels.append(
                {
                    "level": 2,
                    "description": "answer_box + organic_results",
                    "available": bool(level_two_data),
                    "data": level_two_data,
                }
            )

            # Level 3: Answer Box + Organic Results + Top Stories
            level_three_data = dict(level_two_data)
            if top_stories_payload:
                level_three_data["top_stories"] = top_stories_payload
            hierarchy_levels.append(
                {
                    "level": 3,
                    "description": "answer_box + organic_results + top_stories",
                    "available": bool(level_three_data),
                    "data": level_three_data,
                }
            )

            # Scrape representative links from results (skip if ai_overview is present)
            organic_scrape_data: dict[str, object] | None = None
            top_story_scrape_data: dict[str, object] | None = None

            if ai_overview:
                # AI Overview provides sufficient context, skip web scraping
                logger.info(
                    "[%s] AI Overview present, skipping web scraping enrichment",
                    request_id,
                )
                organic_scrape_data = {"skipped": "AI Overview available"}
                top_story_scrape_data = {"skipped": "AI Overview available"}
            else:
                try:
                    (
                        organic_scrape_outcome,
                        top_story_scrape_outcome,
                    ) = await scrape_serp_links(
                        organic_entries=organic_results_payload,
                        top_story_entries=top_stories_payload,
                        settings=SerpLinkScraperSettings(),
                    )
                    organic_scrape_data = organic_scrape_outcome.model_dump()
                    top_story_scrape_data = top_story_scrape_outcome.model_dump()
                except Exception as scrape_error:  # noqa: BLE001 - defensive catch
                    logger.exception(
                        "[%s] Enrichment scrape failed: %s", request_id, scrape_error
                    )
                    organic_scrape_data = {"error": str(scrape_error)}
                    top_story_scrape_data = {"error": str(scrape_error)}

            # Get total results from search information
            search_info = response_data.get("search_information", {})
            total_results = search_info.get("total_results")

            # Build response
            response = SearchResponse(
                success=True,
                query=search_request.query,
                total_results=total_results,
                ai_overview=ai_overview,
                answer_box=answer_box,
                organic_results=organic_results_models,
                top_stories=top_stories_models,
                hierarchy_levels=hierarchy_levels,
                organic_scrape=organic_scrape_data,
                top_story_scrape=top_story_scrape_data,
            )

            duration_ms = int((time.time() - start_time) * 1000)
            logger.info(
                "[%s] Search completed ok in %d ms: q='%s' "
                "ai_overview=%s answer_box=%s organic=%s top_stories=%s",
                request_id,
                duration_ms,
                response.query,
                bool(response.ai_overview),
                bool(response.answer_box),
                len(response.organic_results),
                len(response.top_stories),
            )
            return response.model_dump()

        except Exception as e:
            logger.exception("[%s] Search error: %s", request_id, str(e))
            fallback_query = ""
            if isinstance(request, Mapping):
                raw_query = request.get("query")
                if isinstance(raw_query, str):
                    fallback_query = raw_query
            if not fallback_query:
                fallback_query = str(request)
            return SearchResponse(
                success=False,
                query=fallback_query,
                error=str(e),
            ).model_dump()

    # Create a user-friendly wrapper function
    async def _simple_search(query: str) -> str:
        """
        Simple search function that returns formatted results as a string.

        Args:
            query: Search query string

        Returns:
            Formatted search results as a string
        """
        result = await _search_function({"query": query})

        if not result["success"]:
            return f"Search failed: {result.get('error', 'Unknown error')}"

        # Format results as a readable string
        output = f"Search Results for: '{result['query']}'\n"
        output += f"Total results: {result.get('total_results', 'Unknown')}\n\n"

        # Add AI Overview if present (highest priority)
        ai_overview = result.get("ai_overview")
        if isinstance(ai_overview, dict) and ai_overview:
            output += "AI Overview:\n"
            text_blocks = ai_overview.get("text_blocks", [])
            for block in text_blocks:
                block_type = block.get("type", "")
                snippet = block.get("snippet", "")

                if block_type == "heading":
                    output += f"\n{snippet}\n"
                elif block_type == "paragraph":
                    output += f"{snippet}\n\n"
                elif block_type == "list" and "list" in block:
                    for item in block["list"]:
                        title = item.get("title", "")
                        item_snippet = item.get("snippet", "")
                        output += f"  • {title} {item_snippet}\n"
                    output += "\n"

            # Add references if present
            references = ai_overview.get("references", [])
            if references:
                output += "Sources:\n"
                for ref in references[:3]:  # Show top 3 references
                    output += f"  [{ref.get('index', '')}] {ref.get('title', '')} - {ref.get('source', '')}\n"
                output += "\n"

        # Add answer box summary if present
        answer_box = result.get("answer_box")
        if isinstance(answer_box, dict) and answer_box:
            output += "Answer Box:\n"
            for key, value in answer_box.items():
                if isinstance(value, (str, int, float)):
                    output += f"- {key}: {value}\n"
            output += "\n"

        # Add organic results
        organic_results = result.get("organic_results", [])
        if organic_results:
            output += "Top Results:\n"
            for r in organic_results:
                output += f"{r['position']}. {r['title']}\n"
                output += f"   URL: {r['link']}\n"
                output += f"   {r['snippet']}\n\n"

        # Add top stories
        top_stories = result.get("top_stories", [])
        if top_stories:
            output += "\nTop Stories:\n"
            for story in top_stories:
                output += (
                    f"- {story['title']} ({story.get('source', 'Unknown source')})\n"
                )
                output += f"  URL: {story['link']}\n"
                if story.get("date"):
                    output += f"  Date: {story['date']}\n"
                if story.get("live"):
                    output += "  Live update\n"
                output += "\n"

        return output

    try:
        # Register the primary structured search function
        yield FunctionInfo.create(
            single_fn=_search_function,
            description="API endpoint allows you to scrape the results from Google search engine via our SerpApi service. Always use this when you think you need access to real-time information.",
        )
    except GeneratorExit:
        logger.warning("SerpAPI search function exited early!")
    finally:
        logger.info("Cleaning up SerpAPI search function.")
