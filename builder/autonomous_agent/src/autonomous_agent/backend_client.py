"""Backend API client used by the autonomous worker."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any
from urllib.parse import quote

import requests

_AUTH_URL_RE = re.compile(r"https?://[^\s<>\")]+")


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


def extract_async_output(output: Any) -> str:
    if not output:
        return ""
    if isinstance(output, str):
        return output
    if isinstance(output, dict) and "value" in output:
        return str(output["value"])
    return json.dumps(output)


def extract_async_job_id(payload: Any, fallback: str) -> str:
    if not isinstance(payload, dict):
        return fallback

    for key in ("job_id", "jobId", "id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    for key in ("job", "data"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            value = extract_async_job_id(nested, "")
            if value:
                return value

    return fallback


def messages_to_input_message(messages: list[dict[str, str]]) -> str:
    """Flatten chat-style messages for the async generate endpoint.

    ``/v1/workflow/async`` accepts a single ``input_message`` string, unlike
    the OpenAI-compatible chat route. Keep role labels so any non-user context
    remains legible if future callers pass mixed roles.
    """
    parts: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        role = str(message.get("role") or "user").strip().upper() or "USER"
        parts.append(f"[{role}]\n{content}")
    return "\n\n".join(parts)


def raise_for_status_with_body(resp: requests.Response) -> None:
    try:
        resp.raise_for_status()
    except requests.HTTPError as exc:
        body = (resp.text or "").strip()
        if len(body) > 1000:
            body = f"{body[:997]}..."
        detail = f"{exc}; response={body}" if body else str(exc)
        raise requests.HTTPError(detail, response=resp) from exc


class BackendClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_path: str,
        user_id: str,
        request_timeout: int = 3600,
        poll_interval: int = 10,
        expiry_seconds: int = 3600,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_path = api_path
        self.user_id = user_id
        self.request_timeout = request_timeout
        self.poll_interval = poll_interval
        self.expiry_seconds = expiry_seconds

    def call(self, messages: list[dict[str, str]]) -> str:
        if "/v1/workflow/async" in self.api_path:
            try:
                return self._call_async(messages)
            except OAuthRequiredError as exc:
                if exc.auth_url:
                    raise
                try:
                    return self._call_stream(messages, api_path="/v1/chat/completions")
                except OAuthRequiredError:
                    raise
                except Exception:
                    raise exc
        return self._call_stream(messages)

    def _headers(self) -> dict[str, str]:
        headers = {
            "x-user-id": self.user_id,
            "Cookie": f"nat-session={quote(self.user_id, safe='')}",
        }
        token = os.getenv("DAEDALUS_INTERNAL_API_TOKEN", "").strip()
        if token:
            headers["x-daedalus-internal-token"] = token
        return headers

    def _call_stream(
        self,
        messages: list[dict[str, str]],
        *,
        api_path: str | None = None,
    ) -> str:
        url = f"{self.base_url}{api_path or self.api_path}"
        payload = {
            "messages": messages,
            "stream": True,
            "user_id": self.user_id,
            "stream_options": {"include_usage": True},
        }
        full = ""
        current_sse_event: str | None = None
        with requests.post(
            url,
            json=payload,
            headers=self._headers(),
            stream=True,
            timeout=self.request_timeout,
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines(decode_unicode=True):
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
        return full

    def _call_async(self, messages: list[dict[str, str]]) -> str:
        job_id = str(uuid.uuid4())
        submit_url = f"{self.base_url}{self.api_path}"
        payload = {
            "input_message": messages_to_input_message(messages),
            "job_id": job_id,
            "sync_timeout": 0,
            "expiry_seconds": self.expiry_seconds,
        }
        resp = requests.post(
            submit_url,
            json=payload,
            headers=self._headers(),
            timeout=45,
        )
        raise_for_status_with_body(resp)
        try:
            job_id = extract_async_job_id(resp.json(), job_id)
        except ValueError:
            pass

        status_url = f"{self.base_url}/v1/workflow/async/job/{job_id}"
        deadline = time.monotonic() + self.request_timeout
        last_error: str | None = None
        consecutive_not_found = 0
        consecutive_network_errors = 0
        while time.monotonic() < deadline:
            time.sleep(self.poll_interval)
            try:
                status_resp = requests.get(
                    status_url,
                    headers=self._headers(),
                    timeout=30,
                )
                if status_resp.status_code == 404:
                    consecutive_network_errors = 0
                    consecutive_not_found += 1
                    last_error = (
                        f"backend async job {job_id} was not found after "
                        "successful submission"
                    )
                    if consecutive_not_found >= 3:
                        raise RuntimeError(last_error)
                    continue
                consecutive_not_found = 0
                status_resp.raise_for_status()
                job = status_resp.json()
                consecutive_network_errors = 0
            except RuntimeError:
                raise
            except requests.RequestException as exc:
                # F-014: an unreachable backend would otherwise keep retrying
                # until the ~1h deadline, pinning a worker thread on one job.
                # Fast-fail after a few consecutive connection errors (mirrors
                # the 404 fast-fail); the counter resets on any successful poll.
                consecutive_network_errors += 1
                last_error = str(exc)
                if consecutive_network_errors >= 3:
                    raise
                continue

            status = job.get("status")
            oauth_payload = (
                extract_oauth_required_payload(None, job)
                or extract_oauth_required_payload(None, job.get("output"))
                or extract_oauth_required_payload(
                    None,
                    str(job.get("error") or ""),
                )
            )
            if oauth_payload:
                raise OAuthRequiredError(
                    str(job.get("error") or "OAuth authorization is required."),
                    auth_url=oauth_payload.get("auth_url", ""),
                    oauth_state=oauth_payload.get("oauth_state", ""),
                )
            if status == "success":
                return extract_async_output(job.get("output"))
            if status in {"failure", "interrupted"}:
                error = str(job.get("error") or f"backend job {status}")
                if _looks_like_oauth_text(error):
                    raise OAuthRequiredError(error)
                raise RuntimeError(error)

        raise TimeoutError(
            last_error or f"backend job timed out after {self.request_timeout}s"
        )
