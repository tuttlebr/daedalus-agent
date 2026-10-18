"""Daily-summary request routing contracts."""

from nat_helpers.daily_summary_runtime import DAILY_SUMMARY_PROFILE, request_profile


def test_only_explicit_daily_briefing_requests_select_the_narrow_profile():
    assert request_profile("Please run my daily summary") == DAILY_SUMMARY_PROFILE
    assert request_profile("Run my morning briefing") == DAILY_SUMMARY_PROFILE
    assert request_profile("Catch me up on today") == DAILY_SUMMARY_PROFILE
    assert request_profile("Debug the summary endpoint") == "default"


def test_autonomy_context_never_enables_interactive_briefing_policy():
    for text in (
        "daily summary personal profile priorities interests",
        "The previous run published a morning briefing.",
        "Catch me up on today",
    ):
        assert request_profile(text, autonomous=True) == "default"
