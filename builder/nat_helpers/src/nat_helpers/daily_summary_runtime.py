"""Request profiling and research-budget controls for interactive briefings."""

import time

from nat_helpers.daedalus_memory_tools import _is_daily_briefing_query

DAILY_SUMMARY_PROFILE = "daily_summary"
DAILY_SUMMARY_SYNTHESIS_INSTRUCTION = (
    "The daily-summary research budget has ended. Do not make more source or "
    "memory calls. Use only the evidence already collected in this turn. If no "
    "successful briefing_renderer_tool result exists, call it now with the best "
    "supported edition. If rendering cannot succeed, return the sourced plain-text "
    "fallback required by the daily-summary skill. Do not restart research and omit "
    "unsupported claims."
)


def request_profile(user_text: str) -> str:
    """Classify only the explicit daily-summary triggers used by its contract."""

    return DAILY_SUMMARY_PROFILE if _is_daily_briefing_query(user_text) else "default"


def should_start_final_synthesis(run, *, budget_seconds: float) -> bool:
    """Return whether a briefing has spent its complete research allowance."""

    return bool(
        run is not None
        and run.request_profile == DAILY_SUMMARY_PROFILE
        and not run.final_synthesis_requested
        and run.tool_calls > 0
        and time.monotonic() - run.started_at >= budget_seconds
    )


def should_retry_final_synthesis(run, error: BaseException) -> bool:
    """Allow one synthesis-only retry after a model stream stops prematurely."""

    return bool(
        run is not None
        and run.request_profile == DAILY_SUMMARY_PROFILE
        and run.tool_calls > 0
        and bool(run.last_messages)
        and not run.synthesis_retry_attempted
        and (
            type(error).__name__
            in {
                "IncompleteAgentRun",
                "StreamChunkTimeoutError",
                "TimeoutError",
            }
            or run.stop_reason == "incomplete_model_response"
        )
    )
