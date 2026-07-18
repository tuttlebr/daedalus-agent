"""One bounded, product-routed capability for public NVIDIA documentation."""

import asyncio
import json
import logging
from datetime import timedelta
from typing import Literal

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

NvidiaDocsProduct = Literal[
    "dynamo",
    "openshell",
    "aistore",
    "aiperf",
    "nvcf",
    "dsx",
]

NVIDIA_DOCS_ENDPOINTS: dict[str, str] = {
    "dynamo": "https://docs.nvidia.com/dynamo/_mcp/server",
    "openshell": "https://docs.nvidia.com/openshell/_mcp/server",
    "aistore": "https://docs.nvidia.com/aistore/_mcp/server",
    "aiperf": "https://docs.nvidia.com/aiperf/_mcp/server",
    "nvcf": "https://docs.nvidia.com/nvcf/_mcp/server",
    "dsx": "https://docs.nvidia.com/dsx/_mcp/server",
}


class NvidiaDocsConfig(FunctionBaseConfig, name="nvidia_docs"):
    """Configure the routed NVIDIA documentation search."""

    description: str = Field(
        default=(
            "Search official NVIDIA Dynamo, OpenShell, AIStore, AIPerf, "
            "NVCF, or DSX documentation."
        )
    )
    timeout: float = Field(default=60.0, gt=0, le=120)


class NvidiaDocsInput(BaseModel):
    """The endpoint is selected from a closed product set, never model-supplied."""

    model_config = ConfigDict(extra="forbid")

    product: NvidiaDocsProduct = Field(
        description="NVIDIA documentation product to search."
    )
    query: str = Field(min_length=1, max_length=2000)


def _build_mcp_client(endpoint: str, timeout: float):
    from nat.plugins.mcp.client.client_base import MCPStreamableHTTPClient

    call_timeout = timedelta(seconds=timeout)
    return MCPStreamableHTTPClient(
        endpoint,
        tool_call_timeout=call_timeout,
        auth_flow_timeout=call_timeout,
        reconnect_enabled=False,
    )


def _result_payload(result) -> dict:
    if hasattr(result, "model_dump"):
        return result.model_dump(mode="json")
    if isinstance(result, dict):
        return result
    return {"content": str(result)}


async def search_nvidia_docs(
    product: NvidiaDocsProduct,
    query: str,
    *,
    timeout: float,
) -> str:
    """Call one fixed public docs endpoint within one end-to-end deadline."""
    normalized_query = query.strip()
    if not normalized_query:
        return json.dumps({"error": "query_required", "product": product})

    endpoint = NVIDIA_DOCS_ENDPOINTS[product]
    try:
        async with asyncio.timeout(timeout):
            async with _build_mcp_client(endpoint, timeout) as client:
                # This repository-owned function exposes only the fixed,
                # read-only method and fixed endpoint selected above.
                result = await client.call_tool(
                    "searchDocs",
                    {"query": normalized_query},
                )
    except TimeoutError:
        logger.warning("NVIDIA docs search timed out: product=%s", product)
        return json.dumps({"error": "docs_timeout", "product": product})
    except Exception as exc:
        logger.warning(
            "NVIDIA docs search failed: product=%s error_class=%s",
            product,
            type(exc).__name__,
        )
        return json.dumps(
            {
                "error": "docs_unavailable",
                "error_class": type(exc).__name__,
                "product": product,
            }
        )

    payload = _result_payload(result)
    return json.dumps(
        {
            "endpoint": endpoint,
            "product": product,
            "result": payload,
        },
        ensure_ascii=False,
    )


def _build_docs_runner(timeout: float):
    # NAT 1.7 reflects this callable while generating its streaming adapter.
    # Keep these as concrete runtime annotations; postponed annotations turn
    # NvidiaDocsInput into an unresolved forward reference in that adapter.
    async def _arun(input_data: NvidiaDocsInput) -> str:
        return await search_nvidia_docs(
            input_data.product,
            input_data.query,
            timeout=timeout,
        )

    return _arun


@register_function(config_type=NvidiaDocsConfig)
async def nvidia_docs(config: NvidiaDocsConfig, _builder: Builder):
    yield FunctionInfo.from_fn(
        _build_docs_runner(config.timeout),
        description=config.description,
        input_schema=NvidiaDocsInput,
    )
