"""Role-aware embeddings client for vLLM pooling models."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

import httpx
from nat.builder.embedder import EmbedderProviderInfo
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.cli.register_workflow import (
    register_embedder_client,
    register_embedder_provider,
)
from nat.data_models.common import get_secret_value
from nat.data_models.embedder import EmbedderBaseConfig
from pydantic import AliasChoices, ConfigDict, Field, SecretStr

EmbeddingRole = Literal["query", "document"]


def _embeddings_endpoint(base_url: str) -> str:
    """Normalize a vLLM server or API base URL to `/v1/embeddings`."""
    normalized = base_url.rstrip("/")
    if normalized.endswith("/embeddings"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/embeddings"
    return f"{normalized}/v1/embeddings"


def _bounded_response_body(response: httpx.Response, limit: int = 1000) -> str:
    body = response.text.strip().replace("\n", " ")
    return body[:limit]


class DaedalusVLLMEmbeddings:
    """Minimal LangChain-compatible adapter for role-aware vLLM embeddings.

    Nemotron retrieval models use their chat template to distinguish query and
    document embeddings. vLLM exposes that contract through the `messages`
    variant of `/v1/embeddings`; NIM-only `input_type` and `truncate` fields are
    deliberately not sent.
    """

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str | None = None,
        timeout_seconds: float = 60.0,
        truncate_prompt_tokens: int | None = None,
        max_concurrency: int = 8,
        verify_ssl: bool = True,
        sync_client: httpx.Client | None = None,
        async_client: httpx.AsyncClient | None = None,
    ) -> None:
        if not base_url.strip():
            raise ValueError("base_url must not be blank")
        if not model.strip():
            raise ValueError("model must not be blank")
        if truncate_prompt_tokens is not None and truncate_prompt_tokens < 1:
            raise ValueError("truncate_prompt_tokens must be positive when set")
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")

        self._endpoint = _embeddings_endpoint(base_url)
        self._model = model
        self._truncate_prompt_tokens = truncate_prompt_tokens
        self._max_concurrency = max_concurrency

        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        self._sync_client = sync_client or httpx.Client(
            headers=headers,
            timeout=timeout_seconds,
            verify=verify_ssl,
        )
        self._async_client = async_client or httpx.AsyncClient(
            headers=headers,
            timeout=timeout_seconds,
            verify=verify_ssl,
        )

    def _request_payload(self, text: str, role: EmbeddingRole) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {
                    "role": role,
                    "content": [{"type": "text", "text": text}],
                }
            ],
        }
        if self._truncate_prompt_tokens is not None:
            payload["truncate_prompt_tokens"] = self._truncate_prompt_tokens
        return payload

    @staticmethod
    def _extract_embedding(response: httpx.Response) -> list[float]:
        if response.is_error:
            body = _bounded_response_body(response)
            suffix = f": {body}" if body else ""
            raise RuntimeError(
                f"vLLM embeddings request failed with HTTP "
                f"{response.status_code}{suffix}"
            )

        try:
            payload = response.json()
            data = payload["data"]
            if not isinstance(data, list) or len(data) != 1:
                raise ValueError("response must contain exactly one embedding")
            embedding = data[0]["embedding"]
            if not isinstance(embedding, list) or not embedding:
                raise ValueError("embedding must be a non-empty list")
            return [float(value) for value in embedding]
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError("vLLM returned an invalid embeddings response") from exc

    def _embed_one(self, text: str, role: EmbeddingRole) -> list[float]:
        response = self._sync_client.post(
            self._endpoint,
            json=self._request_payload(text, role),
        )
        return self._extract_embedding(response)

    async def _aembed_one(self, text: str, role: EmbeddingRole) -> list[float]:
        response = await self._async_client.post(
            self._endpoint,
            json=self._request_payload(text, role),
        )
        return self._extract_embedding(response)

    def embed_query(self, text: str) -> list[float]:
        return self._embed_one(text, "query")

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text, "document") for text in texts]

    async def aembed_query(self, text: str) -> list[float]:
        return await self._aembed_one(text, "query")

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        semaphore = asyncio.Semaphore(self._max_concurrency)

        async def embed(text: str) -> list[float]:
            async with semaphore:
                return await self._aembed_one(text, "document")

        return list(await asyncio.gather(*(embed(text) for text in texts)))

    async def aclose(self) -> None:
        self._sync_client.close()
        await self._async_client.aclose()


class DaedalusVLLMEmbedderConfig(
    EmbedderBaseConfig,
    name="daedalus_vllm",
):
    """Configuration for the role-aware vLLM embeddings provider."""

    model_config = ConfigDict(protected_namespaces=())

    api_key: SecretStr | None = Field(
        default=None,
        description="Optional bearer token for the vLLM server.",
    )
    base_url: str = Field(
        description="vLLM server URL, `/v1` base URL, or embeddings endpoint."
    )
    model_name: str = Field(
        validation_alias=AliasChoices("model_name", "model"),
        serialization_alias="model",
        description="Served vLLM embedding model name.",
    )
    timeout_seconds: float = Field(default=60.0, gt=0)
    truncate_prompt_tokens: int | None = Field(default=None, ge=1)
    max_concurrency: int = Field(default=8, ge=1, le=64)
    verify_ssl: bool = True


@register_embedder_provider(config_type=DaedalusVLLMEmbedderConfig)
async def daedalus_vllm_embedder_provider(
    config: DaedalusVLLMEmbedderConfig,
    _builder: Any,
):
    yield EmbedderProviderInfo(
        config=config,
        description="Role-aware vLLM embeddings provider for retrieval models.",
    )


@register_embedder_client(
    config_type=DaedalusVLLMEmbedderConfig,
    wrapper_type=LLMFrameworkEnum.LANGCHAIN,
)
async def daedalus_vllm_langchain_client(
    config: DaedalusVLLMEmbedderConfig,
    _builder: Any,
):
    client = DaedalusVLLMEmbeddings(
        api_key=get_secret_value(config.api_key),
        base_url=config.base_url,
        model=config.model_name,
        timeout_seconds=config.timeout_seconds,
        truncate_prompt_tokens=config.truncate_prompt_tokens,
        max_concurrency=config.max_concurrency,
        verify_ssl=config.verify_ssl,
    )
    try:
        yield client
    finally:
        await client.aclose()
