"""Current date/time in the authenticated caller's timezone."""

from datetime import datetime
from zoneinfo import ZoneInfo

from nat_helpers.identity import trusted_request_header_from_context

from .tools import ToolConfig, ToolDefinition, register_tool


class DateTimeConfig(ToolConfig, name="current_datetime"):
    timezone: str = "UTC"


@register_tool(config_type=DateTimeConfig)
async def current_datetime(config, _registry):
    async def now() -> str:
        timezone = trusted_request_header_from_context("x-timezone") or config.timezone
        return datetime.now(ZoneInfo(timezone)).isoformat()

    yield ToolDefinition.from_fn(now, description=config.description)
