import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

import serpapi
from pydantic import BaseModel, Field

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

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
    api_key: Optional[str] = Field(
        default=None,
        description=(
            "SerpAPI API key. If not provided, will use SERPAPI_KEY "
            "environment variable"
        )
    )
    default_location: str = Field(
        default="United States",
        description="Default location for searches if not specified in request"
    )
    default_num_results: int = Field(
        default=10,
        description=(
            "Default number of results to return if not specified in request"
        )
    )


class SearchRequest(BaseModel):
    """Request model for search queries"""
    query: str = Field(..., description="Search query")
    location: Optional[str] = Field(
        None, description="Location for the search"
    )
    num: Optional[int] = Field(
        None, description="Number of results to return (1-100)"
    )
    page: Optional[int] = Field(
        None, description="Page number for pagination"
    )
    time_period: Optional[str] = Field(
        None,
        description=(
            "Time period filter: last_hour, last_day, last_week, "
            "last_month, last_year"
        )
    )
    api_key: Optional[str] = Field(
        None,
        description=(
            "SerpAPI key for this request. Overrides config/env settings"
        )
    )


class SearchResult(BaseModel):
    """Simplified search result model"""
    position: int
    title: str
    link: str
    snippet: str
    displayed_link: Optional[str] = None
    date: Optional[str] = None
    source: Optional[str] = None


class SearchResponse(BaseModel):
    """Response model for search results"""
    success: bool
    query: str
    total_results: Optional[int] = None
    results: List[SearchResult] = Field(default_factory=list)
    related_questions: List[Dict[str, Any]] = Field(default_factory=list)
    related_searches: List[Dict[str, str]] = Field(default_factory=list)
    error: Optional[str] = None
    raw_response: Optional[Dict[str, Any]] = None


@register_function(config_type=SerpapiSearchFunctionConfig)
async def serpapi_search_function(
    config: SerpapiSearchFunctionConfig, builder: Builder  # noqa: F841
):
    """
    Google Search function using SerpAPI.

    This function performs web searches using Google via the SerpAPI service.
    It returns structured search results including organic results, related
    questions, and related searches.
    """
    # Get default API key from config or environment
    default_api_key = config.api_key or os.getenv("SERPAPI_KEY")

    async def _search_function(request: Dict[str, Any]) -> Dict[str, Any]:
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
            elif isinstance(request, dict):
                raw_dict = request
                # NAT may wrap inputs under a 'request' key
                if isinstance(raw_dict.get("request"), dict):
                    raw_dict = raw_dict["request"]

                logger.debug("[%s] Raw request keys: %s", request_id, list(raw_dict.keys()))

                # Normalize to SearchRequest fields
                parsed: Dict[str, Any] = {}

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
                        except Exception:
                            pass
                        break

                if "page" in raw_dict and raw_dict["page"] is not None:
                    try:
                        parsed["page"] = int(raw_dict["page"])
                    except Exception:
                        pass

                if (
                    "time_period" in raw_dict
                    and raw_dict["time_period"] is not None
                ):
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

            # Build search parameters
            search_params = {
                "q": search_request.query,
                "engine": "google",
                "location": search_request.location or config.default_location,
                "google_domain": "google.com",
                "hl": "en",
                "gl": "us",
                "start": 1,
                "num": search_request.num or config.default_num_results,
            }

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
                {k: safe_params.get(k) for k in (
                    "q", "location", "num", "page", "time_period"
                )},
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
                                body_text = body_text.decode(
                                    "utf-8", errors="replace"
                                )
                            except Exception:
                                body_text = None
                        if isinstance(body_text, str):
                            raw_body_snippet = body_text[:500]
                except Exception:
                    pass

                body_snippet = None
                if (
                    isinstance(raw_body_snippet, str)
                    and len(raw_body_snippet) > 200
                ):
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
            results = []
            organic_results = response_data.get("organic_results", [])
            for idx, result in enumerate(organic_results):
                search_result = SearchResult(
                    position=result.get("position", idx + 1),
                    title=result.get("title", ""),
                    link=result.get("link", ""),
                    snippet=result.get("snippet", ""),
                    displayed_link=result.get("displayed_link"),
                    date=result.get("date"),
                    source=result.get("source")
                )
                results.append(search_result)

            # Extract related questions
            related_questions = []
            for question in response_data.get("related_questions", []):
                related_questions.append({
                    "question": question.get("question", ""),
                    "answer": question.get("answer", ""),
                    "source": (
                        question.get("source", {})
                        if question.get("source") else {}
                    )
                })

            # Extract related searches
            related_searches = []
            for search in response_data.get("related_searches", []):
                related_searches.append({
                    "query": search.get("query", ""),
                    "link": search.get("link", "")
                })

            # Get total results from search information
            search_info = response_data.get("search_information", {})
            total_results = search_info.get("total_results")

            # Build response
            response = SearchResponse(
                success=True,
                query=search_request.query,
                total_results=total_results,
                results=[r.model_dump() for r in results],
                related_questions=related_questions,
                related_searches=related_searches,
                raw_response=response_data  # Include raw response
            )

            duration_ms = int((time.time() - start_time) * 1000)
            logger.info(
                "[%s] Search completed ok in %d ms: q='%s' "
                "results=%s related_q=%s related_s=%s",
                request_id,
                duration_ms,
                response.query,
                len(response.results),
                len(response.related_questions),
                len(response.related_searches),
            )
            return response.model_dump()

        except Exception as e:
            logger.exception("[%s] Search error: %s", request_id, str(e))
            return SearchResponse(
                success=False,
                query=(
                    request.get("query", "")
                    if isinstance(request, dict) else str(request)
                ),
                error=str(e)
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
        output += (
            f"Total results: {result.get('total_results', 'Unknown')}\n\n"
        )

        # Add organic results
        if result["results"]:
            output += "Top Results:\n"
            for r in result["results"]:
                output += f"{r['position']}. {r['title']}\n"
                output += f"   URL: {r['link']}\n"
                output += f"   {r['snippet']}\n\n"

        # Add related questions
        if result["related_questions"]:
            output += "\nPeople Also Ask:\n"
            for q in result["related_questions"][:3]:
                output += f"- {q['question']}\n"
                if q.get('answer'):
                    output += f"  {q['answer'][:100]}...\n"

        # Add related searches
        if result["related_searches"]:
            output += "\nRelated Searches:\n"
            for s in result["related_searches"][:5]:
                output += f"- {s['query']}\n"

        return output

    try:
        # Register the primary structured search function
        yield FunctionInfo.create(
            single_fn=_search_function,
            description="Perform Google search. Use for getting the latest information, news, sports and event information. Anything you'd use Google for.",
        )
    except GeneratorExit:
        logger.warning("SerpAPI search function exited early!")
    finally:
        logger.info("Cleaning up SerpAPI search function.")
