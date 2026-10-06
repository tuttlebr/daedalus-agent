"""Typed, explicitly registered Python tools used by the Rust agent.

Factories own the lifecycle of network clients. This module does not execute
an agent, build a graph, load plugins, or import NeMo Agent Toolkit.
"""

from __future__ import annotations

import asyncio
import inspect
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, ClassVar, get_type_hints

from pydantic import BaseModel, ConfigDict, create_model


class ToolConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    tool_type: ClassVar[str] = ""
    description: str | None = None
    verbose: bool = False

    def __init_subclass__(cls, *, name: str = "", **kwargs):
        super().__init_subclass__(**kwargs)
        cls.tool_type = name


class LLMFramework(StrEnum):
    LANGCHAIN = "LANGCHAIN"
    OPENAI = "OPENAI"


@dataclass
class ToolDefinition:
    fn: Any
    input_schema: type[BaseModel]
    description: str
    model_parameter: str | None = None

    @classmethod
    def from_fn(cls, fn, *, input_schema=None, description=None):
        signature = inspect.signature(fn)
        hints = get_type_hints(fn, include_extras=True)
        parameters = list(signature.parameters.values())
        model_parameter = None
        if len(parameters) == 1:
            annotation = hints.get(parameters[0].name)
            if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                input_schema = input_schema or annotation
                model_parameter = parameters[0].name
        if input_schema is None:
            fields = {}
            for parameter in parameters:
                if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
                    raise TypeError("Tools must declare their input schema")
                fields[parameter.name] = (
                    hints.get(parameter.name, Any),
                    ... if parameter.default is parameter.empty else parameter.default,
                )
            input_schema = create_model(
                f"{fn.__name__}Input", __config__=ConfigDict(extra="forbid"), **fields
            )
        return cls(
            fn, input_schema, description or inspect.getdoc(fn) or "", model_parameter
        )

    async def ainvoke(self, arguments: dict | BaseModel):
        value = self.input_schema.model_validate(arguments)
        # Preserve the validated Python values and nested models. Serializing
        # them here would turn dates, enums, and nested tool inputs into dicts.
        kwargs = (
            {self.model_parameter: value}
            if self.model_parameter
            else {name: getattr(value, name) for name in type(value).model_fields}
        )
        if inspect.iscoroutinefunction(self.fn):
            return await self.fn(**kwargs)
        return await asyncio.to_thread(self.fn, **kwargs)

    def schema(self, name: str) -> dict:
        return {
            "name": name,
            "description": self.description,
            "parameters": self.input_schema.model_json_schema(),
        }


_FACTORIES: dict[str, tuple[type[ToolConfig], Any]] = {}


def register_tool(*, config_type):
    def decorate(factory):
        name = config_type.tool_type
        previous = _FACTORIES.get(name)
        same_factory = previous and (
            previous[1].__module__,
            previous[1].__qualname__,
        ) == (factory.__module__, factory.__qualname__)
        if not name or (previous and not same_factory):
            raise ValueError(f"Duplicate or unnamed tool factory: {name}")
        _FACTORIES[name] = (config_type, factory)
        return factory

    return decorate


class ToolRegistry:
    """Lazily initialize configured tools and close their clients on shutdown."""

    def __init__(self, config: dict):
        self.config = config
        self._stack = AsyncExitStack()
        self._tools: dict[str, ToolDefinition] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._llms: dict[tuple[str, str], Any] = {}
        self._embedders: dict[str, Any] = {}

    async def close(self):
        await self._stack.aclose()

    async def get_function(self, name: str) -> ToolDefinition:
        async with self._locks.setdefault(name, asyncio.Lock()):
            if name not in self._tools:
                raw = dict(self.config.get("functions", {})[name])
                kind = raw.pop("_type")
                config_type, factory = _FACTORIES[kind]
                tool = await self._stack.enter_async_context(
                    asynccontextmanager(factory)(config_type.model_validate(raw), self)
                )
                if not isinstance(tool, ToolDefinition):
                    raise TypeError(
                        f"Tool factory {kind} returned an invalid definition"
                    )
                self._tools[name] = tool
            return self._tools[name]

    def get_function_config(self, name: str):
        raw = dict(self.config.get("functions", {})[name])
        config_type, _ = _FACTORIES[raw.pop("_type")]
        return config_type.model_validate(raw)

    async def get_llm(self, name: str, *, wrapper_type=LLMFramework.LANGCHAIN):
        """LLM clients for leaf tools such as source verification, never agents."""
        key = (name, str(wrapper_type))
        if key not in self._llms:
            import httpx
            from langchain_openai import ChatOpenAI

            config = self.config["llms"][name]
            if wrapper_type != LLMFramework.LANGCHAIN:
                raise ValueError("Python helper tools require the LANGCHAIN wrapper")
            sync_http = httpx.Client()
            async_http = httpx.AsyncClient()
            self._stack.callback(sync_http.close)
            self._stack.push_async_callback(async_http.aclose)
            self._llms[key] = ChatOpenAI(
                http_client=sync_http,
                http_async_client=async_http,
                model=config["model_name"],
                api_key=config.get("api_key") or "unused",
                base_url=config.get("base_url"),
                timeout=float(config.get("request_timeout", 60)),
                max_retries=int(config.get("max_retries", 3)),
                use_responses_api=config.get("api_type") == "responses",
                use_previous_response_id=False,
            )
        return self._llms[key]

    async def get_embedder(self, name: str, *, wrapper_type=None):
        if name not in self._embedders:
            from nat_helpers.vllm_embeddings import (
                DaedalusVLLMEmbedderConfig,
                create_embeddings,
            )

            raw = dict(self.config["embedders"][name])
            raw.pop("_type", None)
            client = create_embeddings(DaedalusVLLMEmbedderConfig.model_validate(raw))
            self._embedders[name] = client
            self._stack.push_async_callback(client.aclose)
        return self._embedders[name]


def load_tool_factories():
    # A fixed application-owned catalog. Importing an installed Python package
    # cannot silently grant it tool access.
    import importlib

    for module in (
        "agent_skills.agent_skills_function",
        "content_distiller.content_distiller_function",
        "llm_sandbox.llm_sandbox_function",
        "nat_helpers.briefing_renderer",
        "nat_helpers.daedalus_memory_tools",
        "nat_helpers.nvidia_docs",
        "nat_helpers.tool_output_retriever",
        "nat_nv_ingest.nat_nv_ingest",
        "perplexity_search.perplexity_search_function",
        "rss_feed.rss_feed_function",
        "smart_milvus.register",
        "source_verifier.source_verifier_function",
        "user_interaction.user_interaction_function",
        "visual_media.visual_media_function",
        "webscrape.nws_weather_function",
        "webscrape.webscrape_function",
        "daedalus_runtime.datetime_tool",
    ):
        importlib.import_module(module)
