"""Helpers for carrying authenticated identity through nested agent calls."""

import logging
import re

logger = logging.getLogger(__name__)

_IDENTITY_USER_ID_RE = re.compile(r"\buser_id\s*=\s*[\"']([^\"']+)[\"']")
_IDENTITY_AUTHENTICATED_USER_RE = re.compile(
    r"authenticated user(?: for this (?:session|delegated task))? is:\s*([^\s.]+)",
    re.IGNORECASE,
)
_IGNORED_ARG_TOOLS = {
    "current_datetime": "unused",
    "current_datetime_tool": "unused",
}
_USER_SCOPED_AGENT_TOOLS = {
    "daily_summary_agent",
    "ops_agent",
    "user_document_agent",
    "user_data_agent",
}
_USER_SCOPED_DIRECT_TOOLS = {
    "visual_media",
    "visual_media_tool",
    "vtt_interpreter",
    "vtt_interpreter_tool",
}


def _message_content_to_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                for key in ("text", "content"):
                    value = item.get(key)
                    if isinstance(value, str):
                        parts.append(value)
        return "\n".join(parts)
    return ""


def _extract_identity_user_id(messages) -> str | None:
    # SECURITY: scan forward (oldest -> newest) and accept the FIRST [IDENTITY]
    # marker only. The trusted marker is injected by the frontend at index 0,
    # ahead of any user-authored turns. Scanning in reverse (newest first) would
    # let a user spoof identity by typing their own `[IDENTITY] ... user_id="x"`
    # line, which sits at a higher index and would otherwise win. Identity must
    # not be derived from later, user-controlled message prose.
    for message in messages:
        raw_content = (
            message.get("content")
            if isinstance(message, dict)
            else getattr(message, "content", None)
        )
        content = _message_content_to_text(raw_content)
        if "[IDENTITY]" not in content:
            continue

        match = _IDENTITY_USER_ID_RE.search(content)
        if match:
            return match.group(1).strip()

        match = _IDENTITY_AUTHENTICATED_USER_RE.search(content)
        if match:
            return match.group(1).strip().strip(",;")
        # First [IDENTITY] marker found but unparseable: stop rather than
        # falling through to a later, user-controlled marker.
        return None
    return None


def _prepend_identity_to_agent_args(args: dict, user_id: str) -> None:
    identity_line = (
        "[IDENTITY] The authenticated user for this delegated task is: "
        f'{user_id}. Use user_id="{user_id}" for user-scoped tool calls.'
    )
    for key in ("input_message", "input", "query", "task_description"):
        value = args.get(key)
        if isinstance(value, str):
            if identity_line not in value:
                args[key] = f"{identity_line}\n\n{value}"
            return
    args["input_message"] = identity_line


def normalize_tool_call_args(message):
    """Normalize tool-call args for tools with misleading runtime schemas."""
    tool_calls = getattr(message, "tool_calls", None)
    if not tool_calls:
        return message

    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue

        name = str(tool_call.get("name") or "")
        ignored_arg = _IGNORED_ARG_TOOLS.get(name)
        if ignored_arg is None:
            continue

        args = tool_call.get("args")
        ignored_value = (
            args.get(ignored_arg)
            if isinstance(args, dict) and args.get(ignored_arg)
            else ignored_arg
        )
        normalized_args = {ignored_arg: str(ignored_value)}
        if args != normalized_args:
            logger.info("Normalizing args for ignored-argument tool '%s'", name)
            tool_call["args"] = normalized_args

    return message


def propagate_identity_to_tool_calls(message, state_messages):
    """Carry authenticated identity into delegated user-scoped tool calls."""
    tool_calls = getattr(message, "tool_calls", None)
    if not tool_calls:
        return message

    user_id = _extract_identity_user_id(state_messages)
    if not user_id:
        return message

    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        name = str(tool_call.get("name") or "")
        args = tool_call.get("args")
        if not isinstance(args, dict):
            continue

        if name in _USER_SCOPED_AGENT_TOOLS:
            _prepend_identity_to_agent_args(args, user_id)
        if name in _USER_SCOPED_DIRECT_TOOLS:
            args["user_id"] = user_id

    return message
