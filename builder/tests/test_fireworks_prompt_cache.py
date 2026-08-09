"""Contracts for request-scoped Fireworks prompt-cache routing."""

import asyncio
from types import SimpleNamespace

from nat_helpers import fireworks_prompt_cache as prompt_cache


def test_prompt_cache_headers_are_stable_opaque_and_scoped(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "test-internal-secret")

    first = prompt_cache.build_fireworks_prompt_cache_headers("alice", "chat-a")
    repeated = prompt_cache.build_fireworks_prompt_cache_headers("alice", "chat-a")
    other_chat = prompt_cache.build_fireworks_prompt_cache_headers("alice", "chat-b")
    other_user = prompt_cache.build_fireworks_prompt_cache_headers("bob", "chat-a")

    assert first == repeated
    assert set(first) == {
        "x-session-affinity",
        "x-prompt-cache-isolation-key",
    }
    assert first["x-session-affinity"] != other_chat["x-session-affinity"]
    assert (
        first["x-prompt-cache-isolation-key"]
        == other_chat["x-prompt-cache-isolation-key"]
    )
    assert (
        first["x-prompt-cache-isolation-key"]
        != other_user["x-prompt-cache-isolation-key"]
    )
    assert "alice" not in "".join(first.values())
    assert "chat-a" not in "".join(first.values())


def test_user_affinity_and_disabled_isolation(monkeypatch):
    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)

    first = prompt_cache.build_fireworks_prompt_cache_headers(
        "alice",
        "chat-a",
        session_affinity_scope="user",
        prompt_cache_isolation=False,
    )
    other_chat = prompt_cache.build_fireworks_prompt_cache_headers(
        "alice",
        "chat-b",
        session_affinity_scope="user",
        prompt_cache_isolation=False,
    )

    assert first == other_chat
    assert set(first) == {"x-session-affinity"}


def test_http_hook_overwrites_untrusted_values_from_current_context(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "test-internal-secret")
    monkeypatch.setattr(
        prompt_cache,
        "_current_prompt_cache_identity",
        lambda: ("alice", "chat-a"),
    )
    request = SimpleNamespace(
        headers={
            "x-session-affinity": "caller-selected-session",
            "x-prompt-cache-isolation-key": "caller-selected-user",
        }
    )

    asyncio.run(prompt_cache.FireworksPromptCacheHeaderHook()(request))

    expected = prompt_cache.build_fireworks_prompt_cache_headers("alice", "chat-a")
    assert request.headers == expected


def test_http_hook_skips_calls_without_authenticated_request_context(monkeypatch):
    monkeypatch.setattr(
        prompt_cache,
        "_current_prompt_cache_identity",
        lambda: None,
    )
    request = SimpleNamespace(headers={"accept": "application/json"})

    asyncio.run(prompt_cache.FireworksPromptCacheHeaderHook()(request))

    assert request.headers == {"accept": "application/json"}
