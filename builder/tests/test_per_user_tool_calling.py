"""Tests for token-aware inbound conversation history selection."""

from nat_helpers.history_budget import (
    _estimate_history_tokens,
    _select_history_payloads,
)


def test_history_selection_drops_oversized_old_turn_before_current_request():
    messages = [
        {"role": "user", "content": "old question " + ("x" * 24_000)},
        {"role": "assistant", "content": "old answer " + ("y" * 24_000)},
        {"role": "user", "content": "current request"},
    ]

    selected = _select_history_payloads(
        messages,
        max_messages=50,
        max_tokens=1000,
    )

    assert selected == [{"role": "user", "content": "current request"}]
    assert _estimate_history_tokens(selected) <= 1000


def test_history_selection_never_silently_drops_oversized_current_request():
    current = {"role": "user", "content": "z" * 12_000}

    selected = _select_history_payloads(
        [current],
        max_messages=50,
        max_tokens=1000,
    )

    assert selected == [current]
    assert _estimate_history_tokens(selected) > 1000


def test_history_selection_enforces_runtime_budget_across_fifty_messages():
    messages = [
        {
            "role": "user" if index % 2 == 0 else "assistant",
            "content": f"message-{index}:" + ("x" * 4000),
        }
        for index in range(49)
    ]
    current = {"role": "user", "content": "current request"}
    messages.append(current)

    selected = _select_history_payloads(
        messages,
        max_messages=50,
        max_tokens=32_000,
    )

    assert len(selected) < len(messages)
    assert selected[-1] == current
    assert selected[0]["role"] == "user"
    assert _estimate_history_tokens(selected) <= 32_000
