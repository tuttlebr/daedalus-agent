"""Tests for token-aware inbound conversation history selection."""

import json
import math
import random

import pytest
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


@pytest.mark.parametrize("offset", [-1, 0, 1])
def test_history_budget_boundary_counts_utf8_bytes(offset):
    messages = [
        {"role": "user", "content": "界😀" * 37},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "next"},
    ]
    # Derive the declared byte budget independently; never ask the estimator
    # under test for an expected boundary.
    boundary = sum(
        8
        + math.ceil(
            len(
                json.dumps(m, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            )
            / 3
        )
        for m in messages
    )
    assert _select_history_payloads(
        messages, max_messages=3, max_tokens=boundary + offset
    ) == (messages if offset >= 0 else messages[-1:])


def test_structured_history_matches_exhaustive_valid_suffix_reference():
    rng = random.Random(20260909)
    for _ in range(400):
        messages = []
        for turn in range(rng.randrange(1, 9)):
            messages.append(
                {
                    "role": "user",
                    "content": rng.choice(["a", "界", "😀"]) * rng.randrange(1, 80),
                }
            )
            if rng.choice([True, False]):
                messages.extend(
                    [
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": f"call-{turn}",
                                    "type": "function",
                                    "function": {"name": "lookup", "arguments": "{}"},
                                }
                            ],
                        },
                        {
                            "role": "tool",
                            "tool_call_id": f"call-{turn}",
                            "content": "result " * rng.randrange(1, 12),
                        },
                    ]
                )
            messages.append(
                {"role": "assistant", "content": "answer " * rng.randrange(1, 30)}
            )
        messages.append({"role": "user", "content": "current " * rng.randrange(1, 100)})
        max_messages = rng.randrange(1, len(messages) + 2)
        sizes = [
            8
            + math.ceil(
                len(
                    json.dumps(m, ensure_ascii=False, separators=(",", ":")).encode(
                        "utf-8"
                    )
                )
                / 3
            )
            for m in messages
        ]
        # Concentrate on suffix boundaries, not overwhelmingly rejected inputs.
        max_tokens = max(
            1, sum(sizes[rng.randrange(len(sizes)) :]) + rng.choice([-1, 0, 1])
        )
        valid_suffixes = [
            messages[start:]
            for start in range(len(messages))
            if len(messages) - start <= max_messages
            and sum(sizes[start:]) <= max_tokens
            and messages[start]["role"] == "user"
        ]
        expected = max(valid_suffixes, key=len, default=messages[-1:])
        assert (
            _select_history_payloads(
                messages, max_messages=max_messages, max_tokens=max_tokens
            )
            == expected
        )
