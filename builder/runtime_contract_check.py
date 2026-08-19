#!/usr/bin/env python3
"""Build-time checks against the exact NAT packages installed in the image."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import os
import secrets
import warnings
from importlib.metadata import version
from types import SimpleNamespace
from typing import Any

import mcp_patches
from entrypoint import _patch_request_metadata_redaction
from packaging.version import Version
from pydantic import BaseModel

EXPECTED_NAT_VERSION = "1.8.0"
EXPECTED_NV_INGEST_VERSION = "26.3.0"

SECURITY_DEPENDENCY_RANGES = {
    "aiohttp": (Version("3.14.3"), Version("4")),
    "cryptography": (Version("50.0.0"), Version("51")),
    "fastfeedparser": (Version("0.5.10"), Version("0.6")),
    "pillow": (Version("12.2"), Version("13")),
    "pyopenssl": (Version("26.4"), Version("27")),
    "starlette": (Version("1.3.1"), Version("2")),
    "urllib3": (Version("2.7"), Version("3")),
}


def main() -> None:
    for distribution in ("nvidia-nat-core", "nvidia-nat-mcp"):
        installed = version(distribution)
        if installed != EXPECTED_NAT_VERSION:
            raise RuntimeError(
                f"{distribution} {installed} does not match {EXPECTED_NAT_VERSION}"
            )

    # NAT owns the OpenAI timeout and retry contract. Keep this build-time
    # assertion beside the version pin so a future upgrade cannot silently
    # make the removed global constructor/httpx monkey patch necessary again.
    from nat.llm.openai_llm import OpenAIModelConfig

    native_openai_config = OpenAIModelConfig(
        model_name="runtime-contract",
        max_retries=3,
        request_timeout=60.0,
    )
    if (
        native_openai_config.max_retries != 3
        or native_openai_config.request_timeout != 60.0
    ):
        raise RuntimeError("NAT OpenAI timeout/retry fields are not available")

    for distribution, (minimum, maximum) in SECURITY_DEPENDENCY_RANGES.items():
        installed = Version(version(distribution))
        if not minimum <= installed < maximum:
            raise RuntimeError(
                f"{distribution} {installed} is outside the security-tested "
                f"range >={minimum},<{maximum}"
            )

    # Three upstream packages still cap cryptography below 50 even though the
    # fixed release preserves the RSA and TLS APIs this runtime uses. Exercise
    # each affected path before accepting those exact metadata conflicts.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from langchain_litellm import ChatLiteLLM
    from oci import Signer
    from oci._vendor.requests import Request
    from OpenSSL import SSL

    SSL.Context(SSL.TLS_CLIENT_METHOD)

    litellm_client = ChatLiteLLM(
        model="openai/runtime-contract",
        api_key="runtime-contract-key",
    )
    if litellm_client.model != "openai/runtime-contract":
        raise RuntimeError("LangChain LiteLLM client failed its cryptography 50 probe")

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    oci_signer = Signer(
        tenancy="ocid1.tenancy.oc1..runtime",
        user="ocid1.user.oc1..runtime",
        fingerprint="00:00:00:00",
        private_key_file_location=None,
        private_key_content=private_key_pem,
    )
    signed_request = oci_signer(
        Request("GET", "https://iaas.us-phoenix-1.oraclecloud.com/20160918").prepare()
    )
    if "rsa-sha256" not in signed_request.headers.get("authorization", ""):
        raise RuntimeError("OCI request signing failed with cryptography 50")

    for distribution in ("nv-ingest-api", "nv-ingest-client"):
        installed = version(distribution)
        if installed != EXPECTED_NV_INGEST_VERSION:
            raise RuntimeError(
                f"{distribution} {installed} does not match "
                f"{EXPECTED_NV_INGEST_VERSION}"
            )

    # The client imports API schemas while constructing each extraction task,
    # but its wheel metadata doesn't declare the API package. Exercise the real
    # paired packages and every file-type path the application exposes. Stub
    # only the live Milvus dimension probe so this remains a build-time check.
    import nat_nv_ingest.nat_nv_ingest as ingest_module
    from nat_nv_ingest.nat_nv_ingest import NvIngestFunctionConfig, _build_ingestor
    from nv_ingest_client.client import Ingestor

    original_dimension_check = ingest_module._validate_embedding_dimension
    ingest_module._validate_embedding_dimension = lambda *_args, **_kwargs: None
    try:
        for filename in (
            "contract.txt",
            "contract.pdf",
            "contract.docx",
            "contract.pptx",
        ):
            ingestor = _build_ingestor(
                nv_client=SimpleNamespace(),
                document_bytes=b"runtime contract",
                filename=filename,
                config=NvIngestFunctionConfig(enable_image_filter=False),
                collection_name="runtime_contract",
                chunk_size=256,
                chunk_overlap=32,
            )
            if not isinstance(ingestor, Ingestor):
                raise RuntimeError(
                    f"NV-Ingest didn't build a real chain for {filename}"
                )
    finally:
        ingest_module._validate_embedding_dimension = original_dimension_check

    # NAT serializes RequestAttributes into every tracing span. Prove the
    # installed ABI is patched before any internal or approval secret can be
    # exported to Phoenix (or exposed through request-attribute tools).
    from nat.runtime.user_metadata import RequestAttributes
    from starlette.datastructures import Headers

    _patch_request_metadata_redaction()
    request_attributes = RequestAttributes()
    request_attributes._request.headers = Headers(
        {
            "x-daedalus-internal-token": "runtime-internal-secret",
            "x-daedalus-approval-token": "runtime-approval-secret",
            "authorization": "Bearer runtime-auth-secret",
        }
    )
    serialized_attributes = json.dumps(request_attributes.to_dict())
    if "runtime-" in serialized_attributes or "headers" in serialized_attributes:
        raise RuntimeError("Sensitive request headers remain in NAT trace metadata")

    # NAT 1.8 exposes runner_class as its supported application-composition
    # hook. Prove the configured Daedalus worker remains a valid subclass so
    # route ownership never falls back to a process-wide FastAPI patch.
    from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import (
        FastApiFrontEndPluginWorker,
    )
    from nat_helpers.front_end import DaedalusFastApiFrontEndPluginWorker

    if not issubclass(DaedalusFastApiFrontEndPluginWorker, FastApiFrontEndPluginWorker):
        raise RuntimeError("Daedalus NAT runner no longer satisfies the pinned ABI")

    # Import the package registration module exactly as NAT's component loader
    # does, then prove the narrow Redis ACL/TLS provider is registered against
    # the installed runtime and still exposes every connection-security field.
    import nat_helpers.register  # noqa: F401
    from nat.builder.framework_enum import LLMFrameworkEnum
    from nat.cli.type_registry import GlobalTypeRegistry
    from nat_helpers.fireworks_llm import DaedalusFireworksModelConfig
    from nat_helpers.fireworks_prompt_cache import FireworksPromptCacheHeaderHook
    from nat_helpers.secure_redis_memory import DaedalusRedisMemoryClientConfig
    from nat_helpers.secure_redis_object_store import (
        DaedalusRedisObjectStoreClientConfig,
    )

    redis_fields = set(DaedalusRedisMemoryClientConfig.model_fields)
    required_redis_fields = {"username", "password", "ssl", "ssl_ca_certs"}
    if not required_redis_fields <= redis_fields:
        raise RuntimeError(
            "Daedalus Redis memory provider lost required ACL/TLS fields"
        )
    registered_redis = GlobalTypeRegistry.get().get_memory(
        DaedalusRedisMemoryClientConfig
    )
    if registered_redis.config_type is not DaedalusRedisMemoryClientConfig:
        raise RuntimeError("Daedalus Redis memory provider wasn't registered")

    oauth_store_fields = set(DaedalusRedisObjectStoreClientConfig.model_fields)
    if not {"redis_url", "bucket_name", "ttl"} <= oauth_store_fields:
        raise RuntimeError("Daedalus OAuth token store lost required fields")
    registered_oauth_store = GlobalTypeRegistry.get().get_object_store(
        DaedalusRedisObjectStoreClientConfig
    )
    if registered_oauth_store.config_type is not DaedalusRedisObjectStoreClientConfig:
        raise RuntimeError("Daedalus OAuth token store wasn't registered")

    registered_fireworks = GlobalTypeRegistry.get().get_llm_provider(
        DaedalusFireworksModelConfig
    )
    if registered_fireworks.config_type is not DaedalusFireworksModelConfig:
        raise RuntimeError("Daedalus Fireworks LLM provider wasn't registered")
    registered_fireworks_client = GlobalTypeRegistry.get().get_llm_client(
        DaedalusFireworksModelConfig,
        LLMFrameworkEnum.LANGCHAIN,
    )
    if registered_fireworks_client.config_type is not DaedalusFireworksModelConfig:
        raise RuntimeError("Daedalus Fireworks LangChain client wasn't registered")

    async def assert_fireworks_header_contract() -> None:
        config = DaedalusFireworksModelConfig(
            api_key="runtime-contract-key",
            api_type="responses",
            base_url="https://api.fireworks.ai/inference/v1",
            model_name="runtime-contract-model",
            prompt_cache_isolation=True,
            session_affinity_scope="conversation",
        )
        if config.use_previous_response_id:
            raise RuntimeError(
                "Daedalus Fireworks Responses client no longer defaults to full-history replay"
            )
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            async with registered_fireworks_client.build_fn(
                config,
                SimpleNamespace(),
            ) as llm:
                if not llm.use_responses_api:
                    raise RuntimeError("Fireworks client lost Responses API mode")
                if llm.use_previous_response_id:
                    raise RuntimeError(
                        "Fireworks client still enables unsupported response-ID continuation"
                    )
                if "extra_headers" in llm.model_kwargs:
                    raise RuntimeError(
                        "Fireworks headers leaked into LangChain model_kwargs"
                    )
                header_hooks = llm.http_async_client.event_hooks.get("request", [])
                hook = next(
                    (
                        candidate
                        for candidate in header_hooks
                        if isinstance(candidate, FireworksPromptCacheHeaderHook)
                    ),
                    None,
                )
                if hook is None:
                    raise RuntimeError("Fireworks request header hook wasn't installed")

                internal_token = secrets.token_hex(16)
                previous_internal_token = os.environ.get("DAEDALUS_INTERNAL_API_TOKEN")
                os.environ["DAEDALUS_INTERNAL_API_TOKEN"] = internal_token
                try:
                    metadata = RequestAttributes()
                    metadata._request.headers = Headers(
                        {
                            "x-daedalus-internal-token": internal_token,
                            "x-user-id": "runtime-user",
                            "x-conversation-id": "runtime-conversation",
                        }
                    )
                    import httpx
                    from nat.builder.context import Context

                    request = httpx.Request(
                        "POST",
                        "https://api.fireworks.ai/inference/v1/responses",
                    )
                    with Context.scope(
                        metadata=metadata,
                        user_id="runtime-user-session",
                    ):
                        await hook(request)
                    if not request.headers.get("x-session-affinity"):
                        raise RuntimeError("Fireworks session affinity wasn't injected")
                    if not request.headers.get("x-prompt-cache-isolation-key"):
                        raise RuntimeError("Fireworks user isolation wasn't injected")
                    if "runtime-" in " ".join(request.headers.values()):
                        raise RuntimeError("Raw Fireworks cache identity leaked")
                finally:
                    if previous_internal_token is None:
                        os.environ.pop("DAEDALUS_INTERNAL_API_TOKEN", None)
                    else:
                        os.environ["DAEDALUS_INTERNAL_API_TOKEN"] = (
                            previous_internal_token
                        )

            opt_in_config = config.model_copy(update={"use_previous_response_id": True})
            async with registered_fireworks_client.build_fn(
                opt_in_config,
                SimpleNamespace(),
            ) as opt_in_llm:
                if not opt_in_llm.use_previous_response_id:
                    raise RuntimeError(
                        "Fireworks client lost explicit response-ID continuation opt-in"
                    )

        if any(
            "extra_headers is not default parameter" in str(item.message)
            for item in captured
        ):
            raise RuntimeError("Fireworks client still emits extra_headers warning")

    asyncio.run(assert_fireworks_header_contract())

    # Retrieval models served by vLLM require query/document chat roles rather
    # than the NIM-only input_type field. Keep both the provider and its
    # LangChain client registration pinned to the installed NAT ABI.
    from nat_helpers.vllm_embeddings import DaedalusVLLMEmbedderConfig

    registered_embedder = GlobalTypeRegistry.get().get_embedder_provider(
        DaedalusVLLMEmbedderConfig
    )
    if registered_embedder.config_type is not DaedalusVLLMEmbedderConfig:
        raise RuntimeError("Daedalus vLLM embedder provider wasn't registered")
    registered_embedder_client = GlobalTypeRegistry.get().get_embedder_client(
        DaedalusVLLMEmbedderConfig,
        LLMFrameworkEnum.LANGCHAIN,
    )
    if registered_embedder_client.config_type is not DaedalusVLLMEmbedderConfig:
        raise RuntimeError("Daedalus vLLM LangChain embedder wasn't registered")

    # NAT dynamically derives a Pydantic tool schema for multi-argument
    # callables. Postponed annotations on a nested callable leave Literal as an
    # unresolved forward reference, which only fails on the first tool call.
    # Exercise the explicit schema with the real installed NAT runtime so the
    # backend image cannot ship that latent invocation failure again.
    from llm_sandbox.llm_sandbox_function import (
        LlmSandboxConfig,
        LlmSandboxInput,
        llm_sandbox_function,
    )

    async def assert_llm_sandbox_schema_contract() -> None:
        config = LlmSandboxConfig(
            api_key="runtime-contract-key",
            base_url=(
                "http://llm-sandbox-llm-sandbox.llm-sandbox.svc.cluster.local:8080"
            ),
        )
        if "api_key" in config.model_dump(mode="json", by_alias=True, round_trip=True):
            raise RuntimeError(
                "LLM sandbox API key leaked into NAT's serialized worker config"
            )
        async with llm_sandbox_function(config, SimpleNamespace()) as function_info:
            if function_info.input_schema is not LlmSandboxInput:
                raise RuntimeError("LLM sandbox lost its explicit tool input schema")
            if not function_info.input_schema.__pydantic_complete__:
                raise RuntimeError("LLM sandbox tool input schema is incomplete")
            schema = function_info.input_schema.model_json_schema()
            operation = schema.get("properties", {}).get("operation", {})
            if operation.get("enum") != [
                "list_commands",
                "execute",
                "write_file",
                "read_file",
                "publish_file",
            ]:
                raise RuntimeError("LLM sandbox operation schema is incorrect")

    asyncio.run(assert_llm_sandbox_schema_contract())

    # OAuth-backed MCP groups must discover and cache their schemas inside a
    # real authenticated user's workflow. Prove the per-user tool-calling
    # registration exists in the pinned NAT registry and carries explicit API
    # schemas so the shared application can start without building it.
    from nat_helpers.per_user_tool_calling import (
        DaedalusPerUserResponsesAPIAgentWorkflowConfig,
        _bind_responses_llm,
        _content_text,
    )

    if (
        _content_text(
            [
                {"type": "output_text", "text": "Responses "},
                {"type": "text", "text": "content"},
            ]
        )
        != "Responses content"
    ):
        raise RuntimeError("Responses API content-block normalization is broken")

    per_user_agent = GlobalTypeRegistry.get().get_function(
        DaedalusPerUserResponsesAPIAgentWorkflowConfig
    )
    if not per_user_agent.is_per_user:
        raise RuntimeError("Daedalus Responses API workflow isn't per-user")
    if (
        per_user_agent.per_user_function_input_schema is None
        or per_user_agent.per_user_function_single_output_schema is None
        or per_user_agent.per_user_function_streaming_output_schema is None
    ):
        raise RuntimeError("Per-user Responses API schemas aren't registered")

    response_fields = set(DaedalusPerUserResponsesAPIAgentWorkflowConfig.model_fields)
    if not {"instructions", "nat_tools", "parallel_tool_calls"} <= response_fields:
        raise RuntimeError("Daedalus Responses API workflow schema is incomplete")
    if {"system_prompt", "tool_names"} & response_fields:
        raise RuntimeError("Daedalus Responses API workflow retained Chat fields")

    # Prove the pinned LangChain bridge emits the raw Responses request shape:
    # top-level instructions, item input, flat functions with native optional
    # arguments, nested reasoning, and the Responses truncation field.
    from langchain_core.messages import HumanMessage
    from langchain_core.tools import StructuredTool
    from langchain_openai import ChatOpenAI

    def contract_lookup(
        query: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Look up a contract test value."""
        del metadata
        return query

    contract_tool = StructuredTool.from_function(contract_lookup)
    contract_llm = ChatOpenAI(
        model="gpt-5",
        api_key="runtime-contract-key",
        use_responses_api=True,
        reasoning={"effort": "high"},
        truncation="auto",
    )
    bound_contract_llm = _bind_responses_llm(
        contract_llm,
        tools=[contract_tool],
        parallel_tool_calls=True,
        instructions="Use the lookup tool.",
    )
    request_payload = bound_contract_llm.bound._get_request_payload(
        [HumanMessage(content="Find a value")],
        **bound_contract_llm.kwargs,
    )
    if request_payload.get("instructions") != "Use the lookup tool.":
        raise RuntimeError("Responses instructions were not serialized top-level")
    if request_payload.get("input", [{}])[0].get("type") != "message":
        raise RuntimeError("Responses input was not serialized as an item")
    request_tools = request_payload.get("tools", [])
    if (
        not request_tools
        or request_tools[0].get("type") != "function"
        or "function" in request_tools[0]
        or request_tools[0].get("strict") is True
    ):
        raise RuntimeError("Responses function schema is not flat and non-strict")
    parameters = request_tools[0].get("parameters", {})
    if parameters.get("required") != ["query"]:
        raise RuntimeError("Responses optional tool arguments became required")
    metadata_schema = parameters.get("properties", {}).get("metadata", {})
    metadata_object = next(
        (
            item
            for item in metadata_schema.get("anyOf", [])
            if item.get("type") == "object"
        ),
        {},
    )
    if metadata_object.get("additionalProperties") is not True:
        raise RuntimeError("Responses free-form tool objects became closed")
    if request_payload.get("parallel_tool_calls") is not True:
        raise RuntimeError("Responses parallel tool calls are disabled")
    if request_payload.get("reasoning") != {"effort": "high"}:
        raise RuntimeError("Responses reasoning schema was not preserved")
    if request_payload.get("truncation") != "auto":
        raise RuntimeError("Responses truncation schema was not preserved")

    from nat.front_ends.fastapi.auth_flow_handlers.http_flow_handler import (
        HTTPAuthenticationFlowHandler,
    )
    from nat.plugins.mcp.client.client_base import (
        AuthAdapter,
        MCPBaseClient,
        MCPStreamableHTTPClient,
        MCPToolClient,
    )
    from nat.runtime.session import SessionManager

    signature = inspect.signature(MCPToolClient.acall)
    if list(signature.parameters) != ["self", "tool_args"]:
        raise RuntimeError(f"Unexpected MCPToolClient.acall signature: {signature}")

    mcp_patches.patch()
    if not getattr(MCPToolClient.acall, "_daedalus_approval_gate", False):
        raise RuntimeError("MCP approval gate did not attach to acall")
    if not getattr(
        MCPStreamableHTTPClient.connect_to_server,
        "_daedalus_transport_wrapper",
        False,
    ):
        raise RuntimeError("MCP transport policy wrapper did not attach")
    if not getattr(
        AuthAdapter._get_auth_headers,
        "_daedalus_oauth_context_wrapper",
        False,
    ):
        raise RuntimeError("MCP OAuth retry wrapper did not attach")
    if not getattr(
        MCPBaseClient._get_tool_call_timeout,
        "_daedalus_interactive_auth_transport_timeout",
        False,
    ):
        raise RuntimeError("MCP interactive-auth transport timeout did not attach")
    if not getattr(
        SessionManager._get_or_create_per_user_builder,
        "_daedalus_mcp_builder_recovery",
        False,
    ):
        raise RuntimeError("Per-user MCP disconnected-builder recovery did not attach")
    if not getattr(
        HTTPAuthenticationFlowHandler.__init__,
        "_daedalus_mcp_oauth_timeout_wrapper",
        False,
    ):
        raise RuntimeError("MCP HTTP OAuth timeout wrapper did not attach")
    if not getattr(
        logging.getLogger("nat.plugins.mcp.client.client_base"),
        "_daedalus_mcp_auth_failure_levels",
        False,
    ):
        raise RuntimeError("MCP terminal auth failure log promotion did not attach")
    expected_oauth_timeout = float(
        os.getenv("DAEDALUS_MCP_OAUTH_TIMEOUT_SECONDS", "600")
    )
    if HTTPAuthenticationFlowHandler()._auth_timeout_seconds != expected_oauth_timeout:
        raise RuntimeError("MCP HTTP OAuth timeout did not use the configured value")

    # NAT's public server_name is transport-only. Verify the adapter binds two
    # real pinned StreamableHTTP clients by transport + URL without collision.
    mcp_patches._mcp_server_group_names.clear()
    mcp_patches._ambiguous_mcp_servers.clear()
    first = MCPStreamableHTTPClient("https://first.example.test/mcp")
    second = MCPStreamableHTTPClient("https://second.example.test/mcp")
    mcp_patches._register_mcp_group_identity(
        "k8s_mcp_server", SimpleNamespace(mcp_client=first)
    )
    mcp_patches._register_mcp_group_identity(
        "unifi_mcp_server", SimpleNamespace(mcp_client=second)
    )
    if mcp_patches._canonical_mcp_server_name(first) != "k8s_mcp_server":
        raise RuntimeError("First MCP endpoint did not retain its logical identity")
    if mcp_patches._canonical_mcp_server_name(second) != "unifi_mcp_server":
        raise RuntimeError("Second MCP endpoint collided with the first")

    dummy_client = SimpleNamespace(
        _tool_name="delete_resource",
        _parent_client=SimpleNamespace(server_name="runtime_contract_server"),
    )

    async def assert_unapproved_mutation_is_blocked() -> None:
        try:
            await MCPToolClient.acall(dummy_client, {"target": "runtime-contract"})
        except PermissionError as exc:
            if "execution credential" not in str(exc):
                raise RuntimeError(
                    "Mutation was denied for an unexpected reason"
                ) from exc
        else:
            raise RuntimeError("Unapproved MCP mutation was not denied")

    asyncio.run(assert_unapproved_mutation_is_blocked())

    # Exercise NAT's real model adapter, not only a direct acall. The adapter
    # validates/dumps the remote schema before invoking MCPToolClient.acall, so
    # a model-supplied synthetic approval_token is intentionally absent at the
    # authorization boundary and must not authorize the mutation.
    from nat.plugins.mcp.client.client_impl import mcp_per_user_tool_function

    class ContractInput(BaseModel):
        target: str

    class ContractTool:
        name = "delete_resource"
        description = "runtime contract mutation"
        input_schema = ContractInput

    class RuntimeMcpTool:
        _tool_name = "delete_resource"
        _parent_client = SimpleNamespace(server_name="runtime_contract_server")
        input_schema = ContractInput
        acall = MCPToolClient.acall

    class RuntimeClient:
        async def get_tool(self, _name):
            return RuntimeMcpTool()

    adapter = mcp_per_user_tool_function(ContractTool(), RuntimeClient())

    async def assert_adapter_cannot_smuggle_model_token() -> None:
        model_supplied_token = "model" + "-controlled"
        validated = ContractInput.model_validate(
            {"target": "runtime-contract", "approval_token": model_supplied_token}
        )
        result = await adapter.single_fn(validated)
        if "execution credential" not in result:
            raise RuntimeError(
                "Pinned NAT adapter did not deny the schema-filtered mutation"
            )

    asyncio.run(assert_adapter_cannot_smuggle_model_token())

    # Prove the complete supported path with the real NAT adapter and
    # MCPToolClient: a worker-only request header authorizes exactly one call,
    # schema defaults normalize identically on approval and execution, the
    # credential never reaches the remote MCP server, and NAT reconnect replay
    # is disabled only for the approved mutation.
    from mcp.types import CallToolResult, TextContent
    from nat.builder.context import Context
    from user_interaction import approval_tokens
    from user_interaction.approval_tokens import (
        ApprovalRequest,
        issue_approval_token,
        mcp_execution_receipt_key,
    )

    class FakeRedis:
        def __init__(self):
            self.values: dict[str, str] = {}

        def setex(self, key, _ttl, value):
            self.values[key] = value

        def getdel(self, key):
            return self.values.pop(key, None)

    class RuntimeParent:
        server_name = "streamable-http"
        _transport = "streamable-http"
        _url = "https://runtime-contract.example.test/mcp"
        _reconnect_enabled = True

        def __init__(self, *, outcome: str = "success"):
            self.outcome = outcome
            self.call_count = 0
            self.reconnect_state_during_call: list[bool] = []

        async def call_tool(self, _tool_name, tool_args):
            self.call_count += 1
            self.reconnect_state_during_call.append(self._reconnect_enabled)
            if "approval_token" in tool_args:
                raise RuntimeError("approval credential reached remote MCP arguments")
            if self.outcome == "timeout":
                # Simulate the replay decision in NAT's parent client. The
                # approval wrapper must make this branch unreachable.
                if self._reconnect_enabled:
                    self.call_count += 1
                raise TimeoutError("ambiguous runtime mutation outcome")
            return CallToolResult(
                content=[
                    TextContent(
                        type="text",
                        text=(
                            "runtime-rejected"
                            if self.outcome == "mcp-error"
                            else "runtime-approved"
                        ),
                    )
                ],
                isError=self.outcome == "mcp-error",
            )

    runtime_schema = {
        "type": "object",
        "properties": {
            "target": {"type": "string"},
            "propagation_policy": {
                "type": "string",
                "default": "Foreground",
            },
        },
        "required": ["target"],
    }

    async def assert_approved_adapter_contract() -> None:
        from nat.plugins.mcp.client.client_base import MCPToolClient

        fake_redis = FakeRedis()
        original_make_client = approval_tokens.make_redis_client
        approval_tokens.make_redis_client = lambda _url=None: fake_redis
        previous_internal_token = os.environ.get("DAEDALUS_INTERNAL_API_TOKEN")
        runtime_internal_token = secrets.token_urlsafe(24)
        os.environ["DAEDALUS_INTERNAL_API_TOKEN"] = runtime_internal_token
        try:
            for suffix in ("success", "mcp-error", "timeout"):
                parent = RuntimeParent(outcome=suffix)
                parent._url = f"https://runtime-{suffix}.example.test/mcp"
                mcp_patches._register_mcp_group_identity(
                    "runtime_contract_server",
                    SimpleNamespace(mcp_client=parent),
                )
                runtime_tool = MCPToolClient(
                    object(),
                    parent,
                    "delete_resource",
                    "runtime contract mutation",
                    runtime_schema,
                )

                class RuntimeClientWithTool:
                    async def get_tool(self, _name):
                        return runtime_tool

                runtime_adapter = mcp_per_user_tool_function(
                    SimpleNamespace(
                        name="delete_resource",
                        description="runtime contract mutation",
                        input_schema=runtime_tool.input_schema,
                    ),
                    RuntimeClientWithTool(),
                )
                approved_arguments = json.dumps(
                    {"target": f"runtime-{suffix}"},
                    sort_keys=True,
                    separators=(",", ":"),
                )
                approved_hash = hashlib.sha256(
                    approved_arguments.encode("utf-8")
                ).hexdigest()
                token = issue_approval_token(
                    fake_redis,
                    ApprovalRequest(
                        user_id="runtime-user",
                        action_type="mcp_mutation",
                        target=f"runtime-{suffix}",
                        server_name="runtime_contract_server",
                        tool_name="delete_resource",
                        arguments_sha256=approved_hash,
                        canonical_arguments=approved_arguments,
                    ),
                )
                metadata = RequestAttributes()
                metadata._request.headers = Headers(
                    {
                        "x-user-id": "runtime-user",
                        "x-daedalus-internal-token": runtime_internal_token,
                        "x-daedalus-approval-token": token,
                    }
                )
                validated = runtime_tool.input_schema.model_validate(
                    {"target": f"runtime-{suffix}"}
                )
                with Context.scope(metadata=metadata):
                    result = await runtime_adapter.single_fn(validated)

                receipt_key = mcp_execution_receipt_key(token)
                if suffix == "timeout":
                    if "mcp_tool_failed" not in result:
                        raise RuntimeError("Approved timeout was not reported safely")
                    if receipt_key in fake_redis.values:
                        raise RuntimeError("Approved timeout emitted a success receipt")
                elif suffix == "mcp-error":
                    if "mcp_tool_failed" not in result or "runtime-rejected" in result:
                        raise RuntimeError("Approved MCP error was not reported safely")
                    if receipt_key in fake_redis.values:
                        raise RuntimeError(
                            "Approved MCP error emitted a success receipt"
                        )
                elif result != "runtime-approved":
                    raise RuntimeError(f"Approved MCP result was unexpected: {result}")
                else:
                    raw_receipt = fake_redis.getdel(receipt_key)
                    if not raw_receipt:
                        raise RuntimeError("Approved MCP success emitted no receipt")
                    receipt = json.loads(raw_receipt)
                    if receipt != {
                        "action_type": "mcp_mutation",
                        "arguments_sha256": approved_hash,
                        "created_at": receipt["created_at"],
                        "server_name": "runtime_contract_server",
                        "tool_name": "delete_resource",
                        "user_id": "runtime-user",
                    }:
                        raise RuntimeError("Approved MCP receipt binding was incorrect")
                if parent.call_count != 1:
                    raise RuntimeError("Approved mutation was replayed")
                if parent.reconnect_state_during_call != [False]:
                    raise RuntimeError("Mutation replay remained enabled during call")
                if parent._reconnect_enabled is not True:
                    raise RuntimeError("MCP reconnect policy was not restored")

                with Context.scope(metadata=metadata):
                    replay = await runtime_adapter.single_fn(validated)
                if "already used" not in replay or parent.call_count != 1:
                    raise RuntimeError("Approval credential was not exactly-once")
        finally:
            approval_tokens.make_redis_client = original_make_client
            if previous_internal_token is None:
                os.environ.pop("DAEDALUS_INTERNAL_API_TOKEN", None)
            else:
                os.environ["DAEDALUS_INTERNAL_API_TOKEN"] = previous_internal_token

    asyncio.run(assert_approved_adapter_contract())


if __name__ == "__main__":
    main()
