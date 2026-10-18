"""Request profiling for interactive briefings."""

from nat_helpers.daedalus_memory_tools import _is_daily_briefing_query

DAILY_SUMMARY_PROFILE = "daily_summary"


def request_profile(user_text: str, *, autonomous: bool = False) -> str:
    """Classify interactive requests; background context is not a user command."""

    if autonomous:
        return "default"

    return DAILY_SUMMARY_PROFILE if _is_daily_briefing_query(user_text) else "default"
