"""Helpers for carrying authenticated identity through nested agent calls."""

import re

_IDENTITY_USER_ID_RE = re.compile(r"\buser_id\s*=\s*[\"']([^\"']+)[\"']")
_IDENTITY_AUTHENTICATED_USER_RE = re.compile(
    r"authenticated user(?: for this (?:session|delegated task))? is:\s*([^\s.]+)",
    re.IGNORECASE,
)
_USER_SCOPED_AGENT_TOOLS = {
    "media_agent",
    "ops_agent",
    "user_document_agent",
    "user_data_agent",
}
_USER_SCOPED_DIRECT_TOOLS = {
    "visual_media",
    "visual_media_tool",
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
    for message in reversed(messages):
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
