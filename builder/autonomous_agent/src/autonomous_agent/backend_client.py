"""Backend API client used by the autonomous worker."""

from __future__ import annotations

import asyncio
import json
import os
import threading

import httpx

from .prompt import output_schema

MAX_RESPONSE_CHARS = 4 * 1024 * 1024
DEFAULT_TIMEZONE = "America/Detroit"


class RunAbortedError(RuntimeError):
    """The in-flight backend request was stopped before it produced an answer."""


class ApprovalRequiredError(RuntimeError):
    """The backend stopped at an approval boundary.

    The Rust gate ends such a run with ``finish_reason`` ``mcp_approval_required``
    and a dedicated SSE event carrying the approval marker. Autonomous work is
    non-interactive, so the worker records the refusal instead of a result.
    """


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
        charter_task: dict,
    ) -> str:
        return self._call_stream(
            messages,
            execution_id=execution_id,
            abort=abort,
            charter_task=charter_task,
        )

    def _headers(self, *, execution_id: str = "") -> dict[str, str]:
        # The backend derives every per-user grant, including Chat's Google
        # authorization, from this authenticated identity header.
        headers = {
            "x-user-id": self.user_id,
            "x-timezone": DEFAULT_TIMEZONE,
            # Mark background work so interactive approval tools reject it.
            # Human-approved MCP mutations are handled only by interactive chat.
            "x-daedalus-execution-scope": "autonomy",
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
        charter_task: dict,
    ) -> str:
        async def run():
            async def check_abort():
                while abort is None or not abort.is_set():
                    await asyncio.sleep(0.05)
                raise RunAbortedError("backend request aborted")

            if abort is not None and abort.is_set():
                raise RunAbortedError("backend request aborted")
            reader = asyncio.create_task(
                self._read_stream(
                    messages, execution_id=execution_id, charter_task=charter_task
                )
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

    async def _read_stream(self, messages, *, execution_id, charter_task):
        url = f"{self.base_url}{self.api_path}"
        payload = {
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            "response_mode": "final_only",
            "autonomy_output_schema": output_schema(),
            "autonomy_task": charter_task,
        }
        parts: list[str] = []
        response_chars = 0
        completed = False
        current_sse_event: str | None = None
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            async with client.stream(
                "POST",
                url,
                json=payload,
                headers=self._headers(execution_id=execution_id),
            ) as resp:
                try:
                    resp.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    # The run record is user-visible; keep the internal URL
                    # and provider status text out of it.
                    raise RunAbortedError(
                        f"backend returned HTTP {exc.response.status_code}"
                    ) from None
                resp.encoding = "utf-8"
                async for line in resp.aiter_lines():
                    if not line:
                        current_sse_event = None
                        continue
                    if line.startswith("event:"):
                        current_sse_event = line[len("event:") :].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].removeprefix(" ")
                    if data.strip() == "[DONE]":
                        completed = True
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError as exc:
                        raise RunAbortedError(
                            "backend sent an invalid stream event"
                        ) from exc
                    if not isinstance(chunk, dict):
                        raise RunAbortedError("backend sent an invalid stream event")
                    if current_sse_event == "error" or chunk.get("error"):
                        raise RunAbortedError("backend stream reported an error")
                    if current_sse_event == "mcp_approval_required":
                        raise ApprovalRequiredError(
                            "The backend requires user approval to continue."
                        )
                    if current_sse_event == "oauth_required":
                        raise OAuthRequiredError(
                            "OAuth authorization is required.",
                            auth_url=str(chunk.get("auth_url", "")),
                            oauth_state=str(chunk.get("oauth_state", "")),
                        )
                    choices = chunk.get("choices", [])
                    if not isinstance(choices, list):
                        raise RunAbortedError("backend sent an invalid stream event")
                    for choice in choices:
                        if not isinstance(choice, dict):
                            raise RunAbortedError(
                                "backend sent an invalid stream event"
                            )
                        finish_reason = choice.get("finish_reason")
                        terminal = choice.get("daedalus_terminal", False)
                        delta = choice.get("delta", {})
                        if (
                            (
                                finish_reason is not None
                                and not isinstance(finish_reason, str)
                            )
                            or not isinstance(terminal, bool)
                            or not isinstance(delta, dict)
                        ):
                            raise RunAbortedError(
                                "backend sent an invalid stream event"
                            )
                        if finish_reason == "error":
                            raise RunAbortedError("backend stream reported an error")
                        if finish_reason == "mcp_approval_required":
                            raise ApprovalRequiredError(
                                "The backend requires user approval to continue."
                            )
                        content = delta.get("content")
                        if content is not None and not isinstance(content, str):
                            raise RunAbortedError(
                                "backend sent an invalid stream event"
                            )
                        if content:
                            parts.append(content)
                            response_chars += len(content)
                        completed = completed or terminal or bool(finish_reason)
                    if response_chars > MAX_RESPONSE_CHARS:
                        raise RunAbortedError(
                            f"backend response exceeded {MAX_RESPONSE_CHARS} characters"
                        )
                    # The explicit terminal confirms the result before provider
                    # teardown; do not wait for [DONE] or transport EOF afterward.
                    if completed:
                        break
        if not completed:
            raise RunAbortedError("backend stream ended before completion")
        return "".join(parts)
