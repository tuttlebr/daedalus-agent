import logging
import os
import time
import uuid
from collections.abc import Mapping
from typing import Any, TypedDict

import serpapi
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.geolocation import GeolocationResult
from nat_helpers.result_scraper import SerpLinkScraperSettings, scrape_serp_links
from pydantic import BaseModel, Field


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


class SerpapiSearchFunctionConfig(FunctionBaseConfig, name="serpapi_news"):
    """
    Google News search function using SerpAPI for real-time news results.

    This function provides access to Google News results including
    news articles, sources, dates, and optional full-text scraping
    of up to 3 articles.
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


class NewsSource(BaseModel):
    """News source information"""

    title: str | None = None
    name: str | None = None
    icon: str | None = None
    authors: list[str] | None = None


class NewsAuthor(BaseModel):
    """News author information"""

    thumbnail: str | None = None
    name: str | None = None
    handle: str | None = None


class NewsResult(BaseModel):
    """News result model"""

    position: int
    title: str
    link: str
    snippet: str | None = None
    source: NewsSource | None = None
    author: NewsAuthor | None = None
    thumbnail: str | None = None
    thumbnail_small: str | None = None
    type: str | None = None
    video: bool | None = None
    date: str | None = None


class SearchResponse(BaseModel):
    """Response model for news search results"""

    success: bool
    query: str
    news_results: list[NewsResult] = Field(default_factory=list)
    scraped_articles: list[dict] = Field(default_factory=list)
    error: str | None = None


@register_function(config_type=SerpapiSearchFunctionConfig)
async def serpapi_news_function(
    config: SerpapiSearchFunctionConfig,
    builder: Builder,
):
    """
    Google News search function using SerpAPI.

    This function performs news searches using Google News via the
    SerpAPI service. It returns structured news results including
    articles with sources, dates, and optional full-text scraping
    of up to 3 articles.
    """
    # Get default API key from config or environment
    default_api_key = config.api_key or os.getenv("SERPAPI_KEY")

    async def _resolve_location(location_str: str) -> tuple[str, str | None]:
        """
        Resolve location using geolocation_retriever if configured.

        Returns:
            Tuple of (location_name, country_code)
        """
        if (
            not config.use_geolocation_retriever
            or not config.geolocation_retriever_name
        ):
            return location_str, None

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
                logger.info(
                    "Resolved location '%s' to '%s' (%s)",
                    location_str,
                    geoloc.display_name,
                    geoloc.country_code,
                )
                return geoloc.display_name, geoloc.country_code
        except Exception as exc:
            logger.warning(
                "Failed to resolve location '%s' using retriever: %s. Using original.",
                location_str,
                exc,
            )

        return location_str, None

    async def _search_function(request: str | WorkflowMapping) -> dict:
        """
        Perform a Google News search using SerpAPI.

        Args:
            request: Dictionary containing search parameters
                - query (str): News search query (required)
                - time_period (str): Time filter (optional: last_hour,
                                     last_day, etc.)
                - api_key (str): SerpAPI key for this request (optional)

        Returns:
            Dictionary containing news results and scraped article
            content
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
                    "[%s] Raw request keys: %s",
                    request_id,
                    list(raw_dict.keys()),
                )

                # Normalize to SearchRequest fields
                parsed: dict = {}

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
            resolved_country = None
            if search_request.location:
                _, resolved_country = await _resolve_location(search_request.location)

            # Build search parameters for Google News
            search_params = {
                "q": search_request.query,
                "engine": "google_news",
                "gl": "us",
                "hl": "en",
            }

            # Override gl (country) if we resolved a location with country_code
            if resolved_country:
                search_params["gl"] = resolved_country.lower()

            # Add optional parameters
            if search_request.time_period:
                search_params["time_period"] = search_request.time_period

            # Log request details (with API key masked)
            safe_params = dict(search_params)
            logger.debug(
                "[%s] Built search params: %s",
                request_id,
                {k: safe_params.get(k) for k in ("q", "gl", "hl", "time_period")},
            )
            logger.info(
                "[%s] SerpAPI News request q='%s' gl='%s' t='%s'",
                request_id,
                search_request.query,
                safe_params.get("gl"),
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

            # Parse news results
            news_results_models: list[NewsResult] = []
            news_results_raw = response_data.get("news_results", [])
            for idx, result in enumerate(news_results_raw):
                # Parse source
                source_data = result.get("source")
                source = None
                if isinstance(source_data, dict):
                    source = NewsSource(
                        title=source_data.get("title"),
                        name=source_data.get("name"),
                        icon=source_data.get("icon"),
                        authors=source_data.get("authors"),
                    )

                # Parse author
                author_data = result.get("author")
                author = None
                if isinstance(author_data, dict):
                    author = NewsAuthor(
                        thumbnail=author_data.get("thumbnail"),
                        name=author_data.get("name"),
                        handle=author_data.get("handle"),
                    )

                news_results_models.append(
                    NewsResult(
                        position=result.get("position", idx + 1),
                        title=result.get("title", ""),
                        link=result.get("link", ""),
                        snippet=result.get("snippet"),
                        source=source,
                        author=author,
                        thumbnail=result.get("thumbnail"),
                        thumbnail_small=result.get("thumbnail_small"),
                        type=result.get("type"),
                        video=result.get("video"),
                        date=result.get("date"),
                    )
                )

            news_results_payload = [item.model_dump() for item in news_results_models]

            # Scrape up to 3 news article links
            scraped_articles: list[dict[str, Any]] = []

            try:
                # Extract up to 3 news entries for scraping
                entries_to_scrape = news_results_payload[:3]

                if entries_to_scrape:
                    logger.info(
                        "[%s] Attempting to scrape %d news articles",
                        request_id,
                        len(entries_to_scrape),
                    )

                    # Use the existing scraper
                    scrape_outcome, _ = await scrape_serp_links(
                        organic_entries=entries_to_scrape,
                        top_story_entries=[],
                        settings=SerpLinkScraperSettings(max_attempts_per_group=3),
                    )

                    # If we got content, add it to scraped articles
                    if scrape_outcome.content:
                        scraped_articles.append(scrape_outcome.model_dump())
                        logger.info(
                            "[%s] Successfully scraped 1 article: %s",
                            request_id,
                            scrape_outcome.link,
                        )
                    else:
                        logger.info(
                            "[%s] No articles successfully scraped. Error: %s",
                            request_id,
                            scrape_outcome.error,
                        )
            except Exception as scrape_error:  # noqa: BLE001 - defensive catch
                logger.exception(
                    "[%s] Article scraping failed: %s",
                    request_id,
                    scrape_error,
                )
                scraped_articles.append({"error": str(scrape_error)})

            # Build response
            response = SearchResponse(
                success=True,
                query=search_request.query,
                news_results=news_results_models,
                scraped_articles=scraped_articles,
            )

            duration_ms = int((time.time() - start_time) * 1000)
            logger.info(
                "[%s] News search completed ok in %d ms: q='%s' "
                "news_results=%s scraped_articles=%s",
                request_id,
                duration_ms,
                response.query,
                len(response.news_results),
                len(response.scraped_articles),
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
        Simple news search function that returns formatted results
        as a string.

        Args:
            query: Search query string

        Returns:
            Formatted news search results as a string
        """
        result = await _search_function({"query": query})

        if not result["success"]:
            error = result.get("error", "Unknown error")
            return f"News search failed: {error}"

        # Format results as a readable string
        output = f"News Search Results for: '{result['query']}'\n\n"

        # Add news results
        news_results = result.get("news_results", [])
        if news_results:
            output += f"Found {len(news_results)} news articles:\n\n"
            for article in news_results:
                output += f"{article['position']}. {article['title']}\n"
                output += f"   URL: {article['link']}\n"

                if article.get("snippet"):
                    output += f"   {article['snippet']}\n"

                source = article.get("source")
                if isinstance(source, dict):
                    source_name = source.get("name") or source.get("title", "Unknown")
                    output += f"   Source: {source_name}\n"

                if article.get("date"):
                    output += f"   Date: {article['date']}\n"

                if article.get("type"):
                    output += f"   Type: {article['type']}\n"

                output += "\n"

        # Add scraped article content if available
        scraped_articles = result.get("scraped_articles", [])
        if scraped_articles:
            output += "\n--- Scraped Article Content ---\n\n"
            for scraped in scraped_articles:
                if scraped.get("content"):
                    output += f"From: {scraped.get('link', 'Unknown')}\n"
                    output += f"Title: {scraped.get('title', 'N/A')}\n\n"
                    output += scraped["content"]
                    if scraped.get("was_truncated"):
                        output += "\n(Content was truncated)\n"
                    output += "\n\n"

        return output

    try:
        # Register the primary structured search function
        yield FunctionInfo.create(
            single_fn=_search_function,
            description=(
                "Our Google News API allows you to scrape results from the Google News search page."
            ),
        )
    except GeneratorExit:
        logger.warning("SerpAPI news function exited early!")
    finally:
        logger.info("Cleaning up SerpAPI news function.")
