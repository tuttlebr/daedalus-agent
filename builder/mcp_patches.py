"""
Patch NAT's MCP StreamableHTTP client to add bounded startup behavior,
daedalus-specific logging, and approval-gate behavior around MCP tool calls.

Problem 1: NAT 1.7.0 initializes every MCP function group serially during
application startup. Repeated connection attempts can keep the ASGI lifespan
from completing until Kubernetes kills the pod, especially when DNS or an MCP
endpoint is degraded.

Problem 2: NAT's MCPToolClient logs "tool call failed:" but often
swallows the actual exception details, making debugging impossible.

Fix 1: Keep the upstream 30 s connect allowance for runtime calls, where DNS
and interactive authentication can legitimately take longer, but bound each
MCP function group's startup initialization separately in Fix 5. Read/write/
pool timeouts still inherit upstream's max(MCP_DEFAULT_SSE_READ_TIMEOUT,
tool_call_timeout, auth_flow_timeout).

Fix 2: Monkey-patch MCPToolClient to add verbose error logging with
full tracebacks around tool call execution.

Problem 4: The MCP SDK's terminate_session() catches Exception but not
CancelledError (a BaseException).  During shutdown, the HTTP DELETE it
sends raises CancelledError which escapes through __aexit__, producing
a noisy traceback in the framework's lifespan handler.

Fix 4: Track whether the session yield has returned (teardown phase)
and suppress CancelledError / cancel-scope RuntimeError that occur
during cleanup, since the session was already used successfully.

Problem 5: NAT's WorkflowBuilder.populate_builder() treats any component
initialization failure as fatal.  One unreachable MCP server kills the
entire startup, blocking all remaining components (LLMs, retrievers,
memory, functions, workflow) from initializing.

Fix 5: Monkey-patch WorkflowBuilder.add_function_group() to give each MCP
group one bounded startup attempt and catch connection-related errors
(including those wrapped in ExceptionGroup / BaseExceptionGroup by anyio's
TaskGroup, plus MCP-internal cancellation during stream reconnect). Tools from
an unreachable server are omitted, but an MCP endpoint can never abort startup
or consume an unbounded portion of the startup probe budget.

Problem 8: When a function group is skipped by Fix 5, downstream agent
configs still reference its tools by name in their tool_names list.
WorkflowBuilder.get_tools() raises ValueError for any tool whose function
group was never registered, crashing the entire startup.

Fix 8: Monkey-patch WorkflowBuilder.get_tools() to filter out tools
belonging to skipped function groups before resolution.  The agent starts
with a reduced tool set rather than failing entirely.

Problem 10: The get_tools() filter (Fix 8) only covers agents that
resolve tools via get_tools() (e.g. tool_calling_agent).  The
reasoning_agent plugin resolves tools individually by calling
builder.get_function(tool) for each tool name.  When a function group
was skipped, get_function() raises ValueError, crashing the entire
startup — even though all other components built successfully.

Fix 10: Monkey-patch WorkflowBuilder.get_function() to return None for
names in the skipped set instead of raising.  The reasoning_agent
receives None and skips the unavailable tool, starting with a reduced
tool set — identical degraded behaviour to Fix 8.

Problem 9: NAT's MCPBaseClient._with_reconnect() catches ALL exceptions
from MCP tool calls and attempts session reconnection.  McpError is an
*application-level* error (e.g. "pod not found", "missing parameter")
returned by the MCP server — the connection is healthy.  The spurious
reconnect fails ("generator didn't yield"), triggers cancel-scope
cascades, and crashes the workflow run instead of returning the
error to the LLM agent as a normal tool response.

Fix 9: Monkey-patch MCPBaseClient._with_reconnect() so that McpError
from the inner coro is wrapped in a BaseException sentinel that escapes
the ``except Exception`` reconnect handler.  The outer wrapper unwraps
it and re-raises the original McpError, which the LLM framework then
returns to the agent as a normal tool error response.

"""

import asyncio
import hashlib
import inspect
import json
import logging
import os
import re
import traceback
from contextlib import asynccontextmanager

import httpx

logger = logging.getLogger("daedalus.mcp_patches")

_patched = False

# F-006: fail-closed tracking for the MCP approval gate. The gate is enforced by
# the wrapper installed in _patch_tool_client(); if NAT renames/moves its tool
# execution method the wrapper would silently not install, leaving destructive
# MCP calls ungated. These flags let patch() detect that and refuse to start.
_mcp_client_available = False
_approval_gate_installed = False

# Function groups that were skipped during startup due to connection errors.
# Populated by _patch_startup_resilience, read by the get_tools filter.
_skipped_function_groups: set[str] = set()

# MCP function groups seen during startup. Used as a second line of defense
# when NAT defers remote tool discovery until get_tools()/get_function().
_known_mcp_function_groups: set[str] = set()

# NAT identifies MCP clients by their transport endpoint (for example,
# ``streamable-http:https://...``), while the agent and configuration identify
# the capability by function-group name (for example, ``k8s_mcp_server``).
# Populate this map from the actual built group so approval scope uses one
# canonical logical identity without hard-coded endpoint aliases.
_mcp_server_group_names: dict[str, str] = {}
_ambiguous_mcp_servers: set[str] = set()
_sensitive_mcp_server_names: set[str] = set()

# MCP runtime connections retain the upstream allowance. In the deployed
# cluster, a stale Cilium DNS backend added just over 10 seconds to successful
# lookups, so the previous 10-second override converted recoverable DNS latency
# into ConnectTimeout before HTTP or OAuth was reached.
_MCP_CONNECT_TIMEOUT = 30.0

# Startup is different from runtime: every MCP group is built serially inside
# ASGI lifespan. Give each group one bounded chance, then start without it. The
# zero retry count is an explicit invariant -- connection retries belong on the
# runtime/tool-call path, never on the application startup path.
_MCP_STARTUP_GROUP_TIMEOUT = 15.0
_MCP_STARTUP_MAX_RETRIES = 0

_STARTUP_RESILIENCE_EXCEPTIONS = (
    Exception,
    asyncio.CancelledError,
    BaseExceptionGroup,  # noqa: F821 (builtin in 3.11+)
)


def _httpx_exception_type(name: str):
    cls = getattr(httpx, name, None)
    return cls if isinstance(cls, type) else None


def _optional_exception_type(module_name: str, name: str):
    try:
        module = __import__(module_name)
    except Exception:
        return None
    cls = getattr(module, name, None)
    return cls if isinstance(cls, type) else None


def _httpcore_exception_type(name: str):
    return _optional_exception_type("httpcore", name)


def _anyio_exception_type(name: str):
    return _optional_exception_type("anyio", name)


# Connection error types that indicate an unreachable/unstable server (not a
# logic bug). Keep HTTPStatusError 4xx out of this path so bad auth/config still
# fails loudly. GitHub Copilot MCP can surface transient disconnects as
# RemoteProtocolError instead of ConnectError/ReadTimeout, so include the
# transport/protocol shapes that represent remote/network instability. Some
# streamable-http failures escape before httpx wraps them, so include httpcore
# and anyio transport exceptions when those packages are importable.
_CONNECTION_ERROR_TYPES = tuple(
    cls
    for cls in (
        _httpx_exception_type("TimeoutException"),
        _httpx_exception_type("NetworkError"),
        _httpx_exception_type("RemoteProtocolError"),
        _httpx_exception_type("ProxyError"),
        _httpx_exception_type("ConnectTimeout"),
        _httpx_exception_type("ConnectError"),
        _httpx_exception_type("ReadTimeout"),
        _httpcore_exception_type("TimeoutException"),
        _httpcore_exception_type("NetworkError"),
        _httpcore_exception_type("RemoteProtocolError"),
        _httpcore_exception_type("ConnectError"),
        _httpcore_exception_type("ReadError"),
        _anyio_exception_type("BrokenResourceError"),
        _anyio_exception_type("ClosedResourceError"),
        _anyio_exception_type("EndOfStream"),
        ConnectionError,  # includes ConnectionRefusedError, ConnectionResetError
    )
    if cls is not None
)

# Destructive/mutating verbs that gate an MCP tool call behind human approval.
#
# NOTE: this denylist is DEFENSE-IN-DEPTH only. The primary, robust control is
# restricting each MCP server to an explicit read-only `include:` allowlist in
# backend/tool-calling-config.yaml (the externally managed Kubernetes and UniFi
# servers still expose their discovered surfaces because this repository does
# not own a stable schema for them). Destructive annotations can only tighten
# this policy; read-only annotations are advisory. Unknown Kubernetes/UniFi
# tools default to mutating unless local name/operation evidence is read-only.
# A denylist cannot enumerate every dangerous verb, so prefer an
# operator-supplied allowlist; this list is the backstop.
#
# Distinctive verbs — safe to match anywhere in the tool name (low risk of
# appearing inside a read-only tool name).
_MUTATING_TOOL_FRAGMENTS = (
    "apply",
    "create",
    "delete",
    "deletecollection",
    "patch",
    "replace",
    "rollback",
    "rollout",
    "scale",
    "autoscale",
    "uninstall",
    "update",
    "upgrade",
    "cordon",
    "drain",
    "evict",
    "taint",
    "terminate",
    "destroy",
    "revoke",
    "restart",
    "annotate",
    "remove",
    "disable",
)

# Short/ambiguous verbs matched as WHOLE tokens (the tool name is split on
# non-alphanumeric chars) to avoid false positives such as "asset"/"subset"/
# "reset"/"output"/"list_labels" that a substring match would wrongly gate.
_MUTATING_TOOL_TOKENS = frozenset(
    {
        "exec",
        "set",
        "put",
        "post",
        "cp",
        "edit",
        "kill",
        "drop",
        "debug",
        "expose",
        "attach",
        "label",
        "write",
        "send",
        "move",
        "rename",
    }
)

_WORD_SPLIT_RE = re.compile(r"[^a-z0-9]+")

_NON_DESTRUCTIVE_MCP_TOOLS = {
    # A Gmail draft is reversible and is not sent to a recipient. Keep it
    # outside the external-mutation gate; sending remains separately gated.
    "create_draft",
}

_SENSITIVE_MUTATION_DEFAULT_GROUPS = frozenset({"k8s_mcp_server", "unifi_mcp_server"})
_READ_ONLY_TOOL_PREFIXES = (
    "describe_",
    "find_",
    "get_",
    "list_",
    "query_",
    "read_",
    "search_",
    "show_",
    "status_",
    "watch_",
)
_READ_ONLY_OPERATIONS = frozenset(
    {
        "describe",
        "find",
        "get",
        "list",
        "logs",
        "query",
        "read",
        "search",
        "show",
        "status",
        "watch",
    }
)


def _flatten_tool_payload(args, kwargs) -> dict:
    """Best-effort extraction of MCP tool arguments from wrapper inputs."""
    payload: dict = {}
    for candidate in list(args) + [kwargs]:
        if isinstance(candidate, dict):
            payload.update(candidate)
        elif isinstance(candidate, str):
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                payload.update(parsed)
    nested = payload.get("arguments") or payload.get("args") or payload.get("input")
    if isinstance(nested, dict):
        merged = dict(payload)
        merged.update(nested)
        payload = merged
    return payload


def _annotation_hint(annotations, name: str):
    """Read a boolean MCP tool annotation by *name* (e.g. destructiveHint).

    MCP annotations may arrive as a pydantic model (attribute access) or as a
    plain dict (key access).  Returns the bool value, or None when the hint is
    absent / not a bool.
    """
    if annotations is None:
        return None
    val = None
    if isinstance(annotations, dict):
        val = annotations.get(name)
    else:
        val = getattr(annotations, name, None)
    return val if isinstance(val, bool) else None


def _extract_tool_annotations(tool_client):
    """Best-effort read of MCP tool annotations from an MCPToolClient instance.

    The MCP SDK exposes per-tool annotations (readOnlyHint / destructiveHint /
    idempotentHint / openWorldHint) on the Tool definition. NAT's tool client
    stores that definition under a few possible attribute names depending on
    version. Returns the annotations object (pydantic model or dict), or None
    when the client/version does not expose them.
    """
    if tool_client is None:
        return None
    # Direct annotations attribute on the client (some NAT versions surface it).
    direct = getattr(tool_client, "annotations", None)
    if direct is not None:
        return direct
    # Otherwise look for the underlying MCP Tool definition.
    for attr in ("_tool", "tool", "_tool_def", "tool_def"):
        tool = getattr(tool_client, attr, None)
        if tool is not None:
            ann = getattr(tool, "annotations", None)
            if ann is not None:
                return ann
    return None


def _is_mutating_mcp_call(tool_name: str, payload: dict, annotations=None) -> bool:
    # F-009: honor MCP tool annotations when the server/client exposes them, in
    # ADDITION to the verb heuristic below. destructiveHint=True forces the call
    # to be treated as mutating even if its name carries no listed verb (closing
    # the denylist gap). A remote server's readOnlyHint is advisory only and may
    # never override local mutation detection; externally managed Kubernetes and
    # UniFi schemas are not an authorization authority. The per-server read-only
    # `include:` allowlist remains the primary control where a stable schema is
    # available.
    destructive_hint = _annotation_hint(annotations, "destructiveHint")
    if destructive_hint is True:
        return True

    normalized_tool_name = tool_name.lower().replace(".", "_").replace("-", "_")
    if (
        normalized_tool_name in _NON_DESTRUCTIVE_MCP_TOOLS
        or normalized_tool_name.endswith("_create_draft")
    ):
        return False

    text_parts = [tool_name]
    for key in ("operation", "command", "action", "method", "verb"):
        val = payload.get(key)
        if isinstance(val, str):
            text_parts.append(val)
    text = " ".join(text_parts).lower()

    if any(fragment in text for fragment in _MUTATING_TOOL_FRAGMENTS):
        return True

    tokens = set(_WORD_SPLIT_RE.split(text))
    return bool(tokens & _MUTATING_TOOL_TOKENS)


def _has_local_read_only_evidence(tool_name: str, payload: dict) -> bool:
    normalized = tool_name.lower().replace(".", "_").replace("-", "_")
    if normalized.startswith(_READ_ONLY_TOOL_PREFIXES):
        return True
    for key in ("operation", "command", "action", "method", "verb"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip().lower() in _READ_ONLY_OPERATIONS:
            return True
    return False


def _canonical_mcp_call(payload: dict, input_schema=None) -> tuple[str, str]:
    """Canonicalize the exact arguments used for approval and receipts."""

    canonical_payload = dict(payload)
    canonical_payload.pop("approval_token", None)
    if input_schema is not None:
        canonical_payload = input_schema.model_validate(canonical_payload).model_dump(
            exclude_none=True, mode="json"
        )
    canonical_arguments = json.dumps(
        canonical_payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    arguments_sha256 = hashlib.sha256(canonical_arguments.encode("utf-8")).hexdigest()
    return canonical_arguments, arguments_sha256


def _validate_mcp_approval(
    tool_name: str,
    payload: dict,
    annotations=None,
    server_name: str = "",
    approval_token: str | None = None,
    input_schema=None,
    validated_binding: dict[str, str] | None = None,
) -> tuple[bool, str]:
    is_mutating = _is_mutating_mcp_call(tool_name, payload, annotations)
    if not is_mutating and (
        server_name in _SENSITIVE_MUTATION_DEFAULT_GROUPS
        or server_name in _sensitive_mcp_server_names
    ):
        # Kubernetes and UniFi are externally managed, broad surfaces without
        # repository-owned exact read-only allowlists. NAT 1.7 discards MCP
        # annotations while constructing MCPToolClient, so name prefixes such
        # as ``get_`` are not sufficient authorization evidence. Fail closed
        # for the complete sensitive surface.
        is_mutating = True
    if not is_mutating:
        return True, "read-only"

    # The pinned NAT adapter validates and dumps the remote MCP input schema
    # before MCPToolClient.acall(). A synthetic approval_token argument is
    # therefore stripped (or rejected) before this gate. Transport the
    # credential out of band in trusted request metadata instead.
    token = str(approval_token or "").strip()
    if not token:
        return False, (
            f"MCP tool '{tool_name}' appears to mutate external state and "
            "requires a human-approved execution credential. Call "
            "confirm_action with the exact server, tool, and arguments."
        )

    try:
        from nat_helpers.identity import authenticated_user_id_from_context_or_fallback

        # Remote MCP schemas may legitimately use fields such as `user` as the
        # target of an administrative operation. They are never an identity
        # authority; resolve the actor solely from trusted request context.
        user_id = authenticated_user_id_from_context_or_fallback("")
    except Exception as exc:
        logger.warning(
            "MCP approval identity resolution failed: error_class=%s",
            type(exc).__name__,
        )
        return False, "authenticated approval context is invalid"
    if not user_id:
        return False, "authenticated approval context is required"
    try:
        from user_interaction.approval_tokens import (
            make_redis_client,
            validate_approval_token,
        )

        _canonical_arguments, arguments_sha256 = _canonical_mcp_call(
            payload, input_schema
        )

        def _normalized_approved_hash(approved_arguments: str) -> str:
            approved_payload = json.loads(approved_arguments)
            if not isinstance(approved_payload, dict):
                raise ValueError("approved MCP arguments must be an object")
            return _canonical_mcp_call(approved_payload, input_schema)[1]

        def _capture_validated_binding(binding: dict[str, str]) -> None:
            if validated_binding is not None:
                validated_binding.clear()
                validated_binding.update(binding)

        ok, reason = validate_approval_token(
            make_redis_client(os.getenv("APPROVAL_REDIS_URL")),
            user_id=user_id,
            token=token,
            action_type="mcp_mutation",
            # Full canonical arguments already bind the exact target. A second
            # schema-specific target derivation (namespace vs namespace/name,
            # repo, etc.) is redundant and caused valid approvals to mismatch.
            target="",
            server_name=server_name,
            tool_name=tool_name,
            arguments_sha256=arguments_sha256,
            normalize_arguments_hash=_normalized_approved_hash,
            consume=True,
            on_validated=_capture_validated_binding,
        )
    except Exception as exc:
        logger.warning(
            "MCP approval validation failed: error_class=%s",
            type(exc).__name__,
        )
        return False, "approval validation is unavailable"

    if not ok:
        return False, reason.replace("approval_token", "approval credential")
    return True, "approved"


def _mcp_result_is_error(result) -> bool:
    """Recognize MCP protocol errors after pinned NAT string conversion."""

    if getattr(result, "isError", None) is True:
        return True
    if isinstance(result, dict) and result.get("isError") is True:
        return True
    return isinstance(result, str) and result.lstrip().startswith(
        "MCPToolClient tool call failed:"
    )


def _record_approved_mcp_receipt(
    *,
    approval_token: str,
    validated_binding: dict[str, str],
) -> bool:
    """Persist a short-lived receipt after the exact approved call succeeds."""

    try:
        from user_interaction.approval_tokens import (
            make_redis_client,
            record_mcp_execution_receipt,
        )

        if validated_binding.get("action_type") != "mcp_mutation":
            raise ValueError("validated MCP receipt binding is missing")
        record_mcp_execution_receipt(
            make_redis_client(os.getenv("APPROVAL_REDIS_URL")),
            user_id=validated_binding.get("user_id", ""),
            token=approval_token,
            server_name=validated_binding.get("server_name", ""),
            tool_name=validated_binding.get("tool_name", ""),
            arguments_sha256=validated_binding.get("arguments_sha256", ""),
        )
        return True
    except Exception as exc:
        # The remote mutation already succeeded. Never turn a receipt-storage
        # failure into a tool error that could induce the model to retry it.
        logger.error(
            "MCP success receipt was not recorded: server=%s tool=%s error_class=%s",
            validated_binding.get("server_name", "unknown"),
            validated_binding.get("tool_name", "unknown"),
            type(exc).__name__,
        )
        return False


def _strip_approval_token(args, kwargs) -> None:
    for candidate in list(args) + [kwargs]:
        if not isinstance(candidate, dict):
            continue
        candidate.pop("approval_token", None)
        for key in ("arguments", "args", "input"):
            nested = candidate.get(key)
            if isinstance(nested, dict):
                nested.pop("approval_token", None)


def _tool_ref_text(tool_ref) -> str:
    """Return a stable string name for NAT FunctionRef/FunctionGroupRef values."""
    if isinstance(tool_ref, str):
        return tool_ref
    for attr in ("root", "__root__", "name", "value"):
        value = getattr(tool_ref, attr, None)
        if isinstance(value, str) and value:
            return value
    return str(tool_ref)


def _looks_like_mcp_config(args, kwargs) -> bool:
    """Best-effort detection of a NAT mcp_client config object."""
    for candidate in list(args) + list(kwargs.values()):
        if isinstance(candidate, dict) and candidate.get("_type") == "mcp_client":
            return True
        if (
            getattr(candidate, "_type", None) == "mcp_client"
            or getattr(candidate, "type", None) == "mcp_client"
        ):
            return True
    return False


def _is_mcp_tool_ref(tool_ref) -> bool:
    name = _tool_ref_text(tool_ref).lower()
    return (
        name in {group.lower() for group in _known_mcp_function_groups} or "mcp" in name
    )


def _record_possible_mcp_group(name, args, kwargs) -> None:
    if _is_mcp_tool_ref(name) or _looks_like_mcp_config(args, kwargs):
        _known_mcp_function_groups.add(_tool_ref_text(name))


def _mcp_client_physical_identity(client) -> str:
    """Return the stable endpoint identity shared by base and per-user clients.

    NAT 1.7's ``server_name`` property is only the transport name (for example,
    ``streamable-http``), so it cannot distinguish two MCP servers using the
    same transport.  The concrete clients retain their endpoint in ``_url``;
    combining that with the transport gives the same identity for the shared
    schema client and every per-user execution client.
    """

    if client is None:
        return ""
    transport = (
        getattr(client, "_transport", None)
        or getattr(client, "transport", None)
        or getattr(client, "server_name", None)
    )
    endpoint = getattr(client, "_url", None)
    if endpoint:
        return f"{transport or 'unknown'}:{endpoint}"

    # Stdio clients do not have a URL. Include their command when NAT exposes
    # it; otherwise retain the transport-only identity and let collision
    # tracking fail closed if more than one logical group shares it.
    command = getattr(client, "_command", None)
    if command:
        return f"{transport or 'stdio'}:{command}"
    return str(transport or "")


def _register_mcp_group_identity(group_name, group) -> None:
    """Bind NAT's physical client identity to its configured function group."""

    if group is None:
        return
    client = getattr(group, "mcp_client", None)
    physical_name = _mcp_client_physical_identity(client)
    if not physical_name:
        physical_name = getattr(group, "mcp_client_server_name", None)
    if not isinstance(physical_name, str) or not physical_name.strip():
        return
    logical_name = _tool_ref_text(group_name)
    if logical_name in _SENSITIVE_MUTATION_DEFAULT_GROUPS:
        _sensitive_mcp_server_names.add(physical_name)
    if physical_name in _ambiguous_mcp_servers:
        return
    previous = _mcp_server_group_names.get(physical_name)
    if previous and previous != logical_name:
        # Two logical groups sharing one endpoint cannot be distinguished from
        # MCPToolClient alone. Fail closed by retaining the physical identity;
        # an approval using either ambiguous logical alias will not validate.
        _mcp_server_group_names.pop(physical_name, None)
        _ambiguous_mcp_servers.add(physical_name)
        logger.error(
            "Ambiguous MCP endpoint identity: server=%s groups=%s,%s",
            physical_name,
            previous,
            logical_name,
        )
        return
    _mcp_server_group_names[physical_name] = logical_name


def _canonical_mcp_server_name(parent_client) -> str:
    physical_name = _mcp_client_physical_identity(parent_client) or "unknown"
    return _mcp_server_group_names.get(physical_name, physical_name)


def _record_skipped_function_group(name) -> str:
    text = _tool_ref_text(name)
    _skipped_function_groups.add(text)
    return text


def _mcp_httpx_auth_for_connection(client):
    """Return the HTTP auth adapter appropriate for this connection.

    A shared MCP group's first connection exists only to discover public tool
    schemas. For an interactive provider whose default identity is forbidden
    for tool calls, running the auth adapter here is both noisy and misleading:
    there is no user interaction context yet. Per-user session clients have a
    real user/session id and retain the adapter, so a 401 can start the UI OAuth
    flow normally when the tool is invoked.
    """
    auth = getattr(client, "_httpx_auth", None)
    provider = getattr(client, "_auth_provider", None)
    config = getattr(provider, "config", None)
    if auth is None or config is None:
        return auth

    allow_default = getattr(config, "allow_default_user_id_for_tool_calls", True)
    default_user_id = getattr(config, "default_user_id", None)
    auth_user_id = getattr(auth, "user_id", None)
    if allow_default is False and default_user_id and auth_user_id == default_user_id:
        logger.info(
            "MCP schema bootstrap is unauthenticated; interactive auth is deferred "
            "until a user invokes a tool (url=%s)",
            getattr(client, "_url", "unknown"),
        )
        return None
    return auth


def _is_missing_function_reference_error(exc) -> bool:
    if not isinstance(exc, ValueError):
        return False
    message = str(exc).lower()
    return "function" in message and "not found" in message


def _is_no_tools_after_degradation_error(exc) -> bool:
    if not isinstance(exc, ValueError):
        return False
    return bool(_skipped_function_groups) and "no tools specified" in str(exc).lower()


def _is_mcp_authentication_required_error(exc) -> bool:
    """Return True for an HTTP auth challenge, including wrapped challenges."""
    if isinstance(exc, httpx.HTTPStatusError):
        response = getattr(exc, "response", None)
        return getattr(response, "status_code", None) in {401, 403}
    if isinstance(exc, BaseExceptionGroup):  # noqa: F821 (builtin in 3.11+)
        return any(_is_mcp_authentication_required_error(e) for e in exc.exceptions)
    if exc.__cause__ is not None:
        return _is_mcp_authentication_required_error(exc.__cause__)
    if exc.__context__ is not None and exc.__context__ is not exc:
        return _is_mcp_authentication_required_error(exc.__context__)
    return False


def _is_cancellation_error(exc) -> bool:
    if isinstance(exc, asyncio.CancelledError):
        return True
    if isinstance(exc, BaseExceptionGroup):  # noqa: F821 (builtin in 3.11+)
        return any(_is_cancellation_error(e) for e in exc.exceptions)
    if exc.__cause__ is not None:
        return _is_cancellation_error(exc.__cause__)
    if exc.__context__ is not None and exc.__context__ is not exc:
        return _is_cancellation_error(exc.__context__)
    return False


def _current_task_is_cancelling() -> bool:
    try:
        task = asyncio.current_task()
    except RuntimeError:
        return False
    return task is not None and task.cancelling() > 0


def _is_recoverable_mcp_cancellation(exc, tool_ref) -> bool:
    """Return True for MCP-internal cancellation, not external task shutdown."""
    return (
        _is_mcp_tool_ref(tool_ref)
        and _is_cancellation_error(exc)
        and not _current_task_is_cancelling()
    )


def _should_recover_function_group_startup_error(exc, name) -> bool:
    return _is_connection_error(exc) or _is_recoverable_mcp_cancellation(exc, name)


def _should_skip_tool_resolution_error(exc, tool_ref) -> bool:
    """Return True when an MCP tool reference should degrade to unavailable."""
    if not _is_mcp_tool_ref(tool_ref):
        return False
    return (
        _is_connection_error(exc)
        or _is_missing_function_reference_error(exc)
        or _is_recoverable_mcp_cancellation(exc, tool_ref)
    )


async def _initialize_function_group_for_startup(
    original_add_function_group, builder, name, args, kwargs
):
    """Initialize one function group without allowing MCP to gate startup."""
    _record_possible_mcp_group(name, args, kwargs)
    is_mcp_group = _is_mcp_tool_ref(name) or _looks_like_mcp_config(args, kwargs)
    try:
        if is_mcp_group:
            async with asyncio.timeout(_MCP_STARTUP_GROUP_TIMEOUT):
                return await original_add_function_group(builder, name, *args, **kwargs)
        return await original_add_function_group(builder, name, *args, **kwargs)
    except TimeoutError:
        if not is_mcp_group:
            raise
        skipped_name = _record_skipped_function_group(name)
        logger.warning(
            "Startup resilience: function_group '%s' exceeded the %ss "
            "MCP startup budget and was skipped. Application startup "
            "will continue without this group.",
            skipped_name,
            _MCP_STARTUP_GROUP_TIMEOUT,
        )
        return None
    except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
        if is_mcp_group and _is_mcp_authentication_required_error(exc):
            skipped_name = _record_skipped_function_group(name)
            root = _extract_root_connection_error(exc)
            logger.warning(
                "Startup resilience: function_group '%s' requires user "
                "authentication during schema discovery and was skipped — "
                "%s(%s). Application startup will continue.",
                skipped_name,
                type(root).__name__,
                root,
            )
            return None
        if _is_no_tools_after_degradation_error(exc):
            skipped_name = _record_skipped_function_group(name)
            logger.warning(
                "Startup resilience: function_group '%s' skipped because all "
                "of its tools were unavailable after MCP degradation: %s",
                skipped_name,
                exc,
            )
            return None
        if not _should_recover_function_group_startup_error(exc, name):
            raise
        root = _extract_root_connection_error(exc)
        skipped_name = _record_skipped_function_group(name)
        logger.warning(
            "Startup resilience: function_group '%s' was unreachable and "
            "skipped after one attempt — %s(%s). Application startup will "
            "continue without this group.",
            skipped_name,
            type(root).__name__,
            root,
        )
        return None


def _is_transient_http_error(exc) -> bool:
    """Return True for httpx.HTTPStatusError with a 5xx status code.

    5xx responses from upstream MCP servers are server-side and typically
    transient — treat them like connection errors so startup retries / skips
    instead of crashing the pod.
    """
    if not isinstance(exc, httpx.HTTPStatusError):
        return False
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) if response is not None else None
    return isinstance(status, int) and 500 <= status < 600


def _is_connection_error(exc):
    """Return True if *exc* (possibly wrapped in ExceptionGroup) is a connection error."""
    if isinstance(exc, _CONNECTION_ERROR_TYPES) or _is_transient_http_error(exc):
        return True
    # anyio TaskGroup wraps exceptions in ExceptionGroup/BaseExceptionGroup.
    if isinstance(exc, BaseExceptionGroup):  # noqa: F821 (builtin in 3.11+)
        return any(_is_connection_error(e) for e in exc.exceptions)
    # Check the __cause__ chain (e.g. framework re-raises wrapping the original)
    if exc.__cause__ is not None:
        return _is_connection_error(exc.__cause__)
    # Context managers often re-raise cleanup failures with the original
    # transport exception in __context__ rather than __cause__.
    if exc.__context__ is not None and exc.__context__ is not exc:
        return _is_connection_error(exc.__context__)
    return False


def _extract_root_connection_error(exc):
    """Return the innermost connection error from *exc* for concise logging."""
    if isinstance(exc, _CONNECTION_ERROR_TYPES) or _is_transient_http_error(exc):
        return exc
    if isinstance(exc, BaseExceptionGroup):  # noqa: F821 (builtin in 3.11+)
        for e in exc.exceptions:
            if not _is_connection_error(e):
                continue
            root = _extract_root_connection_error(e)
            if root is not None:
                return root
        return exc
    if exc.__cause__ is not None:
        return _extract_root_connection_error(exc.__cause__)
    if exc.__context__ is not None and exc.__context__ is not exc:
        return _extract_root_connection_error(exc.__context__)
    return exc


@asynccontextmanager
async def _connect_with_graceful_teardown(
    streamable_ctx, session_cls, url, read_timeout_seconds=None
):
    """Connect to an MCP server with graceful teardown error handling.

    Wraps the streamablehttp_client -> ClientSession lifecycle and tracks
    whether the session ``yield`` has returned.  Cancellation errors that
    arrive *after* the yield (during ``__aexit__`` of the transport or
    session) are logged and suppressed instead of propagating, because:

    * The MCP SDK's ``terminate_session()`` catches ``Exception`` but not
      ``CancelledError`` (a ``BaseException``).  During shutdown the HTTP
      DELETE it sends raises ``CancelledError`` which escapes the SDK.
    * anyio cancel-scope ``RuntimeError`` variants behave the same way.

    Errors during the *operational* phase (before the yield returns) are
    still propagated so that the NAT framework's retry logic can act on
    them.

    Args:
        read_timeout_seconds: Timeout for individual MCP request-response
            pairs (ClientSession read_timeout).  Defaults to the MCP SDK
            default (60s) when None.  Set this to the configured
            tool_call_timeout so that slow operations like helm install
            are not killed prematurely.
    """
    from datetime import timedelta

    _in_teardown = False

    def _build_session(session_cls, read, write, timeout_seconds):
        """Create a session using the SDK's typed timeout parameter only."""
        if timeout_seconds is None:
            return session_cls(read, write), False

        try:
            parameters = inspect.signature(session_cls).parameters
        except (TypeError, ValueError):
            parameters = {}
        if "read_timeout_seconds" not in parameters:
            logger.warning(
                "ClientSession has no typed read_timeout_seconds parameter; "
                "using the SDK default (url=%s)",
                url,
            )
            return session_cls(read, write), False

        return (
            session_cls(
                read,
                write,
                read_timeout_seconds=timedelta(seconds=timeout_seconds),
            ),
            True,
        )

    try:
        async with streamable_ctx as (read, write, _):
            session_cm, _timeout_set = _build_session(
                session_cls, read, write, read_timeout_seconds
            )
            async with session_cm as session:
                await session.initialize()
                logger.info("MCP session initialized: url=%s", url)
                yield session
                # If we reach here the yield returned normally -- we are now
                # in the teardown phase.  Any CancelledError from this point
                # is a cleanup artifact (e.g. terminate_session's HTTP DELETE),
                # not an operational failure.
                _in_teardown = True
    except asyncio.CancelledError:
        if _in_teardown:
            logger.info("MCP session teardown cancelled (url=%s) -- suppressed.", url)
        else:
            logger.warning(
                "MCP session cancelled: CancelledError (url=%s). "
                "Propagating for framework retry.",
                url,
            )
            raise
    except RuntimeError as exc:
        if "cancel scope" in str(exc):
            if _in_teardown:
                logger.info(
                    "MCP cancel-scope teardown error suppressed (url=%s).",
                    url,
                )
            else:
                # anyio cancel-scope mismatch during operation.  Convert to
                # CancelledError so the NAT framework's reconnect logic
                # handles it cleanly.
                logger.warning(
                    "MCP cancel scope teardown error (url=%s). "
                    "Converting to CancelledError for cleaner retry.",
                    url,
                )
                raise asyncio.CancelledError(str(exc)) from exc
        else:
            logger.error(
                "MCP connect_to_server failed: url=%s error=%r\n%s",
                url,
                exc,
                traceback.format_exc(),
            )
            raise
    except Exception as exc:
        if _in_teardown and _is_connection_error(exc):
            logger.info(
                "MCP transport cleanup error suppressed during teardown (url=%s): %s",
                url,
                type(_extract_root_connection_error(exc)).__name__,
            )
        elif _is_connection_error(exc):
            # Connection errors are handled gracefully by startup
            # resilience (the function group is skipped).  Log at
            # WARNING with a concise message instead of ERROR with a
            # full traceback to avoid alarming noise for a handled
            # condition.
            logger.warning(
                "MCP connect_to_server failed (connection error, "
                "handled by startup resilience): url=%s error=%s",
                url,
                type(_extract_root_connection_error(exc)).__name__,
            )
            raise
        else:
            logger.error(
                "MCP connect_to_server failed: url=%s error=%r\n%s",
                url,
                exc,
                traceback.format_exc(),
            )
            raise


def patch():
    """Apply MCP StreamableHTTP timeout and diagnostic patches. Safe to call multiple times."""
    global _patched
    if _patched:
        return

    try:
        try:
            from nat.plugins.mcp.client.client_base import MCPStreamableHTTPClient
        except ImportError:
            from nat.plugins.mcp.client_base import MCPStreamableHTTPClient
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import (
            MCP_DEFAULT_SSE_READ_TIMEOUT,
            create_mcp_http_client,
        )

        @asynccontextmanager
        async def patched_connect_to_server(self):
            """
            Patched connect_to_server that builds the httpx client the same
            way upstream does (create_mcp_http_client + streamable_http_client)
            with an explicit runtime-safe connect timeout, and adds the
            daedalus graceful-teardown wrapper (Fix 4) that swallows
            CancelledError / cancel-scope RuntimeError raised after the session
            yield returns.
            """
            url = self._url
            tool_call_timeout_s = self._tool_call_timeout.total_seconds()
            sse_read_timeout_s = max(
                MCP_DEFAULT_SSE_READ_TIMEOUT,
                tool_call_timeout_s,
                self._auth_flow_timeout.total_seconds(),
            )
            timeout = httpx.Timeout(_MCP_CONNECT_TIMEOUT, read=sse_read_timeout_s)

            logger.info("MCP connect_to_server: url=%s timeout=%s", url, timeout)

            http_client = create_mcp_http_client(
                headers=self._custom_headers if self._custom_headers else None,
                timeout=timeout,
                auth=_mcp_httpx_auth_for_connection(self),
            )

            @asynccontextmanager
            async def _ctx():
                async with http_client:
                    async with streamable_http_client(
                        url=url, http_client=http_client
                    ) as (read, write, get_session_id):
                        self._get_mcp_session_id = get_session_id
                        yield read, write, get_session_id

            try:
                async with _connect_with_graceful_teardown(
                    _ctx(),
                    ClientSession,
                    url,
                    read_timeout_seconds=tool_call_timeout_s,
                ) as session:
                    yield session
            finally:
                self._get_mcp_session_id = None

        MCPStreamableHTTPClient.connect_to_server = patched_connect_to_server
        logger.info(
            "MCP StreamableHTTP patch applied -- httpx connect=%ss",
            _MCP_CONNECT_TIMEOUT,
        )

    except ImportError as exc:
        logger.warning("Could not patch MCP StreamableHTTP client: %s", exc)
    except Exception as exc:
        logger.warning("Unexpected error patching MCP client: %s", exc)

    # Patch MCPToolClient to add the approval gate + diagnostic logging, then
    # fail closed if the security gate did not attach to an available MCP client.
    _patch_tool_client()
    _verify_approval_gate_installed()

    # Prevent McpError (application errors) from triggering reconnection
    _patch_mcp_error_no_reconnect()

    # Suppress cascade noise from MCP transport cleanup errors
    _install_mcp_log_filters()

    # Make MCP connection failures non-fatal during startup
    _patch_startup_resilience()

    _patched = True


def _patch_tool_client():
    """Wrap NAT 1.7's exact ``MCPToolClient.acall(tool_args)`` contract."""
    global _mcp_client_available, _approval_gate_installed
    try:
        try:
            from nat.plugins.mcp.client.tool_client import MCPToolClient
        except ImportError:
            try:
                from nat.plugins.mcp.client.client_base import MCPToolClient
            except ImportError:
                from nat.plugins.mcp.tool_client import MCPToolClient

        # MCP client class imported successfully: the approval gate is now
        # REQUIRED to attach. If it does not, patch() fails closed (F-006).
        _mcp_client_available = True

        method_name = "acall"
        original_fn = getattr(MCPToolClient, method_name, None)
        if original_fn is None or not inspect.iscoroutinefunction(original_fn):
            logger.warning(
                "MCPToolClient.acall is missing or is not async; refusing to "
                "attach the approval gate to an unverified execution path"
            )
            return

        signature = inspect.signature(original_fn)
        parameter_names = list(signature.parameters)
        if parameter_names != ["self", "tool_args"]:
            logger.warning(
                "Unexpected MCPToolClient.acall signature %s (expected "
                "(self, tool_args)); approval gate not installed",
                signature,
            )
            return

        import functools

        @functools.wraps(original_fn)
        async def wrapped(self, tool_args):
            tool_name = getattr(self, "_tool_name", getattr(self, "name", "unknown"))
            parent_client = getattr(self, "_parent_client", None)
            server_name = _canonical_mcp_server_name(parent_client)
            payload = _flatten_tool_payload((tool_args,), {})
            annotations = _extract_tool_annotations(self)
            try:
                from nat_helpers.identity import approval_token_from_context

                approval_token = approval_token_from_context()
            except Exception:
                approval_token = None
            validated_binding: dict[str, str] = {}
            approved, approval_reason = _validate_mcp_approval(
                tool_name,
                payload,
                annotations,
                server_name,
                approval_token,
                getattr(self, "input_schema", None),
                validated_binding,
            )
            if not approved:
                logger.warning(
                    "MCP tool call blocked by approval gate: tool=%s reason=%s",
                    tool_name,
                    approval_reason,
                )
                raise PermissionError(approval_reason)
            _strip_approval_token((tool_args,), {})
            logger.info(
                "MCP tool call start: server=%s tool=%s",
                server_name,
                tool_name,
            )
            try:
                # A mutation that timed out after the server committed is
                # ambiguous and must never be replayed automatically under one
                # human approval. NAT's parent call_tool normally reconnects
                # and invokes the same coroutine again. Suppress that replay
                # for the approved call, then restore the configured behavior.
                if approval_reason == "approved" and parent_client is not None:
                    mutation_lock = getattr(
                        parent_client, "_daedalus_mutation_lock", None
                    )
                    if mutation_lock is None:
                        mutation_lock = asyncio.Lock()
                        setattr(
                            parent_client,
                            "_daedalus_mutation_lock",
                            mutation_lock,
                        )
                    async with mutation_lock:
                        reconnect_enabled = getattr(
                            parent_client, "_reconnect_enabled", None
                        )
                        if reconnect_enabled is not None:
                            parent_client._reconnect_enabled = False
                        try:
                            result = await original_fn(self, tool_args)
                        finally:
                            if reconnect_enabled is not None:
                                parent_client._reconnect_enabled = reconnect_enabled
                else:
                    result = await original_fn(self, tool_args)
                if _mcp_result_is_error(result):
                    # Pinned NAT converts CallToolResult(isError=True) into this
                    # normal-looking string return. It is not a successful call
                    # and must never mint an execution receipt.
                    logger.error(
                        "MCP tool call returned an application error: "
                        "server=%s tool=%s",
                        server_name,
                        tool_name,
                    )
                else:
                    if approval_reason == "approved":
                        _record_approved_mcp_receipt(
                            approval_token=approval_token,
                            validated_binding=validated_binding,
                        )
                    logger.info(
                        "MCP tool call success: server=%s tool=%s",
                        server_name,
                        tool_name,
                    )
                return result
            except Exception as exc:
                logger.error(
                    "MCP tool call failed: server=%s tool=%s error_class=%s",
                    server_name,
                    tool_name,
                    type(exc).__name__,
                )
                return (
                    f'{{"error":"mcp_tool_failed","tool":{json.dumps(tool_name)},'
                    f'"error_class":{json.dumps(type(exc).__name__)}}}'
                )

        wrapped._daedalus_approval_gate = True
        setattr(MCPToolClient, method_name, wrapped)
        _approval_gate_installed = True
        logger.info(
            "MCPToolClient approval-gate + diagnostic patch applied on %s.%s",
            MCPToolClient.__name__,
            method_name,
        )

    except ImportError as exc:
        # MCP client not importable: MCP is not in use, nothing to gate.
        logger.warning("Could not patch MCPToolClient: %s", exc)
    except Exception as exc:
        # Leave _approval_gate_installed False so patch() can fail closed.
        logger.warning("Unexpected error patching MCPToolClient: %s", exc)


def _verify_approval_gate_installed():
    """Fail closed if the MCP approval gate did not attach (F-006).

    The gate is the only thing forcing destructive MCP tool calls through human
    approval. If the MCP client class is importable but the gate failed to wrap
    its tool-execution method (e.g. a NAT upgrade renamed it), continuing would
    silently leave destructive MCP calls ungated. Refuse to start instead, unless
    an operator explicitly opts out (MCP_APPROVAL_GATE_OPTIONAL=1) for a
    deployment that intentionally exposes no mutating MCP tools.
    """
    if not _mcp_client_available:
        return
    installed_on_acall = False
    try:
        try:
            from nat.plugins.mcp.client.tool_client import MCPToolClient
        except ImportError:
            from nat.plugins.mcp.client.client_base import MCPToolClient
        installed_on_acall = bool(
            getattr(
                getattr(MCPToolClient, "acall", None), "_daedalus_approval_gate", False
            )
        )
    except ImportError:
        installed_on_acall = False
    if _approval_gate_installed and installed_on_acall:
        return
    if (os.getenv("MCP_APPROVAL_GATE_OPTIONAL") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        logger.warning(
            "MCP approval gate did NOT install, but MCP_APPROVAL_GATE_OPTIONAL is "
            "set; continuing with destructive MCP calls UNGATED."
        )
        return
    logger.critical(
        "MCP approval gate failed to install on the MCP tool client. Refusing to "
        "start so destructive MCP tool calls cannot run without approval. Set "
        "MCP_APPROVAL_GATE_OPTIONAL=1 only if no mutating MCP tools are exposed."
    )
    raise RuntimeError("MCP approval gate failed to install (fail-closed)")


class _McpAppError(BaseException):
    """Sentinel wrapper to smuggle application errors past _with_reconnect.

    _with_reconnect catches ``Exception`` and triggers reconnection.
    We wrap application-level errors (McpError, or the approval gate's
    PermissionError) — which are NOT connection issues — in this
    BaseException subclass so they escape the ``except Exception`` block.
    The outer wrapper unwraps them immediately.
    """

    def __init__(self, original):
        self.original = original
        super().__init__(str(original))


def _patch_mcp_error_no_reconnect():
    """Prevent application-level errors from triggering MCP reconnection.

    NAT's MCPBaseClient._with_reconnect() catches ALL exceptions and
    attempts reconnection.  McpError is an application-level error from
    the MCP server (e.g. "resource not found", "missing parameter") —
    the connection is healthy.  The spurious reconnect fails, triggers
    cancel-scope cascades, and crashes the job.

    The approval gate's PermissionError (F-018) is the same shape: a
    denied mutating call is an application/policy decision, not a
    connection fault.  Left unwrapped it would be caught by
    ``except Exception`` and trigger a spurious reconnect/cancel-scope
    cascade instead of returning cleanly to the agent.

    Fix: Patch MCPBaseClient._with_reconnect() so the inner coro wraps
    McpError and PermissionError in a BaseException sentinel that escapes
    the ``except Exception`` reconnect handler.  The outer wrapper
    unwraps it and re-raises the original.
    """
    try:
        import functools

        from mcp.shared.exceptions import McpError
        from nat.plugins.mcp.client.client_base import MCPBaseClient

        original_with_reconnect = MCPBaseClient._with_reconnect

        @functools.wraps(original_with_reconnect)
        async def patched_with_reconnect(self, coro, *args, **kwargs):
            # Wrap the coro so application-level errors escape
            # _with_reconnect's ``except Exception`` block.
            async def coro_with_mcp_bypass():
                try:
                    return await coro()
                except (McpError, PermissionError) as e:
                    raise _McpAppError(e) from e

            try:
                return await original_with_reconnect(
                    self, coro_with_mcp_bypass, *args, **kwargs
                )
            except _McpAppError as wrapper:
                raise wrapper.original from wrapper.__cause__

        MCPBaseClient._with_reconnect = patched_with_reconnect
        logger.info("MCPBaseClient._with_reconnect McpError bypass patch applied")

    except ImportError as exc:
        logger.warning("Could not patch MCPBaseClient._with_reconnect: %s", exc)
    except Exception as exc:
        logger.warning(
            "Unexpected error patching MCPBaseClient._with_reconnect: %s", exc
        )


def _patch_startup_resilience():
    """Patch WorkflowBuilder to survive MCP connection failures at startup.

    Part 1 — add_function_group resilience:
    NAT's WorkflowBuilder treats any component initialization failure as fatal,
    so one unreachable MCP server kills the entire startup — blocking all
    remaining components (LLMs, retrievers, memory, functions, workflow) from
    initializing. Each MCP group gets exactly one bounded initialization attempt.
    Connection failures and startup timeouts are logged and skipped instead of
    being retried inside ASGI lifespan or raised.

    Part 2 — get_tools filter:
    When a function group is skipped, downstream agent configs still reference
    its tools by name.  WorkflowBuilder.get_tools() raises ValueError for any
    tool whose function group was never registered.  This patch filters out
    skipped groups from the tool_names list before resolution, so the agent
    starts with a reduced (but functional) tool set instead of crashing.

    Part 3 — get_function filter:
    Some plugins resolve tools individually via builder.get_function(tool)
    instead of get_tools(). Without this patch, a skipped function group
    causes ValueError here too. Returns None for skipped groups so the
    agent can skip the tool.
    """
    try:
        import functools

        from nat.builder.workflow_builder import WorkflowBuilder

        # --- Part 1: add_function_group resilience ---

        original_add_fg = WorkflowBuilder.add_function_group

        @functools.wraps(original_add_fg)
        async def resilient_add_function_group(self, name, *args, **kwargs):
            group = await _initialize_function_group_for_startup(
                original_add_fg, self, name, args, kwargs
            )
            if group is not None and (
                _looks_like_mcp_config(args, kwargs) or _is_mcp_tool_ref(name)
            ):
                _register_mcp_group_identity(name, group)
            return group

        WorkflowBuilder.add_function_group = resilient_add_function_group

        # --- Part 2: get_tools filter for skipped groups ---

        original_get_tools = WorkflowBuilder.get_tools

        async def _resolve_tools_individually(self, tool_names, args, kwargs):
            resolved = []
            skipped = []
            for tool_name in tool_names:
                try:
                    result = await original_get_tools(
                        self, [tool_name], *args, **kwargs
                    )
                except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
                    if _should_skip_tool_resolution_error(exc, tool_name):
                        skipped_name = _record_skipped_function_group(tool_name)
                        skipped.append(skipped_name)
                        root = _extract_root_connection_error(exc)
                        logger.warning(
                            "Startup resilience: omitting MCP tool/group '%s' "
                            "during deferred tool resolution — %s(%s).",
                            skipped_name,
                            type(root).__name__,
                            root,
                        )
                        continue
                    raise
                if result:
                    resolved.extend(result)
            if skipped:
                logger.warning(
                    "Startup resilience: resolved reduced tool set after "
                    "omitting unavailable MCP tools/groups: %s",
                    skipped,
                )
            return resolved

        @functools.wraps(original_get_tools)
        async def resilient_get_tools(self, tool_names=None, *args, **kwargs):
            if tool_names and _skipped_function_groups:
                skipped = [
                    n
                    for n in tool_names
                    if _tool_ref_text(n) in _skipped_function_groups
                ]
                if skipped:
                    tool_names = [
                        n
                        for n in tool_names
                        if _tool_ref_text(n) not in _skipped_function_groups
                    ]
                    logger.warning(
                        "Startup resilience: omitting tools %s from agent — "
                        "their function groups were unreachable at startup.",
                        [_tool_ref_text(n) for n in skipped],
                    )
            try:
                result = await original_get_tools(self, tool_names, *args, **kwargs)
            except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
                if tool_names and (
                    _is_connection_error(exc)
                    or any(
                        _should_skip_tool_resolution_error(exc, tool_name)
                        for tool_name in tool_names
                    )
                ):
                    root = _extract_root_connection_error(exc)
                    logger.warning(
                        "Startup resilience: get_tools() failed while resolving "
                        "a tool batch — %s(%s). Retrying per tool to omit only "
                        "unavailable MCP groups.",
                        type(root).__name__,
                        root,
                    )
                    result = await _resolve_tools_individually(
                        self, tool_names, args, kwargs
                    )
                else:
                    raise
            resolved_names = (
                [t.name if hasattr(t, "name") else str(t) for t in result]
                if result
                else []
            )
            logger.info(
                "Agent resolved %d tools: %s", len(resolved_names), resolved_names
            )
            if _skipped_function_groups:
                logger.warning(
                    "Skipped function groups (unavailable until restart): %s",
                    sorted(_skipped_function_groups),
                )
            return result

        WorkflowBuilder.get_tools = resilient_get_tools

        # --- Part 3: get_function filter for skipped groups ---
        #
        # The reasoning_agent plugin resolves tools by calling
        # builder.get_function(tool) for each tool name individually,
        # unlike tool_calling_agent which calls get_tools(tool_names).
        # Without this patch, a skipped function group raises ValueError
        # here and crashes the entire startup.
        #
        # Returning None lets the reasoning_agent's builder skip the
        # tool rather than abort.  The agent starts with a reduced tool
        # set — identical behaviour to the get_tools filter.

        original_get_function = WorkflowBuilder.get_function

        @functools.wraps(original_get_function)
        async def resilient_get_function(self, name, *args, **kwargs):
            name_text = _tool_ref_text(name)
            if name_text in _skipped_function_groups:
                logger.warning(
                    "Startup resilience: get_function('%s') skipped — "
                    "function group was unreachable at startup.",
                    name_text,
                )
                return None
            try:
                return await original_get_function(self, name, *args, **kwargs)
            except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
                if _should_skip_tool_resolution_error(exc, name):
                    skipped_name = _record_skipped_function_group(name)
                    root = _extract_root_connection_error(exc)
                    logger.warning(
                        "Startup resilience: get_function('%s') degraded to "
                        "unavailable — %s(%s).",
                        skipped_name,
                        type(root).__name__,
                        root,
                    )
                    return None
                raise

        WorkflowBuilder.get_function = resilient_get_function

        logger.info("WorkflowBuilder startup resilience patch applied")

    except ImportError as exc:
        logger.warning(
            "Could not patch WorkflowBuilder for startup resilience: %s", exc
        )
    except Exception as exc:
        logger.warning("Unexpected error patching startup resilience: %s", exc)


class _MCPCascadeFilter(logging.Filter):
    """Demote cascade errors that follow MCP ConnectTimeout to DEBUG.

    When an MCP server is temporarily unreachable, the transport logs a
    ConnectTimeout followed by BrokenResourceError, GeneratorExit
    RuntimeError, and cancel-scope errors during cleanup.  These are
    expected consequences of the disconnect, not independent failures.
    Keeping them at ERROR/WARNING clutters logs and obscures the root cause.
    """

    _CASCADE_FRAGMENTS = (
        "BrokenResourceError",
        "async generator ignored GeneratorExit",
        "Attempted to exit cancel scope",
        "Error parsing SSE message",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno < logging.WARNING:
            return True
        msg = record.getMessage()
        if any(frag in msg for frag in self._CASCADE_FRAGMENTS):
            record.levelno = logging.DEBUG
            record.levelname = "DEBUG"
        return True


def _install_mcp_log_filters():
    """Attach cascade noise filter to MCP SDK loggers."""
    cascade_filter = _MCPCascadeFilter()
    for name in ("mcp", "mcp.client.streamable_http", "root"):
        logging.getLogger(name).addFilter(cascade_filter)
    logger.info("MCP cascade log filter installed")
