"""Application-owned, exact-call MCP authorization and execution receipts."""

import base64
import hashlib
import json
import logging
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

logger = logging.getLogger("daedalus.mcp_approval")


_mcp_server_group_names: dict[str, str] = {}


_ambiguous_mcp_servers: set[str] = set()


_approval_policy_configured = False


_READ_ONLY_APPROVAL_POLICY = "read_only"


_APPROVAL_REQUIRED_POLICY = "approval_required"


_AUTO_APPROVE_POLICY = "auto_approve"


_SUPPORTED_APPROVAL_POLICIES = frozenset(
    {_READ_ONLY_APPROVAL_POLICY, _APPROVAL_REQUIRED_POLICY, _AUTO_APPROVE_POLICY}
)


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


_LOCAL_READ_ONLY_MCP_TOOLS: dict[str, frozenset[str]] = {}


_LOCAL_AUTO_APPROVED_MCP_TOOLS: dict[str, frozenset[str]] = {}


@dataclass(frozen=True)
class _McpGroupApprovalPolicy:
    included: frozenset[str]
    excluded: frozenset[str]
    default: str
    overrides: dict[str, str]

    def for_tool(self, tool_name: str) -> str:
        # A nonempty include takes precedence over exclude. Never extend
        # a group default to tools outside that group's exposure filter.
        if self.included:
            if tool_name not in self.included:
                return _APPROVAL_REQUIRED_POLICY
        elif tool_name in self.excluded:
            return _APPROVAL_REQUIRED_POLICY
        return self.overrides.get(tool_name, self.default)


_MCP_GROUP_APPROVAL_POLICIES: dict[str, _McpGroupApprovalPolicy] = {}


_MCP_APPROVAL_MARKER_PREFIX = "<!--daedalus-mcp-approval:"


_MCP_APPROVAL_MARKER_SUFFIX = "-->"


_PER_USER_MCP_OAUTH_SERVERS: frozenset[str] = frozenset()


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


_MAX_POLICY_BASE_DEPTH = 5


def _deep_merge_policy_mapping(base_value: dict, override_value: dict) -> dict:
    result = dict(base_value)
    for key, value in override_value.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge_policy_mapping(result[key], value)
        else:
            result[key] = value
    return result


def _load_policy_config(path: Path, _seen: frozenset[Path] = frozenset()) -> dict:
    resolved = path.resolve()
    if resolved in _seen or len(_seen) >= _MAX_POLICY_BASE_DEPTH:
        raise RuntimeError(
            f"MCP approval policy `base:` chain too deep or circular at {resolved}"
        )
    try:
        raw_config = yaml.safe_load(resolved.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise RuntimeError(
            f"Unable to load MCP approval policy from {resolved}"
        ) from exc
    if not isinstance(raw_config, dict):
        raise RuntimeError(f"MCP approval policy config is not a mapping: {resolved}")
    base = raw_config.pop("base", None)
    if not base:
        return raw_config
    base_config = _load_policy_config(resolved.parent / str(base), _seen | {resolved})
    return _deep_merge_policy_mapping(base_config, raw_config)


def _parse_mcp_group_approval_policy(
    name: str, config: dict
) -> _McpGroupApprovalPolicy:
    """Validate exposure and approval defaults without changing runtime state."""

    def tool_names(key: str) -> frozenset[str]:
        raw = config.get(key, [])
        if not isinstance(raw, list) or any(
            not isinstance(tool, str) or not tool.strip() for tool in raw
        ):
            raise RuntimeError(
                f"function_groups.{name}.{key} must be a list of non-empty tool names"
            )
        return frozenset(tool.strip().casefold() for tool in raw)

    included, excluded = tool_names("include"), tool_names("exclude")
    default = (
        str(config.get("approval_policy", _APPROVAL_REQUIRED_POLICY)).strip().casefold()
    )
    if default not in {_APPROVAL_REQUIRED_POLICY, _AUTO_APPROVE_POLICY}:
        raise RuntimeError(
            f"Unsupported MCP group approval policy {default!r} for {name}"
        )
    raw_overrides = config.get("tool_overrides", {}) or {}
    if not isinstance(raw_overrides, dict):
        raise RuntimeError(f"function_groups.{name}.tool_overrides must be a mapping")
    overrides: dict[str, str] = {}
    for raw_tool_name, override in raw_overrides.items():
        if not isinstance(override, dict) or override.get("approval_policy") is None:
            continue
        raw_policy = override["approval_policy"]
        policy = str(raw_policy).strip().casefold()
        if policy not in _SUPPORTED_APPROVAL_POLICIES:
            raise RuntimeError(
                f"Unsupported MCP approval policy {raw_policy!r} for {name}.{raw_tool_name}"
            )
        tool_name = str(raw_tool_name).strip().casefold()
        if included and tool_name not in included:
            raise RuntimeError(
                f"MCP approval policy references a tool outside include: {name}.{raw_tool_name}"
            )
        if not included and tool_name in excluded:
            raise RuntimeError(
                f"MCP approval policy references an excluded tool: {name}.{raw_tool_name}"
            )
        if policy == _READ_ONLY_APPROVAL_POLICY and _is_mutating_mcp_call(
            str(raw_tool_name), {}
        ):
            raise RuntimeError(
                f"MCP read-only policy conflicts with local mutation detection: {name}.{raw_tool_name}"
            )
        overrides[tool_name] = policy
    return _McpGroupApprovalPolicy(included, excluded, default, overrides)


def configure_mcp_approval_policy(config_path: str | os.PathLike[str]) -> None:
    """Load exact MCP authorization declarations from the deployed YAML.

    Follows application ``base:`` inheritance with child-over-base deep-merge
    semantics, so overlay configs keep the canonical authorization policy.

    Omitted or empty ``include`` discovers all tools, subject to ``exclude``.
    Group defaults support ``auto_approve`` and ``approval_required`` (default).
    Exact tool policies take precedence and can also classify verified reads
    as ``read_only``. Discovery alone never authorizes execution.
    """

    global _LOCAL_READ_ONLY_MCP_TOOLS
    global _LOCAL_AUTO_APPROVED_MCP_TOOLS
    global _MCP_GROUP_APPROVAL_POLICIES
    global _PER_USER_MCP_OAUTH_SERVERS
    global _approval_policy_configured

    path = Path(config_path)
    raw_config = _load_policy_config(path)

    function_groups = raw_config.get("function_groups", {})
    if not isinstance(function_groups, dict):
        raise RuntimeError(f"function_groups is not a mapping in {path}")
    authentication = raw_config.get("authentication", {})
    if not isinstance(authentication, dict):
        raise RuntimeError(f"authentication is not a mapping in {path}")

    read_only_registry: dict[str, frozenset[str]] = {}
    auto_approved_registry: dict[str, frozenset[str]] = {}
    group_policies: dict[str, _McpGroupApprovalPolicy] = {}
    restricted_groups: set[str] = set()
    configured_endpoints: dict[str, str] = {}
    ambiguous_endpoints: set[str] = set()
    per_user_oauth_servers: set[str] = set()

    for raw_group_name, raw_group in function_groups.items():
        if not isinstance(raw_group_name, str) or not isinstance(raw_group, dict):
            continue
        if raw_group.get("_type") not in {"mcp_client", "per_user_mcp_client"}:
            continue

        group_name = raw_group_name.casefold()
        group_policy = _parse_mcp_group_approval_policy(raw_group_name, raw_group)
        group_policies[group_name] = group_policy
        if group_policy.included:
            restricted_groups.add(group_name)
        read_only_tools = {
            tool
            for tool, policy in group_policy.overrides.items()
            if policy == _READ_ONLY_APPROVAL_POLICY
        }
        auto_approved_tools = {
            tool
            for tool, policy in group_policy.overrides.items()
            if policy == _AUTO_APPROVE_POLICY
        }
        if read_only_tools:
            read_only_registry[group_name] = frozenset(read_only_tools)
        if auto_approved_tools:
            auto_approved_registry[group_name] = frozenset(auto_approved_tools)

        server = raw_group.get("server", {})
        if isinstance(server, dict):
            auth_provider_name = server.get("auth_provider")
            auth_provider = authentication.get(auth_provider_name, {})
            if (
                raw_group.get("_type") == "per_user_mcp_client"
                and isinstance(auth_provider_name, str)
                and isinstance(auth_provider, dict)
                and auth_provider.get("_type") == "mcp_oauth2"
            ):
                per_user_oauth_servers.add(group_name)
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
    _LOCAL_AUTO_APPROVED_MCP_TOOLS = auto_approved_registry
    _MCP_GROUP_APPROVAL_POLICIES = group_policies
    _PER_USER_MCP_OAUTH_SERVERS = frozenset(per_user_oauth_servers)
    _mcp_server_group_names.update(configured_endpoints)
    _ambiguous_mcp_servers.update(ambiguous_endpoints)
    _approval_policy_configured = True
    logger.info(
        "Loaded MCP approval policy: config=%s restricted_groups=%d "
        "read_only_tools=%d auto_approved_tools=%d auto_approved_groups=%d per_user_oauth_groups=%d",
        path,
        len(restricted_groups),
        sum(len(tools) for tools in read_only_registry.values()),
        sum(len(tools) for tools in auto_approved_registry.values()),
        sum(
            policy.default == _AUTO_APPROVE_POLICY for policy in group_policies.values()
        ),
        len(per_user_oauth_servers),
    )


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


def _mcp_policy_target(server_name: str, tool_name: str) -> tuple[str, str]:
    """Normalize a tool name within its canonical server identity."""

    logical_server = _mcp_server_group_names.get(server_name, server_name).casefold()
    normalized_tool = tool_name.strip().casefold()
    for separator in (".", "::"):
        prefix = f"{logical_server}{separator}"
        if normalized_tool.startswith(prefix):
            normalized_tool = normalized_tool[len(prefix) :]
            break
    return logical_server, normalized_tool


def _has_local_read_only_evidence(server_name: str, tool_name: str) -> bool:
    """Return whether one exact repository-owned operation is read-only."""

    logical_server, normalized_tool = _mcp_policy_target(server_name, tool_name)
    return normalized_tool in _LOCAL_READ_ONLY_MCP_TOOLS.get(
        logical_server, frozenset()
    )


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


def _mcp_approval_target(arguments: dict, arguments_sha256: str) -> str:
    """Derive a compact, deterministic target label without rendering content."""

    identifiers: list[str] = []
    for key in (
        "documentId",
        "document_id",
        "calendarId",
        "calendar_id",
        "eventId",
        "event_id",
        "namespace",
        "name",
        "id",
    ):
        value = arguments.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            rendered = str(value).strip()
            if rendered not in identifiers:
                identifiers.append(rendered)
    return "/".join(identifiers[:3]) or f"arguments:{arguments_sha256[:16]}"


def _mcp_approval_summary(
    *, server_name: str, tool_name: str, target: str, canonical_arguments: str
) -> str:
    """Describe the protected call using metadata only, never document text."""

    payload_kib = max(1, math.ceil(len(canonical_arguments.encode("utf-8")) / 1024))
    if server_name == "docs_mcp_server" and tool_name == "update_doc":
        return f"Update Google document {target} ({payload_kib} KiB payload)"
    return f"Run {server_name}.{tool_name} on {target} ({payload_kib} KiB payload)"


def _encode_mcp_approval_marker(payload: dict) -> str:
    encoded = (
        base64.urlsafe_b64encode(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        .decode("ascii")
        .rstrip("=")
    )
    return f"{_MCP_APPROVAL_MARKER_PREFIX}{encoded}{_MCP_APPROVAL_MARKER_SUFFIX}"


def _create_mcp_approval_marker(
    *,
    user_id: str,
    server_name: str,
    tool_name: str,
    canonical_arguments: str,
    arguments_sha256: str,
) -> str:
    """Persist the gate-owned exact call and return an opaque UI marker."""

    from nat_helpers.approval_context import register_approval_marker
    from user_interaction.approval_tokens import (
        create_pending_mcp_approval,
        make_redis_client,
    )

    arguments = json.loads(canonical_arguments)
    target = _mcp_approval_target(arguments, arguments_sha256)
    summary = _mcp_approval_summary(
        server_name=server_name,
        tool_name=tool_name,
        target=target,
        canonical_arguments=canonical_arguments,
    )
    pending = create_pending_mcp_approval(
        make_redis_client(os.getenv("APPROVAL_REDIS_URL")),
        user_id=user_id,
        action=summary,
        reason="This MCP operation changes external data.",
        target=target,
        server_name=server_name,
        tool_name=tool_name,
        arguments_json=canonical_arguments,
    )
    marker = _encode_mcp_approval_marker(
        {
            "version": 1,
            "requestId": pending["request_id"],
            "serverName": server_name,
            "toolName": tool_name,
            "target": target,
            "summary": summary,
            "argumentsSha256": arguments_sha256,
        }
    )
    return register_approval_marker(marker)


def _validate_mcp_approval(
    tool_name: str,
    payload: dict,
    annotations=None,
    server_name: str = "",
    approval_token: str | None = None,
    input_schema=None,
    validated_binding: dict[str, str] | None = None,
) -> tuple[bool, str]:
    logical_server, normalized_tool = _mcp_policy_target(server_name, tool_name)
    group_policy = _MCP_GROUP_APPROVAL_POLICIES.get(logical_server)
    policy = (
        group_policy.for_tool(normalized_tool)
        if group_policy
        else _APPROVAL_REQUIRED_POLICY
    )
    if policy == _AUTO_APPROVE_POLICY:
        return True, "auto-approved"
    is_mutating = _is_mutating_mcp_call(tool_name, payload, annotations)
    if policy != _READ_ONLY_APPROVAL_POLICY:
        # Operations without operator authorization or exact read-only evidence
        # require approval. In particular, read-like names, payload verbs, and remote
        # readOnlyHint annotations are not local authorization evidence.
        is_mutating = True
    if not is_mutating:
        return True, "read-only"

    # A typed adapter may validate and dump the remote MCP input schema
    # before MCPToolClient.acall(). A synthetic approval_token argument is
    # therefore stripped (or rejected) before this gate. Transport the
    # credential out of band in trusted request metadata instead.
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
        return False, (
            "authenticated approval context is required before an execution "
            "credential can be created"
        )
    token = str(approval_token or "").strip()
    if not token:
        try:
            canonical_arguments, arguments_sha256 = _canonical_mcp_call(
                payload, input_schema
            )
            return False, _create_mcp_approval_marker(
                user_id=user_id,
                server_name=server_name,
                tool_name=tool_name,
                canonical_arguments=canonical_arguments,
                arguments_sha256=arguments_sha256,
            )
        except Exception as exc:
            logger.warning(
                "Unable to persist gate-owned MCP approval: error_class=%s",
                type(exc).__name__,
            )
            return False, "protected approval creation is unavailable"
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
    """Recognize MCP protocol errors in structured or serialized results."""

    if getattr(result, "isError", None) is True:
        return True
    if isinstance(result, str):
        if result.lstrip().startswith("MCPToolClient tool call failed:"):
            return True
        # The per-user wrapper converts exceptions to a sanitized JSON envelope.
        # That conversion must not turn a rejected mutation into a success.
        if _MCP_APPROVAL_MARKER_PREFIX in result:
            return True  # A pending approval is not an execution result.
        try:
            result = json.loads(result)
        except (TypeError, ValueError):
            return False
    if isinstance(result, dict):
        return result.get("isError") is True or (
            bool(result.get("error"))
            and isinstance(result.get("server"), str)
            and isinstance(result.get("tool"), str)
            and isinstance(result.get("retryable"), bool)
        )
    return False


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
