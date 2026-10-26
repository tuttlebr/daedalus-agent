"""Evaluation-only source transport guards and model-call attribution.

Only URLs present in the frozen case can be fetched, and those requests go to
the fixture's loopback server. The real configured verification critic still
runs through the captured model proxy; this module never supplies a verdict.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any
from urllib.parse import urlsplit

VERIFIER_SYSTEM_PREFIX = (
    "Role: source-verification critic.\n\n"
    "Goal: fact-check one precise claim against only the supplied source content.\n\n"
    "Rules:\n"
)


def _text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            item["text"]
            for item in content
            if isinstance(item, dict)
            and item.get("type") in {"text", "input_text"}
            and isinstance(item.get("text"), str)
        )
    return ""


def is_verifier_model_request(body: Any) -> bool:
    """Attribute the actual critic's system prompt, never quoted user evidence.

    This is an observability label. It grants no tool, context, or destination
    permission and must not be used for authorization.
    """
    if not isinstance(body, dict):
        return False
    instructions = body.get("instructions")
    if isinstance(instructions, str) and instructions.startswith(
        VERIFIER_SYSTEM_PREFIX
    ):
        return True
    for field in ("messages", "input"):
        messages = body.get(field)
        if not isinstance(messages, list):
            continue
        for item in messages:
            if (
                isinstance(item, dict)
                and item.get("role") in {"system", "developer"}
                and _text_content(item.get("content")).startswith(
                    VERIFIER_SYSTEM_PREFIX
                )
            ):
                return True
    return False


def _source_urls(values: Any) -> frozenset[str]:
    if not isinstance(values, (list, tuple, set, frozenset)):
        raise ValueError("frozen source URLs must be an explicit collection")
    for value in values:
        if not isinstance(value, str) or value != value.strip():
            raise ValueError("frozen source URL is invalid")
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or any(character.isspace() for character in value)
        ):
            raise ValueError("frozen source URL must be credential-free HTTPS")
    return frozenset(values)


def _loopback_origin(endpoint: str) -> str:
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.port is None
        or not 1 <= parsed.port <= 65535
    ):
        raise ValueError("fixture source origin must be explicit loopback HTTP")
    return endpoint.rstrip("/")


def install_verifier_boundaries(
    allowed_urls: Any, endpoint: str, *, verifier_module: Any = None
) -> dict[str, Any]:
    """Keep frozen placeholder sources usable without opening real web access.

    Installed only in disposable evaluation containers after leaf fixtures.
    Unknown URLs fail before client construction or DNS. Known source content
    remains evidence for the unchanged critic, including unsupported claims.
    """
    allowed = _source_urls(allowed_urls)
    origin = _loopback_origin(endpoint)
    if verifier_module is None:
        import source_verifier.source_verifier_function as verifier_module

    def placeholder(url: str) -> bool:
        return url not in allowed

    def audit_url(url: str) -> tuple[bool, str | None]:
        return (
            (True, None) if url in allowed else (False, "outside_frozen_source_ledger")
        )

    async def fetch(url: str, config: Any):
        if url not in allowed:
            return verifier_module.FetchResult(
                status="invalid_url",
                error="URL is outside the frozen source ledger",
            )
        import httpx

        try:
            async with httpx.AsyncClient(
                timeout=config.fetch_timeout,
                trust_env=False,
                follow_redirects=False,
            ) as client:
                response = await client.get(origin + "/source", params={"url": url})
                response.raise_for_status()
            return verifier_module.FetchResult(status="ok", content=response.text)
        except httpx.HTTPError:
            return verifier_module.FetchResult(
                status="unreachable", error="Frozen source is unavailable"
            )

    verifier_module._is_placeholder_source = placeholder
    verifier_module._safe_audit_url = audit_url
    verifier_module._fetch_source = fetch
    return {
        "kind": "frozen_verifier_source_transport",
        "allowed_source_count": len(allowed),
        "allowed_source_urls_sha256": hashlib.sha256(
            json.dumps(sorted(allowed), separators=(",", ":")).encode()
        ).hexdigest(),
        "source_destination": "explicit_loopback_fixture",
        "unknown_urls": "rejected_before_network",
        "external_dns": False,
        "critic": "actual_configured_model",
        "verdict_substitution": False,
    }
