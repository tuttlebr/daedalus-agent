"""Redis-backed approval tokens for consequential actions."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

try:  # pragma: no cover - import availability depends on runtime image
    import redis
except Exception:  # pragma: no cover
    redis = None  # type: ignore[assignment]


DEFAULT_APPROVAL_TTL_SECONDS = 300
DEFAULT_PENDING_APPROVAL_TTL_SECONDS = 7 * 24 * 60 * 60
DEFAULT_MCP_RECEIPT_TTL_SECONDS = 300

_SENSITIVE_ARGUMENT_KEY = re.compile(
    r"(?:authorization|cookie|credential|password|secret|token|api[_-]?key)",
    re.IGNORECASE,
)
_SENSITIVE_STRING_VALUE = re.compile(
    r"(?:"
    r"\bauthorization\s*[:=]|"
    r"\b(?:bearer|basic)\s+\S+|"
    # Shell/env-style assignments commonly hide credentials in otherwise
    # unstructured list values (for example API_TOKEN=...). Match sensitive
    # identifier *segments* so underscores do not defeat the word boundary,
    # while avoiding unrelated identifiers such as monkey=.
    r"\b(?:(?:[a-z0-9]+[_-])*(?:token|secret|password|credential|key)"
    r"(?:[_-][a-z0-9]+)*|api[_-]?key)\s*[:=]\s*\S+|"
    r"https?://[^\s/:@]+:[^\s/@]+@"
    r")",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ApprovalRequest:
    user_id: str
    action_type: str
    target: str
    server_name: str = ""
    tool_name: str = ""
    arguments_sha256: str = ""
    canonical_arguments: str = ""


def _norm(value: str | None, fallback: str = "") -> str:
    return (value or fallback).strip() or fallback


def approval_token_key(user_id: str, token: str) -> str:
    safe_user = hashlib.sha256(_norm(user_id, "anonymous").encode()).hexdigest()[:16]
    return f"approval:{safe_user}:{token}"


def pending_approval_key(user_id: str, request_id: str) -> str:
    safe_user = hashlib.sha256(_norm(user_id, "anonymous").encode()).hexdigest()[:16]
    return f"approval-pending:{safe_user}:{_norm(request_id)}"


def mcp_execution_receipt_key(token: str) -> str:
    """Return an opaque receipt key without putting the credential in Redis."""

    normalized_token = _norm(token)
    if not normalized_token:
        raise ValueError("MCP execution receipt requires a credential")
    token_hash = hashlib.sha256(normalized_token.encode("utf-8")).hexdigest()
    return f"approval-receipt:{token_hash}"


def record_mcp_execution_receipt(
    redis_client: Any,
    *,
    user_id: str,
    token: str,
    server_name: str,
    tool_name: str,
    arguments_sha256: str,
    ttl_seconds: int = DEFAULT_MCP_RECEIPT_TTL_SECONDS,
) -> None:
    """Record that the gate observed one exact approved MCP call succeed.

    The high-entropy worker credential is represented only by its SHA-256 in
    the Redis key and is never persisted in the receipt payload.
    """

    binding = {
        "user_id": _norm(user_id),
        "server_name": _norm(server_name),
        "tool_name": _norm(tool_name),
        "arguments_sha256": _norm(arguments_sha256),
    }
    if not all(binding.values()):
        raise ValueError("MCP execution receipt requires an exact call binding")
    if not re.fullmatch(r"[0-9a-f]{64}", binding["arguments_sha256"]):
        raise ValueError("MCP execution receipt requires a SHA-256 argument hash")

    payload = {
        **binding,
        "action_type": "mcp_mutation",
        "created_at": int(time.time()),
    }
    redis_client.setex(
        mcp_execution_receipt_key(token),
        max(1, int(ttl_seconds)),
        json.dumps(payload, sort_keys=True, separators=(",", ":")),
    )


def consume_mcp_execution_receipt(
    redis_client: Any,
    *,
    user_id: str,
    token: str,
    server_name: str,
    tool_name: str,
    arguments_sha256: str,
) -> bool:
    """GETDEL and validate an exact, gate-generated MCP success receipt."""

    try:
        receipt_key = mcp_execution_receipt_key(token)
    except ValueError:
        return False
    getdel = getattr(redis_client, "getdel", None)
    if callable(getdel):
        raw = getdel(receipt_key)
    else:
        raw = redis_client.eval(
            "local v=redis.call('GET',KEYS[1]); "
            "if v then redis.call('DEL',KEYS[1]) end; return v",
            1,
            receipt_key,
        )
    if not raw:
        return False
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(payload, dict):
        return False

    expected = {
        "user_id": _norm(user_id),
        "server_name": _norm(server_name),
        "tool_name": _norm(tool_name),
        "arguments_sha256": _norm(arguments_sha256),
        "action_type": "mcp_mutation",
    }
    return all(payload.get(field) == value for field, value in expected.items())


def canonicalize_mcp_arguments(arguments_json: str) -> tuple[str, str]:
    """Return canonical JSON plus its SHA-256 for an exact MCP argument object."""

    try:
        arguments = json.loads(arguments_json)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError("arguments_json must be a JSON object") from exc
    if not isinstance(arguments, dict):
        raise ValueError("arguments_json must be a JSON object")
    # Approval credentials are transported in trusted request metadata, never
    # through a remote MCP schema or as part of the approved argument object.
    arguments.pop("approval_token", None)
    canonical = json.dumps(
        arguments,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return canonical, digest


def _redact_argument_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): (
                "[REDACTED]"
                if _SENSITIVE_ARGUMENT_KEY.search(str(key))
                else _redact_argument_value(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_argument_value(item) for item in value]
    if isinstance(value, str) and _SENSITIVE_STRING_VALUE.search(value):
        return "[REDACTED]"
    return value


def redacted_mcp_arguments(canonical_arguments: str) -> str:
    """Render canonical MCP arguments for human review with secrets removed."""

    arguments = json.loads(canonical_arguments)
    return json.dumps(
        _redact_argument_value(arguments),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def create_pending_mcp_approval(
    redis_client: Any,
    *,
    user_id: str,
    action: str,
    reason: str,
    target: str,
    server_name: str,
    tool_name: str,
    arguments_json: str,
    ttl_seconds: int = DEFAULT_PENDING_APPROVAL_TTL_SECONDS,
) -> dict[str, Any]:
    """Persist an exact, non-executable MCP intent for later human approval."""

    normalized_user = _norm(user_id)
    normalized_target = _norm(target)
    normalized_server = _norm(server_name)
    normalized_tool = _norm(tool_name)
    if not normalized_user:
        raise ValueError("pending MCP approval requires an authenticated user")
    if not normalized_target or normalized_target == "*":
        raise ValueError("pending MCP approval requires an exact target")
    if not normalized_server or not normalized_tool:
        raise ValueError("pending MCP approval requires an exact server and tool")

    canonical_arguments, arguments_sha256 = canonicalize_mcp_arguments(arguments_json)
    request_id = secrets.token_urlsafe(18)
    payload = {
        "request_id": request_id,
        "user_id": normalized_user,
        "action_type": "mcp_mutation",
        "action": _norm(action),
        "reason": _norm(reason),
        "target": normalized_target,
        "server_name": normalized_server,
        "tool_name": normalized_tool,
        "canonical_arguments": canonical_arguments,
        "arguments_preview": redacted_mcp_arguments(canonical_arguments),
        "arguments_sha256": arguments_sha256,
        "created_at": int(time.time()),
    }
    redis_client.setex(
        pending_approval_key(normalized_user, request_id),
        max(1, int(ttl_seconds)),
        json.dumps(payload),
    )
    return payload


def build_redis_url(redis_url: str | None = None) -> str:
    explicit = _norm(redis_url)
    if explicit:
        return explicit
    env_url = _norm(os.getenv("REDIS_URL"))
    if env_url:
        port = _norm(os.getenv("REDIS_PORT"))
        if port and env_url.count(":") == 1 and "://" in env_url:
            return f"{env_url}:{port}"
        return env_url
    host = _norm(os.getenv("RI_REDIS_HOST_DAEDALUS"), "localhost")
    port = _norm(os.getenv("REDIS_PORT"), "6379")
    return f"redis://{host}:{port}"


def make_redis_client(redis_url: str | None = None):
    if redis is None:
        raise RuntimeError("redis package is unavailable")
    return redis.from_url(build_redis_url(redis_url), decode_responses=True)


def issue_approval_token(
    redis_client: Any,
    request: ApprovalRequest,
    ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
) -> str:
    user_id = _norm(request.user_id)
    action_type = _norm(request.action_type)
    target = _norm(request.target)
    if not user_id or not action_type:
        raise ValueError("approval credentials require an exact user and action")
    if not target or target == "*":
        raise ValueError("approval credentials cannot use a wildcard target")
    if action_type == "mcp_mutation":
        canonical_arguments = _norm(request.canonical_arguments)
        if (
            not _norm(request.server_name)
            or not _norm(request.tool_name)
            or not _norm(request.arguments_sha256)
            or not canonical_arguments
        ):
            raise ValueError(
                "MCP approval credentials require an exact server, tool, "
                "canonical arguments, and argument hash"
            )
        _, canonical_hash = canonicalize_mcp_arguments(canonical_arguments)
        if canonical_hash != _norm(request.arguments_sha256):
            raise ValueError("MCP approval canonical arguments do not match hash")

    token = secrets.token_urlsafe(18)
    payload = {
        "user_id": user_id,
        "action_type": action_type,
        "target": target,
        "server_name": _norm(request.server_name),
        "tool_name": _norm(request.tool_name),
        "arguments_sha256": _norm(request.arguments_sha256),
        "canonical_arguments": _norm(request.canonical_arguments),
        "created_at": int(time.time()),
    }
    redis_client.setex(
        approval_token_key(payload["user_id"], token),
        max(1, int(ttl_seconds)),
        json.dumps(payload),
    )
    return token


def validate_approval_token(
    redis_client: Any,
    *,
    user_id: str,
    token: str,
    action_type: str,
    target: str = "",
    server_name: str = "",
    tool_name: str = "",
    arguments_sha256: str = "",
    normalize_arguments_hash: Callable[[str], str] | None = None,
    consume: bool = True,
    on_validated: Callable[[dict[str, str]], None] | None = None,
) -> tuple[bool, str]:
    if not token:
        return False, "approval_token is required"

    key = approval_token_key(user_id, token)
    # Consume before validating so concurrent callers cannot both spend the
    # same credential. A mismatched attempt intentionally burns the token: a
    # credential presented for the wrong action is no longer trustworthy.
    if consume:
        getdel = getattr(redis_client, "getdel", None)
        if callable(getdel):
            raw = getdel(key)
        else:
            raw = redis_client.eval(
                "local v=redis.call('GET',KEYS[1]); "
                "if v then redis.call('DEL',KEYS[1]) end; return v",
                1,
                key,
            )
    else:
        raw = redis_client.get(key)
    if not raw:
        return False, "approval_token is missing, expired, or already used"

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return False, "approval_token payload is invalid"

    expected = ApprovalRequest(
        user_id=_norm(user_id),
        action_type=_norm(action_type),
        target=_norm(target),
        server_name=_norm(server_name),
        tool_name=_norm(tool_name),
        arguments_sha256=_norm(arguments_sha256),
    )
    # Retain the original approved-argument hash for downstream receipts. When
    # a remote schema supplies defaults, the normalized hash below proves the
    # executed call is equivalent, but the worker's protected execution record
    # is intentionally bound to this original hash.
    approved_arguments_sha256 = _norm(payload.get("arguments_sha256"))
    actual_arguments_sha256 = approved_arguments_sha256
    if action_type == "mcp_mutation" and normalize_arguments_hash is not None:
        canonical_arguments = payload.get("canonical_arguments")
        if not isinstance(canonical_arguments, str) or not canonical_arguments:
            return False, "approval_token canonical arguments are missing"
        try:
            actual_arguments_sha256 = _norm(
                normalize_arguments_hash(canonical_arguments)
            )
        except Exception:
            return False, "approval_token canonical arguments are invalid"

    actual = ApprovalRequest(
        user_id=_norm(payload.get("user_id")),
        action_type=_norm(payload.get("action_type")),
        target=_norm(payload.get("target")),
        server_name=_norm(payload.get("server_name")),
        tool_name=_norm(payload.get("tool_name")),
        arguments_sha256=actual_arguments_sha256,
    )

    if actual.user_id != expected.user_id:
        return False, "approval_token user mismatch"
    if actual.action_type != expected.action_type:
        return False, "approval_token action mismatch"
    # An MCP credential is already bound to the complete canonical argument
    # object. Deriving a second target from a remote tool schema is both
    # redundant and unreliable (for example, Kubernetes uses namespace+name).
    # Keep target binding for other consequential actions, where there is no
    # full argument hash, and retain the MCP target in the credential as an
    # auditable human-facing label.
    if expected.action_type != "mcp_mutation":
        if not expected.target or actual.target != expected.target:
            return False, "approval_token target mismatch"
    if actual.server_name != expected.server_name:
        return False, "approval_token server mismatch"
    if actual.tool_name != expected.tool_name:
        return False, "approval_token tool mismatch"
    if actual.arguments_sha256 != expected.arguments_sha256:
        return False, "approval_token arguments mismatch"

    if on_validated is not None:
        on_validated(
            {
                "user_id": actual.user_id,
                "action_type": actual.action_type,
                "target": _norm(payload.get("target")),
                "server_name": actual.server_name,
                "tool_name": actual.tool_name,
                "arguments_sha256": approved_arguments_sha256,
            }
        )
    return True, "approved"
