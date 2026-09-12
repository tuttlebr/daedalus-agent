"""Backend API client used by the autonomous worker."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import threading
from typing import Any
from urllib.parse import quote

import httpx

_AUTH_URL_RE = re.compile(r"https?://[^\s<>\")]+")
MAX_RESPONSE_CHARS = 4 * 1024 * 1024
DEFAULT_TIMEZONE = "America/New_York"


class RunAbortedError(RuntimeError):
    """The in-flight backend request was stopped before it produced an answer."""


class OAuthRequiredError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        auth_url: str = "",
        oauth_state: str = "",
    ) -> None:
        super().__init__(message)
        self.auth_url = auth_url
        self.oauth_state = oauth_state


def _looks_like_oauth_text(text: str) -> bool:
    lowered = text.lower()
    auth_terms = ("oauth", "authorization", "authorize", "authenticate", "auth")
    required_terms = (
        "required",
        "needed",
        "missing",
        "expired",
        "connect",
        "login",
        "unauthenticated",
        "unauthorized",
    )
    return any(term in lowered for term in auth_terms) and any(
        term in lowered for term in required_terms
    )


def _extract_auth_url_from_text(text: str) -> str:
    if not _looks_like_oauth_text(text):
        return ""
    for raw_url in _AUTH_URL_RE.findall(text):
        url = raw_url.rstrip(".,;")
        lowered = url.lower()
        if "oauth" in lowered or "auth" in lowered or "accounts.google.com" in lowered:
            return url
    return ""


def extract_oauth_required_payload(
    event_name: str | None,
    parsed: Any,
) -> dict[str, str] | None:
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError:
            auth_url = _extract_auth_url_from_text(parsed)
            if auth_url:
                return {"auth_url": auth_url}
            return None

    if not isinstance(parsed, dict):
        return None

    candidates: list[dict[str, Any]] = [parsed]
    for key_name in ("data", "payload", "metadata"):
        value = parsed.get(key_name)
        if isinstance(value, dict):
            candidates.append(value)

    is_oauth_event = event_name == "oauth_required"
    for candidate in candidates:
        event_type = (
            candidate.get("event_type")
            or candidate.get("type")
            or candidate.get("event")
        )
        if event_type == "oauth_required":
            is_oauth_event = True

    auth_url = ""
    oauth_state = ""
    for candidate in candidates:
        auth_url = str(
            candidate.get("auth_url")
            or candidate.get("authUrl")
            or candidate.get("authorization_url")
            or ""
        )
        oauth_state = str(
            candidate.get("oauth_state")
            or candidate.get("oauthState")
            or candidate.get("state")
            or ""
        )
        if auth_url:
            break

    if is_oauth_event and auth_url:
        return {
            "auth_url": auth_url,
            **({"oauth_state": oauth_state} if oauth_state else {}),
        }

    for candidate in candidates:
        for value in candidate.values():
            if isinstance(value, str):
                auth_url = _extract_auth_url_from_text(value)
                if auth_url:
                    return {"auth_url": auth_url}

    return None


class BackendClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_path: str,
        user_id: str,
        request_timeout: int = 3600,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_path = api_path
        self.user_id = user_id
        self.request_timeout = request_timeout

    def call(
        self,
        messages: list[dict[str, str]],
        *,
        execution_id: str = "",
        abort: threading.Event | None = None,
    ) -> str:
        return self._call_stream(
            messages,
            execution_id=execution_id,
            abort=abort,
        )

    def _headers(self, *, execution_id: str = "") -> dict[str, str]:
        # Share Chat's stable OAuth identity (frontend/server/chat/natMessages.ts).
        # The queue owner remains the username; only NAT's session key is hashed.
        nat_session = (
            "daedalus-user-"
            + hashlib.sha256(self.user_id.encode("utf-8")).hexdigest()[:32]
        )
        headers = {
            "x-user-id": self.user_id,
            "x-timezone": DEFAULT_TIMEZONE,
            # Mark background work so interactive approval tools reject it.
            # Human-approved MCP mutations are handled only by interactive chat.
            "x-daedalus-execution-scope": "autonomy",
            "Cookie": f"nat-session={quote(nat_session, safe='')}",
        }
        token = os.getenv("DAEDALUS_INTERNAL_API_TOKEN", "").strip()
        if token:
            headers["x-daedalus-internal-token"] = token
        if execution_id.strip():
            headers["x-daedalus-execution-id"] = execution_id.strip()
        return headers

    def _call_stream(
        self,
        messages: list[dict[str, str]],
        *,
        execution_id: str = "",
        abort: threading.Event | None = None,
    ) -> str:
        async def run():
            async def check_abort():
                while abort is None or not abort.is_set():
                    await asyncio.sleep(0.05)
                raise RunAbortedError("backend request aborted")

            if abort is not None and abort.is_set():
                raise RunAbortedError("backend request aborted")
            reader = asyncio.create_task(
                self._read_stream(messages, execution_id=execution_id)
            )
            cancellation = asyncio.create_task(check_abort())
            try:
                done, _ = await asyncio.wait(
                    (reader, cancellation),
                    timeout=self.request_timeout,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    raise RunAbortedError(
                        f"backend request exceeded {self.request_timeout}s"
                    )
                # A cancellation wins if both tasks finish in the same tick.
                if cancellation in done:
                    return cancellation.result()
                return reader.result()
            finally:
                reader.cancel()
                cancellation.cancel()
                await asyncio.gather(reader, cancellation, return_exceptions=True)

        return asyncio.run(run())

    async def _read_stream(self, messages, *, execution_id):
        url = f"{self.base_url}{self.api_path}"
        payload = {
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        full = ""
        current_sse_event: str | None = None
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            async with client.stream(
                "POST",
                url,
                json=payload,
                headers=self._headers(execution_id=execution_id),
            ) as resp:
                resp.raise_for_status()
                resp.encoding = "utf-8"
                async for line in resp.aiter_lines():
                    if not line:
                        current_sse_event = None
                        continue
                    if line.startswith("event: "):
                        current_sse_event = line[len("event: ") :].strip()
                        continue
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    oauth_payload = extract_oauth_required_payload(
                        current_sse_event,
                        chunk,
                    )
                    if oauth_payload:
                        raise OAuthRequiredError(
                            "OAuth authorization is required.",
                            auth_url=oauth_payload.get("auth_url", ""),
                            oauth_state=oauth_payload.get("oauth_state", ""),
                        )
                    for choice in chunk.get("choices", []):
                        content = choice.get("delta", {}).get("content", "")
                        if content:
                            full += content
                    if len(full) > MAX_RESPONSE_CHARS:
                        raise RunAbortedError(
                            f"backend response exceeded {MAX_RESPONSE_CHARS} characters"
                        )
        return full
