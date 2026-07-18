"""Daedalus memory tools with server-authoritative user identity."""

import json
import logging
from typing import Any

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import MemoryRef
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.identity import (
    authenticated_user_id_from_context,
    execution_id_from_context_or_none,
)
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

DAILY_BRIEFING_MIN_TOP_K = 12
DAILY_BRIEFING_QUERY_TERMS = (
    "daily summary daily briefing daily brief weather locale location timezone "
    "commute calendar commitments work projects AI infrastructure NVIDIA LLM "
    "inference optimization robotics Kubernetes cluster status k8s_mcp_server "
    "read-only operations status sports teams leagues hobbies media reading "
    "sources preferences routines priorities recommendations required live "
    "cards agent directive HTML HTML only HTML-only no Markdown "
    "no code fence standalone HTML skill load_skill agent_skills_tool"
)
DAILY_BRIEFING_TRIGGERS = (
    "daily summary",
    "daily summaries",
    "daily briefing",
    "daily briefings",
    "daily brief",
    "daily summry",
)


class DaedalusAddMemoryConfig(FunctionBaseConfig, name="daedalus_add_memory"):
    """Add memory using the authenticated request identity."""

    description: str = Field(
        default="Store a memory for the authenticated user.",
        description="The description of this function's use for tool calling agents.",
    )
    memory: MemoryRef = Field(
        default=MemoryRef("saas_memory"),
        description="Configured memory client instance.",
    )


class DaedalusGetMemoryConfig(FunctionBaseConfig, name="daedalus_get_memory"):
    """Search memory using the authenticated request identity."""

    description: str = Field(
        default="Retrieve memories for the authenticated user.",
        description="The description of this function's use for tool calling agents.",
    )
    memory: MemoryRef = Field(
        default=MemoryRef("saas_memory"),
        description="Configured memory client instance.",
    )
    top_k: int = Field(
        default=5,
        ge=1,
        le=50,
        description="Default maximum number of memories to return.",
    )


class AddMemoryInput(BaseModel):
    """LLM-facing add-memory input. User identity is intentionally absent."""

    model_config = ConfigDict(extra="ignore")

    memory: str = Field(description="Single declarative memory sentence to store.")
    tags: list[str] = Field(default_factory=list, description="Optional memory tags.")
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Optional memory metadata.",
    )
    key_value_pairs: dict[str, Any] | None = Field(
        default=None,
        description="Optional structured key/value metadata.",
    )


class GetMemoryInput(BaseModel):
    """LLM-facing memory-search input. User identity is intentionally absent."""

    model_config = ConfigDict(extra="ignore")

    query: str = Field(description="Search query for retrieving relevant memories.")
    top_k: int | None = Field(
        default=None,
        ge=1,
        le=50,
        description="Maximum number of memories to return.",
    )


def _merge_metadata(
    metadata: dict[str, Any],
    key_value_pairs: dict[str, Any] | None,
) -> dict[str, Any]:
    merged = dict(metadata or {})
    if not key_value_pairs:
        return merged

    existing = merged.get("key_value_pairs")
    if isinstance(existing, dict):
        merged["key_value_pairs"] = {**existing, **key_value_pairs}
    else:
        merged["key_value_pairs"] = dict(key_value_pairs)
    return merged


def _memory_to_jsonable(memory: Any) -> Any:
    if hasattr(memory, "model_dump"):
        return memory.model_dump(mode="json")
    if hasattr(memory, "dict"):
        return memory.dict()
    if isinstance(memory, dict):
        return memory
    if hasattr(memory, "__dict__"):
        return dict(memory.__dict__)
    return str(memory)


def _is_daily_briefing_query(query: str) -> bool:
    normalized = " ".join(query.lower().split())
    return any(trigger in normalized for trigger in DAILY_BRIEFING_TRIGGERS)


def _expand_memory_search(query: str, top_k: int) -> tuple[str, int]:
    if not _is_daily_briefing_query(query):
        return query, top_k

    return (
        f"{query} {DAILY_BRIEFING_QUERY_TERMS}",
        max(top_k, DAILY_BRIEFING_MIN_TOP_K),
    )


@register_function(config_type=DaedalusAddMemoryConfig)
async def daedalus_add_memory(config: DaedalusAddMemoryConfig, builder: Builder):
    """Register a memory-add tool that ignores model-supplied user identity."""

    from nat.memory.models import MemoryItem

    memory_editor = await builder.get_memory_client(config.memory)

    async def _arun(input_data: AddMemoryInput) -> str:
        memory_text = (input_data.memory or "").strip()
        if not memory_text:
            return "Error: memory is required."

        try:
            user_id = authenticated_user_id_from_context()
        except Exception as exc:
            logger.warning("Denied add_memory without trusted identity: %s", exc)
            return f"Error: add_memory denied: {exc}."

        item = MemoryItem(
            conversation=[{"role": "user", "content": memory_text}],
            user_id=user_id,
            memory=memory_text,
            tags=input_data.tags,
            metadata=_merge_metadata(input_data.metadata, input_data.key_value_pairs),
        )

        reservation = None
        execution_id = execution_id_from_context_or_none()
        if execution_id:
            from nat_helpers.idempotency import reserve_operation

            try:
                reservation = await reserve_operation(
                    user_id=user_id,
                    execution_id=execution_id,
                    operation="add_memory",
                    arguments={
                        "memory": memory_text,
                        "tags": input_data.tags,
                        "metadata": item.metadata,
                    },
                )
            except Exception as exc:
                logger.exception("Unable to reserve autonomous memory write")
                return f"Error: add_memory idempotency unavailable: {exc}."
            if not reservation.acquired:
                if reservation.state == "completed" and reservation.stored_result:
                    return reservation.stored_result
                return (
                    "Memory write wasn't repeated because the same autonomous "
                    "operation has an existing or ambiguous execution record."
                )

        try:
            await memory_editor.add_items([item])
        except Exception as exc:
            logger.exception("Error adding memory")
            return f"Error adding memory: {exc}"

        result = (
            "Memory added successfully. You can continue. Please respond to the user."
        )
        if reservation is not None:
            from nat_helpers.idempotency import complete_operation

            if not await complete_operation(reservation, result):
                logger.error(
                    "Memory write succeeded but its idempotency result couldn't be finalized"
                )
        return result

    yield FunctionInfo.from_fn(
        _arun,
        description=config.description,
        input_schema=AddMemoryInput,
    )


@register_function(config_type=DaedalusGetMemoryConfig)
async def daedalus_get_memory(config: DaedalusGetMemoryConfig, builder: Builder):
    """Register a memory-search tool that ignores model-supplied user identity."""

    memory_editor = await builder.get_memory_client(config.memory)

    async def _arun(input_data: GetMemoryInput) -> str:
        query = (input_data.query or "").strip()
        if not query:
            return "Memories as a JSON: \n[]"

        try:
            user_id = authenticated_user_id_from_context()
        except Exception as exc:
            logger.warning("Denied get_memory without trusted identity: %s", exc)
            return f"Error: get_memory denied: {exc}."

        search_query, top_k = _expand_memory_search(
            query,
            input_data.top_k or config.top_k,
        )

        try:
            memories = await memory_editor.search(
                query=search_query,
                top_k=top_k,
                user_id=user_id,
            )
        except Exception as exc:
            logger.exception("Error retrieving memory")
            return f"Error retrieving memory: {exc}"

        memory_payload = [_memory_to_jsonable(memory) for memory in memories]
        return f"Memories as a JSON: \n{json.dumps(memory_payload)}"

    yield FunctionInfo.from_fn(
        _arun,
        description=config.description,
        input_schema=GetMemoryInput,
    )
