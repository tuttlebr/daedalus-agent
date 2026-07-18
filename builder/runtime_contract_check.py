#!/usr/bin/env python3
"""Build-time checks against the exact NAT packages installed in the image."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import secrets
from importlib.metadata import version
from types import SimpleNamespace

import mcp_patches
from entrypoint import _patch_request_metadata_redaction
from packaging.version import Version
from pydantic import BaseModel

EXPECTED_NAT_VERSION = "1.7.0"
EXPECTED_NV_INGEST_VERSION = "26.3.0"

SECURITY_DEPENDENCY_RANGES = {
    "cryptography": (Version("48.0.1"), Version("49")),
    "fastfeedparser": (Version("0.5.10"), Version("0.6")),
    "pillow": (Version("12.2"), Version("13")),
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

    for distribution, (minimum, maximum) in SECURITY_DEPENDENCY_RANGES.items():
        installed = Version(version(distribution))
        if not minimum <= installed < maximum:
            raise RuntimeError(
                f"{distribution} {installed} is outside the security-tested "
                f"range >={minimum},<{maximum}"
            )

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

    # NAT 1.7 exposes runner_class as its supported application-composition
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
    from nat.cli.type_registry import GlobalTypeRegistry
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

    # OAuth-backed MCP groups must discover and cache their schemas inside a
    # real authenticated user's workflow. Prove the per-user tool-calling
    # registration exists in the pinned NAT registry and carries explicit API
    # schemas so the shared application can start without building it.
    from nat_helpers.per_user_tool_calling import (
        DaedalusPerUserToolCallAgentWorkflowConfig,
    )

    per_user_agent = GlobalTypeRegistry.get().get_function(
        DaedalusPerUserToolCallAgentWorkflowConfig
    )
    if not per_user_agent.is_per_user:
        raise RuntimeError("Daedalus tool-calling workflow isn't per-user")
    if (
        per_user_agent.per_user_function_input_schema is None
        or per_user_agent.per_user_function_single_output_schema is None
        or per_user_agent.per_user_function_streaming_output_schema is None
    ):
        raise RuntimeError("Per-user tool-calling API schemas aren't registered")

    from nat.plugins.mcp.client.client_base import (
        MCPStreamableHTTPClient,
        MCPToolClient,
    )

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
