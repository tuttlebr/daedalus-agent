"""Fireworks OpenAI-compatible LLM with request-scoped cache headers."""

from __future__ import annotations

import os
from typing import Literal

from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.llm import LLMProviderInfo
from nat.cli.register_workflow import register_llm_client, register_llm_provider
from nat.data_models.common import get_secret_value
from nat.data_models.llm import APITypeEnum
from nat.llm.openai_llm import OpenAIModelConfig
from nat.llm.utils.hooks import _create_metadata_injection_client
from nat_helpers.fireworks_prompt_cache import FireworksPromptCacheHeaderHook
from pydantic import Field


class DaedalusFireworksModelConfig(
    OpenAIModelConfig,
    name="daedalus_fireworks",
):
    """OpenAI-compatible Fireworks configuration with dynamic cache routing."""

    session_affinity_scope: Literal["user", "conversation"] = Field(
        default="conversation",
        description="Build Fireworks affinity per authenticated user or conversation.",
    )
    prompt_cache_isolation: bool = Field(
        default=True,
        description="Isolate prompt-cache entries between authenticated users.",
    )


@register_llm_provider(config_type=DaedalusFireworksModelConfig)
async def daedalus_fireworks_provider(
    config: DaedalusFireworksModelConfig,
    _builder: Builder,
):
    yield LLMProviderInfo(
        config=config,
        description=(
            "A Fireworks OpenAI-compatible model with request-scoped prompt-cache "
            "routing headers."
        ),
    )


@register_llm_client(
    config_type=DaedalusFireworksModelConfig,
    wrapper_type=LLMFrameworkEnum.LANGCHAIN,
)
async def daedalus_fireworks_langchain_client(
    config: DaedalusFireworksModelConfig,
    _builder: Builder,
):
    """Build NAT's pinned ChatOpenAI client with an HTTP-level header hook."""
    from langchain_openai import ChatOpenAI
    from nat.plugins.langchain.llm import _patch_llm_based_on_config

    async with _create_metadata_injection_client(config) as http_async_client:
        http_async_client.event_hooks.setdefault("request", []).append(
            FireworksPromptCacheHeaderHook(
                session_affinity_scope=config.session_affinity_scope,
                prompt_cache_isolation=config.prompt_cache_isolation,
            )
        )

        config_dict = config.model_dump(
            exclude={
                "type",
                "thinking",
                "api_type",
                "api_key",
                "base_url",
                "verify_ssl",
                "session_affinity_scope",
                "prompt_cache_isolation",
            },
            by_alias=True,
            exclude_none=True,
            exclude_unset=True,
        )
        if api_key := get_secret_value(config.api_key) or os.getenv("OPENAI_API_KEY"):
            config_dict["api_key"] = api_key
        if base_url := config.base_url or os.getenv("OPENAI_BASE_URL"):
            config_dict["base_url"] = base_url

        client_kwargs = {
            "http_async_client": http_async_client,
            "stream_usage": True,
            **config_dict,
        }
        if config.api_type == APITypeEnum.RESPONSES:
            client_kwargs.update(
                use_responses_api=True,
                use_previous_response_id=True,
            )

        client = ChatOpenAI(**client_kwargs)
        if "http_async_client" in client.model_kwargs:
            del client.model_kwargs["http_async_client"]

        yield _patch_llm_based_on_config(client, config)
