"""Version-asserted policy and lifecycle adapters for pinned NAT 1.7 MCP.

The application owns four boundaries that NAT 1.7 doesn't expose as supported
hooks:

* enforce exact-call approval and server-side success receipts for explicitly
  allowlisted groups at ``MCPToolClient.acall``;
* preserve per-user OAuth during streamable HTTP connection setup and suppress
  only verified teardown cancellation after a successful session yield;
* keep application-level MCP errors out of the transport reconnect path; and
* bound optional MCP group startup, retry requested skipped groups once before
  tool resolution, and expose required versus optional capability readiness.

Every private method wrapper checks the pinned signature or fails closed. The
module doesn't own NAT async jobs, Dask, OpenAI clients, HTTPX globally, or a
background MCP hot-plug layer. Remove each adapter when the pinned upstream NAT
release provides the corresponding supported hook.
"""

import asyncio
import hashlib
import inspect
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import yaml

logger = logging.getLogger("daedalus.mcp_patches")

_patched = False

# F-006: fail-closed tracking for the MCP approval gate. The gate is enforced by
# the wrapper installed in _patch_tool_client(); if NAT renames/moves its tool
# execution method the wrapper would silently not install, bypassing configured
# allowlist approval policy. This flag lets patch() detect that and refuse to
# start.
_approval_gate_installed = False

# Function groups that were skipped during startup due to connection errors.
# Populated by _patch_startup_resilience, read by the get_tools filter.
_skipped_function_groups: set[str] = set()

# MCP function groups seen during startup. Used as a second line of defense
# when NAT defers remote tool discovery until get_tools().
_known_mcp_function_groups: set[str] = set()

# A failed MCP group gets one optional recovery attempt immediately before the
# workflow resolves its tools. Recovery is construction-time only: NAT 1.7 has
# no supported way to mutate a running agent's tool set after it is built.
_pending_mcp_recovery: dict[str, tuple[tuple, dict]] = {}
_mcp_recovery_attempted: set[str] = set()

# NAT identifies MCP clients by their transport endpoint (for example,
# ``streamable-http:https://...``), while the agent and configuration identify
# the capability by function-group name (for example, ``k8s_mcp_server``).
# Populate this map from the actual built group so approval scope uses one
# canonical logical identity without hard-coded endpoint aliases.
_mcp_server_group_names: dict[str, str] = {}
_ambiguous_mcp_servers: set[str] = set()

# Repository-owned tool authorization is loaded from the deployed NAT workflow
# YAML before the approval gate is installed. NAT 1.7 accepts additional keys
# inside ``tool_overrides`` but does not retain them in its runtime model, so
# this pinned adapter consumes the Daedalus-only ``approval_policy`` field from
# the same source file. A non-empty ``include`` list opts the group into this
# per-tool approval policy. Groups without an ``include`` list intentionally
# expose and authorize every tool advertised by their MCP server.
_approval_policy_configured = False
_READ_ONLY_APPROVAL_POLICY = "read_only"
_APPROVAL_REQUIRED_POLICY = "approval_required"
_SUPPORTED_APPROVAL_POLICIES = frozenset(
    {_READ_ONLY_APPROVAL_POLICY, _APPROVAL_REQUIRED_POLICY}
)

# Startup is different from runtime: every MCP group is built serially inside
# ASGI lifespan. Give each group one bounded chance, then start without it. The
# zero retry count is an explicit invariant -- connection retries belong on the
# runtime/tool-call path, never on the application startup path.
_MCP_STARTUP_GROUP_TIMEOUT = 15.0
_MCP_RECOVERY_TOTAL_TIMEOUT = 5.0

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
# NOTE: this denylist is defense in depth. Authorization comes from the exact
# repository-owned read-only registry below. Remote annotations and name
# heuristics may tighten the policy, but can never authorize an unknown tool.
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

# This runtime registry is authorization evidence, not a discovery cache. It is
# populated only from exact ``tool_overrides.<tool>.approval_policy: read_only``
# declarations in the deployed workflow configuration. Within an explicitly
# allowlisted group, adding a tool to ``include`` never authorizes it
# automatically.
_LOCAL_READ_ONLY_MCP_TOOLS: dict[str, frozenset[str]] = {}

# Function groups without a non-empty ``include`` allowlist use the MCP
# server's complete advertised tool surface. Keep this separate from the
# read-only registry: unrestricted groups may intentionally execute mutations,
# while allowlisted groups continue to fail closed unless an exact operation is
# declared read-only or carries a valid approval credential.
_UNRESTRICTED_MCP_GROUPS: frozenset[str] = frozenset()

_UNRESTRICTED_APPROVAL_REASON = "unrestricted"
_UNRESTRICTED_MUTATION_APPROVAL_REASON = "unrestricted-mutation"

# API-key values must never appear in logs.  Still, operators need a clear
# startup signal when a rendered deployment has omitted the environment
# variable the configured MCP authentication provider requires.  This maps
# only the repository-owned static API-key providers; OAuth providers report
# their own per-user authorization state.
_STATIC_MCP_API_KEY_ENVIRONMENTS = {
    "x_mcp_server": "X_MCP_BEARER_TOKEN",
    "k8s_mcp_server": "KUBERNETES_MCP_TOKEN",
    "unifi_mcp_server": "UNIFI_MCP_TOKEN",
}

_PER_USER_MCP_OAUTH_SERVERS = frozenset({"gmail_mcp_server", "calendar_mcp_server"})


def _bind_configured_mcp_endpoint(
    physical_name: str,
    logical_name: str,
    endpoint_map: dict[str, str],
    ambiguous_endpoints: set[str],
) -> None:
    """Bind one configured endpoint to its logical function-group name."""

    if not physical_name or physical_name in ambiguous_endpoints:
        return
    previous = endpoint_map.get(physical_name)
    if previous and previous != logical_name:
        endpoint_map.pop(physical_name, None)
        ambiguous_endpoints.add(physical_name)
        return
    endpoint_map[physical_name] = logical_name


def configure_mcp_approval_policy(config_path: str | os.PathLike[str]) -> None:
    """Load exact MCP authorization declarations from the deployed YAML.

    A group without a non-empty ``include`` list authorizes every tool exposed
    by the MCP server. For an allowlisted group, ``approval_policy: read_only``
    is the sole configuration value that can bypass human approval.
    ``approval_required`` is an optional explicit marker and has the same
    fail-closed behavior as an omitted policy. Policy entries for tools outside
    the group's ``include`` list are rejected as stale.
    """

    global _LOCAL_READ_ONLY_MCP_TOOLS
    global _UNRESTRICTED_MCP_GROUPS
    global _approval_policy_configured

    path = Path(config_path)
    try:
        raw_config = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise RuntimeError(f"Unable to load MCP approval policy from {path}") from exc
    if not isinstance(raw_config, dict):
        raise RuntimeError(f"MCP approval policy config is not a mapping: {path}")

    function_groups = raw_config.get("function_groups", {})
    if not isinstance(function_groups, dict):
        raise RuntimeError(f"function_groups is not a mapping in {path}")

    read_only_registry: dict[str, frozenset[str]] = {}
    restricted_groups: set[str] = set()
    unrestricted_groups: set[str] = set()
    configured_endpoints: dict[str, str] = {}
    ambiguous_endpoints: set[str] = set()

    for raw_group_name, raw_group in function_groups.items():
        if not isinstance(raw_group_name, str) or not isinstance(raw_group, dict):
            continue
        if raw_group.get("_type") not in {"mcp_client", "per_user_mcp_client"}:
            continue

        group_name = raw_group_name.casefold()
        raw_include = raw_group.get("include", []) or []
        if not isinstance(raw_include, list):
            raise RuntimeError(
                f"function_groups.{raw_group_name}.include must be a list"
            )
        included = {
            str(tool).strip().casefold() for tool in raw_include if str(tool).strip()
        }
        if not included:
            unrestricted_groups.add(group_name)
        else:
            restricted_groups.add(group_name)
        overrides = raw_group.get("tool_overrides", {}) or {}
        if not isinstance(overrides, dict):
            raise RuntimeError(
                f"function_groups.{raw_group_name}.tool_overrides must be a mapping"
            )

        read_only_tools: set[str] = set()
        for raw_tool_name, raw_override in overrides.items():
            if not isinstance(raw_override, dict):
                continue
            raw_policy = raw_override.get("approval_policy")
            if raw_policy is None:
                continue
            policy = str(raw_policy).strip().casefold()
            if policy not in _SUPPORTED_APPROVAL_POLICIES:
                raise RuntimeError(
                    "Unsupported MCP approval policy "
                    f"{raw_policy!r} for {raw_group_name}.{raw_tool_name}"
                )
            tool_name = str(raw_tool_name).strip().casefold()
            if tool_name not in included:
                raise RuntimeError(
                    "MCP approval policy references a tool outside include: "
                    f"{raw_group_name}.{raw_tool_name}"
                )
            if policy == _READ_ONLY_APPROVAL_POLICY:
                if _is_mutating_mcp_call(str(raw_tool_name), {}):
                    raise RuntimeError(
                        "MCP read-only policy conflicts with local mutation "
                        f"detection: {raw_group_name}.{raw_tool_name}"
                    )
                read_only_tools.add(tool_name)

        if read_only_tools:
            read_only_registry[group_name] = frozenset(read_only_tools)

        server = raw_group.get("server", {})
        if isinstance(server, dict):
            transport = str(server.get("transport") or "streamable-http").strip()
            endpoint = os.path.expandvars(str(server.get("url") or "").strip())
            if endpoint and "${" not in endpoint:
                _bind_configured_mcp_endpoint(
                    f"{transport}:{endpoint}",
                    raw_group_name,
                    configured_endpoints,
                    ambiguous_endpoints,
                )

    _LOCAL_READ_ONLY_MCP_TOOLS = read_only_registry
    _UNRESTRICTED_MCP_GROUPS = frozenset(unrestricted_groups)
    _mcp_server_group_names.update(configured_endpoints)
    _ambiguous_mcp_servers.update(ambiguous_endpoints)
    _approval_policy_configured = True
    logger.info(
        "Loaded MCP approval policy: config=%s restricted_groups=%d "
        "unrestricted_groups=%d read_only_tools=%d",
        path,
        len(restricted_groups),
        len(unrestricted_groups),
        sum(len(tools) for tools in read_only_registry.values()),
    )


def _api_key_environment_is_configured(environment_name: str) -> bool:
    """Return whether an API-key environment value is present without exposing it."""

    value = os.getenv(environment_name)
    return bool(value and value.strip() and "${" not in value)


def _log_static_mcp_api_key_configuration() -> None:
    """Log presence-only diagnostics for static MCP API-key providers."""

    for server_name, environment_name in _STATIC_MCP_API_KEY_ENVIRONMENTS.items():
        logger.info(
            "MCP API-key configuration: server=%s environment=%s configured=%s",
            server_name,
            environment_name,
            _api_key_environment_is_configured(environment_name),
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
    # UniFi schemas are not an authorization authority. The exact local registry
    # remains the only path that can classify an operation as read-only.
    destructive_hint = _annotation_hint(annotations, "destructiveHint")
    if destructive_hint is True:
        return True

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


def _has_local_read_only_evidence(server_name: str, tool_name: str) -> bool:
    """Return whether one exact repository-owned operation is read-only."""

    logical_server = _mcp_server_group_names.get(server_name, server_name).casefold()
    normalized_tool = tool_name.strip().casefold()
    for separator in (".", "::"):
        prefix = f"{logical_server}{separator}"
        if normalized_tool.startswith(prefix):
            normalized_tool = normalized_tool[len(prefix) :]
            break
    return normalized_tool in _LOCAL_READ_ONLY_MCP_TOOLS.get(
        logical_server, frozenset()
    )


def _is_unrestricted_mcp_group(server_name: str) -> bool:
    """Return whether the configured group intentionally exposes all tools."""

    logical_server = _mcp_server_group_names.get(server_name, server_name).casefold()
    return logical_server in _UNRESTRICTED_MCP_GROUPS


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
    if _is_unrestricted_mcp_group(server_name):
        reason = (
            _UNRESTRICTED_MUTATION_APPROVAL_REASON
            if is_mutating
            else _UNRESTRICTED_APPROVAL_REASON
        )
        return True, reason
    if not _has_local_read_only_evidence(server_name, tool_name):
        # Unknown operations require approval in every explicitly allowlisted
        # group. In particular, read-like names, payload verbs, and remote
        # readOnlyHint annotations are not local authorization evidence.
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
            f"MCP tool '{tool_name}' isn't authorized as read-only and "
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
        if isinstance(candidate, dict) and candidate.get("_type") in {
            "mcp_client",
            "per_user_mcp_client",
        }:
            return True
        if getattr(candidate, "_type", None) in {
            "mcp_client",
            "per_user_mcp_client",
        } or getattr(candidate, "type", None) in {"mcp_client", "per_user_mcp_client"}:
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


def _required_mcp_function_groups() -> set[str]:
    """Return operator-declared capabilities that must pass readiness."""
    raw = os.getenv("DAEDALUS_REQUIRED_MCP_GROUPS", "")
    return {item.strip() for item in raw.split(",") if item.strip()}


def mcp_capability_status() -> dict[str, object]:
    """Expose required and optional MCP availability without leaking details."""
    required = _required_mcp_function_groups()
    available = _known_mcp_function_groups - _skipped_function_groups
    missing_required = required - available
    unavailable_optional = _skipped_function_groups - required
    state = (
        "unready"
        if missing_required
        else ("degraded" if unavailable_optional else "ready")
    )
    return {
        "state": state,
        "available": sorted(available),
        "required": sorted(required),
        "missing_required": sorted(missing_required),
        "unavailable_optional": sorted(unavailable_optional),
    }


async def _attempt_pending_mcp_recovery(
    builder,
    original_add_function_group,
    requested_names,
) -> list[str]:
    """Retry skipped requested groups once within one shared deadline."""
    requested = {_tool_ref_text(name) for name in requested_names or []}
    candidates = [
        name
        for name in sorted(requested & _skipped_function_groups)
        if name in _pending_mcp_recovery and name not in _mcp_recovery_attempted
    ]
    if not candidates:
        return []

    recovered: list[str] = []
    deadline = asyncio.get_running_loop().time() + _MCP_RECOVERY_TOTAL_TIMEOUT
    for name in candidates:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            break
        args, kwargs = _pending_mcp_recovery[name]
        _mcp_recovery_attempted.add(name)
        try:
            async with asyncio.timeout(remaining):
                group = await original_add_function_group(
                    builder, name, *args, **kwargs
                )
        except _STARTUP_RESILIENCE_EXCEPTIONS as exc:
            if _current_task_is_cancelling():
                raise
            root = _extract_root_connection_error(exc)
            logger.warning(
                "MCP recovery: function_group '%s' remains unavailable: %s(%s)",
                name,
                type(root).__name__,
                root,
            )
            continue

        _register_mcp_group_identity(name, group)
        _skipped_function_groups.discard(name)
        _pending_mcp_recovery.pop(name, None)
        recovered.append(name)
        logger.info("MCP recovery: function_group '%s' recovered", name)

    return recovered


def _mcp_httpx_auth_for_connection(client):
    """Return the HTTP auth adapter appropriate for this connection.

    Interactive providers that forbid their default identity must be registered
    as NAT per-user MCP groups. Seeing that default identity here means a shared
    workflow is trying to discover schemas outside authenticated user context.
    Refuse the connection so a config regression can't silently restore the old
    unauthenticated bootstrap path.
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
        raise RuntimeError(
            "OAuth MCP schema discovery requires authenticated per-user context "
            f"(url={getattr(client, '_url', 'unknown')})"
        )
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
    message = str(exc).casefold()
    return any(
        marker in message
        for marker in (
            "authentication required",
            "authentication failed",
            "authorization required",
            "authorization failed",
            "not authorized",
            "unauthorized",
            "forbidden",
            "oauth",
        )
    )


def _mcp_tool_error_payload(exc, *, server_name: str, tool_name: str) -> str:
    """Return a safe, actionable MCP failure without leaking server details."""

    base = {
        "tool": tool_name,
        "server": server_name,
        "retryable": False,
    }
    if _is_mcp_authentication_required_error(exc):
        if server_name in _STATIC_MCP_API_KEY_ENVIRONMENTS:
            payload = {
                **base,
                "error": "mcp_shared_authentication_failed",
                "auth_scope": "shared",
                "message": (
                    "The operator-managed MCP credential was rejected. "
                    "User authorization or confirm_action cannot fix it; do not "
                    "retry this tool in the same turn."
                ),
            }
        elif server_name in _PER_USER_MCP_OAUTH_SERVERS:
            payload = {
                **base,
                "error": "mcp_user_authentication_required",
                "auth_scope": "user",
                "message": (
                    "This user must connect or reconnect the service in the "
                    "authorization prompt; do not retry this tool in the same turn."
                ),
            }
        else:
            payload = {
                **base,
                "error": "mcp_authentication_failed",
                "auth_scope": "unknown",
                "message": (
                    "The MCP server rejected authentication; do not retry this "
                    "tool in the same turn."
                ),
            }
    elif isinstance(exc, BaseException) and _is_connection_error(exc):
        payload = {
            **base,
            "error": "mcp_server_unavailable",
            "message": (
                "The MCP server is unavailable after bounded recovery; use one "
                "useful fallback or report the omission without retrying this tool."
            ),
        }
    else:
        payload = {
            **base,
            "error": "mcp_tool_failed",
            "message": "The MCP call failed; do not retry it unchanged in this turn.",
        }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


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
            auth_scope = (
                "operator-managed shared credential"
                if skipped_name in _STATIC_MCP_API_KEY_ENVIRONMENTS
                else "per-user authorization"
            )
            logger.warning(
                "Startup resilience: function_group '%s' rejected its %s "
                "during schema discovery and was skipped. Application startup "
                "will continue; status_code=%s.",
                skipped_name,
                auth_scope,
                getattr(getattr(exc, "response", None), "status_code", "unknown"),
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
async def _connect_with_graceful_teardown(upstream_context, url):
    """Wrap NAT's transport without reimplementing its connection setup."""
    in_teardown = False
    try:
        async with upstream_context as session:
            yield session
            # The caller completed normally. Errors raised while upstream now
            # exits its SDK transport are cleanup artifacts, not call failures.
            in_teardown = True
    except asyncio.CancelledError:
        if in_teardown:
            logger.info("MCP session teardown cancelled (url=%s) -- suppressed.", url)
        else:
            raise
    except RuntimeError as exc:
        if "cancel scope" in str(exc):
            if in_teardown:
                logger.info(
                    "MCP cancel-scope teardown error suppressed (url=%s).",
                    url,
                )
            else:
                raise asyncio.CancelledError(str(exc)) from exc
        else:
            raise
    except Exception as exc:
        if in_teardown and _is_connection_error(exc):
            logger.info(
                "MCP transport cleanup error suppressed during teardown (url=%s): %s",
                url,
                type(_extract_root_connection_error(exc)).__name__,
            )
        else:
            raise


def patch(config_path: str | os.PathLike[str] | None = None):
    """Apply pinned MCP policy and lifecycle adapters. Safe to call repeatedly."""
    global _patched

    if config_path is not None:
        configure_mcp_approval_policy(config_path)
    elif not _approval_policy_configured:
        configured_path = os.getenv("NAT_CONFIG_FILE", "").strip()
        if configured_path:
            configure_mcp_approval_policy(configured_path)
        else:
            logger.warning(
                "No NAT_CONFIG_FILE supplied for MCP approval policy; all MCP "
                "tools remain approval-gated"
            )
    if _patched:
        return

    _log_static_mcp_api_key_configuration()

    try:
        from nat.plugins.mcp.client.client_base import MCPStreamableHTTPClient

        original_connect_to_server = MCPStreamableHTTPClient.connect_to_server
        signature = inspect.signature(original_connect_to_server)
        if list(signature.parameters) != ["self"]:
            raise RuntimeError(
                f"Unexpected MCPStreamableHTTPClient.connect_to_server signature: {signature}"
            )

        @asynccontextmanager
        async def patched_connect_to_server(self):
            original_auth = getattr(self, "_httpx_auth", None)
            self._httpx_auth = _mcp_httpx_auth_for_connection(self)
            try:
                async with _connect_with_graceful_teardown(
                    original_connect_to_server(self),
                    getattr(self, "_url", "unknown"),
                ) as session:
                    yield session
            finally:
                self._httpx_auth = original_auth

        patched_connect_to_server._daedalus_transport_wrapper = True
        MCPStreamableHTTPClient.connect_to_server = patched_connect_to_server
        logger.info("MCP StreamableHTTP policy/lifecycle wrapper applied")

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

    # Make MCP connection failures non-fatal during startup
    _patch_startup_resilience()

    _patched = True


def _patch_tool_client():
    """Wrap NAT 1.7's exact ``MCPToolClient.acall(tool_args)`` contract."""
    global _approval_gate_installed
    try:
        from nat.plugins.mcp.client.client_base import MCPToolClient

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
                # ambiguous and must never be replayed automatically. NAT's
                # parent call_tool normally reconnects and invokes the same
                # coroutine again. Suppress that replay for both explicitly
                # approved and unrestricted mutations, then restore the
                # configured behavior.
                if (
                    approval_reason
                    in {
                        "approved",
                        _UNRESTRICTED_MUTATION_APPROVAL_REASON,
                    }
                    and parent_client is not None
                ):
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
                    return _mcp_tool_error_payload(
                        RuntimeError(str(result)),
                        server_name=server_name,
                        tool_name=tool_name,
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
                return _mcp_tool_error_payload(
                    exc,
                    server_name=server_name,
                    tool_name=tool_name,
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
        logger.warning("Could not patch pinned MCPToolClient: %s", exc)
    except Exception as exc:
        # Leave _approval_gate_installed False so patch() can fail closed.
        logger.warning("Unexpected error patching MCPToolClient: %s", exc)


def _verify_approval_gate_installed():
    """Fail closed if the MCP approval gate did not attach (F-006).

    The gate is the only thing forcing destructive MCP tool calls through human
    approval. If it failed to wrap the pinned tool-execution method, continuing
    would silently leave destructive MCP calls ungated. Refuse to start.
    """
    installed_on_acall = False
    try:
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
    logger.critical(
        "MCP approval gate failed to install on the pinned MCP tool client. "
        "Refusing to start so destructive MCP calls cannot run without approval."
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
    being retried inside ASGI lifespan or raised. Requested skipped groups get
    one shared-budget recovery pass immediately before tool resolution.

    Part 2 — get_tools filter:
    When a function group is skipped, downstream agent configs still reference
    its tools by name.  WorkflowBuilder.get_tools() raises ValueError for any
    tool whose function group was never registered.  This patch filters out
    skipped groups from the tool_names list before resolution, so the agent
    starts with a reduced (but functional) tool set instead of crashing.

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
            is_mcp_group = _looks_like_mcp_config(args, kwargs) or _is_mcp_tool_ref(
                name
            )
            name_text = _tool_ref_text(name)
            if group is not None and is_mcp_group:
                _register_mcp_group_identity(name, group)
            elif is_mcp_group and name_text in _skipped_function_groups:
                _pending_mcp_recovery[name_text] = (tuple(args), dict(kwargs))
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
            if tool_names:
                await _attempt_pending_mcp_recovery(
                    self,
                    original_add_fg,
                    tool_names,
                )
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
                    "Skipped function groups after bounded recovery: %s",
                    sorted(_skipped_function_groups),
                )
            return result

        WorkflowBuilder.get_tools = resilient_get_tools

        logger.info("WorkflowBuilder startup resilience patch applied")

    except ImportError as exc:
        logger.warning(
            "Could not patch WorkflowBuilder for startup resilience: %s", exc
        )
    except Exception as exc:
        logger.warning("Unexpected error patching startup resilience: %s", exc)
