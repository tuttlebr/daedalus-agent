import logging
import os
import time
import uuid
from typing import Any

import serpapi
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import BaseModel, Field

from .geolocation_helper import GeolocationResult

logger = logging.getLogger(__name__)

# Configure logging level/format if not already configured by the host app
if not logging.getLogger().handlers:
    level_name = os.getenv("LOG_LEVEL") or os.getenv("NAT_LOG_LEVEL") or "INFO"
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logger.setLevel(level)


class SerpapiAiFunctionConfig(FunctionBaseConfig, name="serpapi_ai"):
    """
    Google AI Mode search function using SerpAPI.

    This function provides access to Google's AI-generated search summaries
    with structured text blocks and source references.
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
        description=(
            "Use geolocation_retriever to resolve location names to " "canonical forms"
        ),
    )
    geolocation_retriever_name: str | None = Field(
        default="geolocation_retriever_tool",
        description=(
            "Name of the geolocation retriever to use when "
            "use_geolocation_retriever is True"
        ),
    )
    default_location: str = Field(
        default="United States",
        description="Default location for searches if not specified",
    )


class SearchRequest(BaseModel):
    """Request model for AI Mode search queries"""

    query: str = Field(..., description="Search query")
    location: str | None = Field(None, description="Location for search")
    api_key: str | None = Field(
        None, description="SerpAPI key for this request. Overrides config/env"
    )


class TextBlock(BaseModel):
    """Represents a text block in the AI response"""

    type: str = Field(..., description="Type: paragraph, heading, list")
    snippet: str | None = Field(None, description="Text content")
    snippet_highlighted_words: list[str] | None = Field(
        None, description="Highlighted keywords"
    )
    reference_indexes: list[int] | None = Field(
        None, description="Indexes of supporting references"
    )
    list: list[dict[str, Any]] | None = Field(
        None, description="List items for list-type blocks"
    )
    text_blocks: list[dict[str, Any]] | None = Field(
        None, description="Nested text blocks"
    )


class Reference(BaseModel):
    """Source reference for AI-generated content"""

    title: str
    link: str
    snippet: str | None = None
    source: str | None = None
    index: int


class SearchResponse(BaseModel):
    """Response model for AI Mode search results"""

    success: bool
    query: str
    text_blocks: list[TextBlock] = Field(default_factory=list)
    references: list[Reference] = Field(default_factory=list)
    search_metadata: dict[str, Any] | None = None
    error: str | None = None


@register_function(config_type=SerpapiAiFunctionConfig)
async def serpapi_ai_function(
    config: SerpapiAiFunctionConfig,
    builder: Builder,
):
    """
    Google AI Mode search function using SerpAPI.

    This function performs AI-enhanced web searches using Google's AI Mode
    via the SerpAPI service. It returns structured AI-generated summaries
    with text blocks and source references.
    """
    # Get default API key from config or environment
    default_api_key = config.api_key or os.getenv("SERPAPI_KEY")

    # Get geolocation retriever if configured
    geolocation_fn = None
    if config.use_geolocation_retriever and config.geolocation_retriever_name:
        try:
            geolocation_fn = await builder.get_function(
                config.geolocation_retriever_name
            )
            logger.info(
                "SerpAPI AI Mode configured to use geolocation_retriever: %s",
                config.geolocation_retriever_name,
            )
        except Exception as exc:
            logger.warning(
                "Failed to get geolocation_retriever '%s': %s. "
                "Location names will be used as-is.",
                config.geolocation_retriever_name,
                exc,
            )

    async def _resolve_location(location_str: str) -> str:
        """Resolve location using geolocation_retriever if configured."""
        if not config.use_geolocation_retriever or not geolocation_fn:
            return location_str

        try:
            # Call the retriever function - try .ainvoke() first, then call
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
                "Failed to resolve location '%s' using retriever: %s. "
                "Using original.",
                location_str,
                exc,
            )

        return location_str

    async def _search_function(request: dict[str, Any]) -> dict[str, Any]:
        """
        Perform a Google AI Mode search using SerpAPI.

        Args:
            request: Dictionary containing search parameters
                - query (str): Search query (required)
                - location (str): Location for search (optional)
                - api_key (str): SerpAPI key for this request (optional)

        Returns:
            Dictionary containing AI-generated results and metadata
        """
        request_id = uuid.uuid4().hex
        start_time = time.time()
        logger.debug(
            "[%s] Starting AI Mode search: type=%s",
            request_id,
            type(request).__name__,
        )

        try:
            # Parse request
            if isinstance(request, str):
                logger.info("[%s] Simple string query: %s", request_id, request)
                search_request = SearchRequest(query=request)
            elif isinstance(request, dict):
                raw_dict = request
                # NAT may wrap inputs under a 'request' key
                if isinstance(raw_dict.get("request"), dict):
                    raw_dict = raw_dict["request"]

                logger.debug(
                    "[%s] Raw request keys: %s", request_id, list(raw_dict.keys())
                )

                # Normalize to SearchRequest fields
                parsed: dict[str, Any] = {}

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

            # Initialize SerpAPI client
            client = serpapi.Client(api_key=api_key)

            # Resolve location if provided
            resolved_location = None
            if search_request.location:
                resolved_location = await _resolve_location(search_request.location)
            elif config.default_location:
                resolved_location = await _resolve_location(config.default_location)

            # Build search parameters for AI Mode
            search_params = {
                "q": search_request.query,
                "engine": "google_ai_mode",
                "device": "desktop",
            }

            # Add location if available
            if resolved_location:
                search_params["location"] = resolved_location

            # Log request details
            logger.info(
                "[%s] SerpAPI AI Mode request q='%s' loc='%s'",
                request_id,
                search_request.query,
                search_params.get("location"),
            )

            # Perform the search
            try:
                logger.debug("[%s] Calling SerpAPI client.search", request_id)
                response_data = client.search(search_params)
                logger.debug(
                    "[%s] Received response. Keys: %s",
                    request_id,
                    list(response_data.keys()),
                )
            except Exception as search_error:
                # Extract error details for debugging
                raw_body_snippet = None
                status_code = None
                try:
                    resp = getattr(search_error, "response", None)
                    if resp is not None:
                        status_code = getattr(resp, "status_code", None)
                        text_method = getattr(resp, "text", None)
                        if callable(text_method):
                            body_text = resp.text()
                        else:
                            body_text = getattr(resp, "text", None)
                        if body_text is None and hasattr(resp, "content"):
                            body_text = getattr(resp, "content", None)
                        if isinstance(body_text, (bytes, bytearray)):
                            try:
                                body_text = body_text.decode("utf-8", errors="replace")
                            except (UnicodeDecodeError, AttributeError):
                                body_text = None
                        if isinstance(body_text, str):
                            raw_body_snippet = body_text[:500]
                except (AttributeError, TypeError):
                    pass

                body_snippet = (
                    raw_body_snippet[:200] + "..."
                    if isinstance(raw_body_snippet, str) and len(raw_body_snippet) > 200
                    else raw_body_snippet
                )

                logger.exception(
                    "[%s] SerpAPI AI Mode failed status=%s body=%s err=%s",
                    request_id,
                    status_code,
                    body_snippet,
                    str(search_error),
                )
                raise

            # Parse text blocks
            text_blocks_models: list[TextBlock] = []
            text_blocks_raw = response_data.get("text_blocks", [])
            for block in text_blocks_raw:
                text_blocks_models.append(
                    TextBlock(
                        type=block.get("type", ""),
                        snippet=block.get("snippet"),
                        snippet_highlighted_words=block.get(
                            "snippet_highlighted_words"
                        ),
                        reference_indexes=block.get("reference_indexes"),
                        list=block.get("list"),
                        text_blocks=block.get("text_blocks"),
                    )
                )

            # Parse references
            references_models: list[Reference] = []
            references_raw = response_data.get("references", [])
            for ref in references_raw:
                references_models.append(
                    Reference(
                        title=ref.get("title", ""),
                        link=ref.get("link", ""),
                        snippet=ref.get("snippet"),
                        source=ref.get("source"),
                        index=ref.get("index", 0),
                    )
                )

            # Get search metadata
            search_metadata = response_data.get("search_metadata")

            # Build response
            response = SearchResponse(
                success=True,
                query=search_request.query,
                text_blocks=text_blocks_models,
                references=references_models,
                search_metadata=search_metadata,
            )

            duration_ms = int((time.time() - start_time) * 1000)
            logger.info(
                "[%s] AI Mode search completed in %d ms: q='%s' " "blocks=%s refs=%s",
                request_id,
                duration_ms,
                response.query,
                len(response.text_blocks),
                len(response.references),
            )
            return response.model_dump()

        except Exception as e:
            logger.exception("[%s] AI Mode search error: %s", request_id, str(e))
            return SearchResponse(
                success=False,
                query=(
                    request.get("query", "")
                    if isinstance(request, dict)
                    else str(request)
                ),
                error=str(e),
            ).model_dump()

    async def _simple_search(query: str) -> str:
        """
        Simple AI Mode search that returns formatted results as a string.

        Args:
            query: Search query string

        Returns:
            Formatted AI-generated search summary as a string
        """
        result = await _search_function({"query": query})

        if not result["success"]:
            return f"Search failed: {result.get('error', 'Unknown error')}"

        # Format results as readable string
        output = f"AI Mode Search Results for: '{result['query']}'\n\n"

        # Process text blocks
        text_blocks = result.get("text_blocks", [])
        for block in text_blocks:
            block_type = block.get("type", "")
            snippet = block.get("snippet", "")

            if block_type == "heading":
                output += f"\n{snippet}\n"
            elif block_type == "paragraph":
                output += f"{snippet}\n\n"
            elif block_type == "list" and "list" in block:
                for item in block["list"]:
                    item_snippet = item.get("snippet", "")
                    output += f"  • {item_snippet}\n"
                output += "\n"

        # Add references
        references = result.get("references", [])
        if references:
            output += "\nSources:\n"
            for ref in references[:5]:  # Show top 5 references
                idx = ref.get("index", "")
                title = ref.get("title", "")
                source = ref.get("source", "")
                output += f"  [{idx}] {title} - {source}\n"

        return output

    try:
        # Register the primary structured search function
        yield FunctionInfo.create(
            single_fn=_search_function,
            description=(
                "Google AI Mode search that returns AI-generated summaries "
                "with structured text blocks and source references. "
                "Use this when you need comprehensive, AI-synthesized "
                "information on a topic."
            ),
        )
    except GeneratorExit:
        logger.warning("SerpAPI AI Mode function exited early!")
    finally:
        logger.info("Cleaning up SerpAPI AI Mode function.")
