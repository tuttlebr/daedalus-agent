"""NAT tool for exact recovery of reversibly compacted tool output."""

import json
import logging
import re

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.identity import authenticated_user_id_from_context
from nat_helpers.tool_output_compaction import REFERENCE_PATTERN, ToolOutputStore
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


class ToolOutputRetrieverConfig(FunctionBaseConfig, name="tool_output_retriever"):
    """Configure bounded exact retrieval from the short-lived output cache."""

    description: str = Field(
        default=(
            "Retrieve omitted content from a reversible Daedalus tool-output "
            "preview. Search by query or page the exact original by character offset."
        )
    )
    max_chunk_chars: int = Field(default=12_000, ge=1_000, le=50_000)
    max_matches: int = Field(default=10, ge=1, le=50)
    context_chars: int = Field(default=300, ge=50, le=2_000)


class ToolOutputRetrieverInput(BaseModel):
    """Query and paging options for one opaque tool-output reference."""

    model_config = ConfigDict(extra="forbid")

    reference: str = Field(
        min_length=36,
        max_length=36,
        description="Opaque tor_ reference from a compacted tool result.",
    )
    query: str | None = Field(
        default=None,
        min_length=1,
        max_length=500,
        description=(
            "Case-insensitive literal search. Omit to read an exact content chunk."
        ),
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Character offset for exact paging when query is omitted.",
    )
    max_chars: int | None = Field(
        default=None,
        ge=1_000,
        le=50_000,
        description="Requested page size, capped by the tool configuration.",
    )


def _json_result(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _page_content(
    content: str,
    *,
    reference: str,
    offset: int,
    max_chars: int,
) -> str:
    bounded_offset = min(offset, len(content))
    end = min(len(content), bounded_offset + max_chars)
    return _json_result(
        {
            "reference": reference,
            "mode": "exact_page",
            "offset": bounded_offset,
            "end_offset": end,
            "total_chars": len(content),
            "complete": end >= len(content),
            "next_offset": None if end >= len(content) else end,
            "content": content[bounded_offset:end],
        }
    )


def _search_content(
    content: str,
    *,
    reference: str,
    query: str,
    max_matches: int,
    context_chars: int,
) -> str:
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    matches: list[dict[str, object]] = []
    cursor = 0
    while len(matches) < max_matches:
        match = pattern.search(content, cursor)
        if match is None:
            break
        start = max(0, match.start() - context_chars)
        end = min(len(content), match.end() + context_chars)
        matches.append(
            {
                "match_offset": match.start(),
                "start_offset": start,
                "end_offset": end,
                "content": content[start:end],
            }
        )
        cursor = match.end()
    more_matches = pattern.search(content, cursor) is not None
    return _json_result(
        {
            "reference": reference,
            "mode": "literal_search",
            "query": query,
            "total_chars": len(content),
            "matches": matches,
            "matches_returned": len(matches),
            "more_matches": more_matches,
        }
    )


def _build_retriever_runner(config: ToolOutputRetrieverConfig, store: ToolOutputStore):
    async def _arun(input_data: ToolOutputRetrieverInput) -> str:
        if not REFERENCE_PATTERN.fullmatch(input_data.reference):
            return _json_result({"error": "invalid_tool_output_reference"})
        try:
            user_id = authenticated_user_id_from_context()
        except Exception as exc:
            logger.warning(
                "Denied tool-output retrieval without trusted identity: "
                "error_class=%s",
                type(exc).__name__,
            )
            return _json_result({"error": "tool_output_retrieval_denied"})

        content = await store.get(user_id, input_data.reference)
        if content is None:
            return _json_result(
                {
                    "error": "tool_output_not_found",
                    "reference": input_data.reference,
                    "message": (
                        "The reference expired or belongs to a different user. "
                        "Repeat the source tool call if the data is still needed."
                    ),
                }
            )
        if input_data.query:
            return _search_content(
                content,
                reference=input_data.reference,
                query=input_data.query,
                max_matches=config.max_matches,
                context_chars=config.context_chars,
            )
        return _page_content(
            content,
            reference=input_data.reference,
            offset=input_data.offset,
            max_chars=min(
                input_data.max_chars or config.max_chunk_chars, config.max_chunk_chars
            ),
        )

    return _arun


@register_function(config_type=ToolOutputRetrieverConfig)
async def tool_output_retriever(
    config: ToolOutputRetrieverConfig,
    _builder: Builder,
):
    store = ToolOutputStore()
    try:
        yield FunctionInfo.from_fn(
            _build_retriever_runner(config, store),
            description=config.description,
            input_schema=ToolOutputRetrieverInput,
        )
    finally:
        await store.close()
