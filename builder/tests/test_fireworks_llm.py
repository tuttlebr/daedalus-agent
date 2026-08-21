"""Contracts for provider-neutral routed Responses replay."""

from nat_helpers.responses_replay import _normalize_responses_replay_items


def test_replay_removes_upstream_item_ids_and_preserves_tool_linkage():
    payload = {
        "input": [
            {
                "type": "reasoning",
                "id": "rs_upstream_only",
                "summary": [],
                "status": "completed",
            },
            {
                "type": "function_call",
                "id": "fc_upstream_only",
                "call_id": "call_portable",
                "name": "lookup",
                "arguments": "{}",
                "status": "completed",
            },
            {
                "type": "function_call_output",
                "call_id": "call_portable",
                "output": "result",
            },
        ]
    }

    normalized = _normalize_responses_replay_items(payload)

    assert all("id" not in item for item in normalized["input"])
    assert all("status" not in item for item in normalized["input"])
    assert normalized["input"][1]["call_id"] == "call_portable"
    assert normalized["input"][2]["call_id"] == "call_portable"


def test_replay_leaves_non_item_input_unchanged():
    payload = {"input": "plain prompt", "metadata": {"request": "kept"}}

    assert _normalize_responses_replay_items(payload) == payload
