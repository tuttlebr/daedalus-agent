"""Autonomy provider configuration and trusted selection boundaries."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from nat_helpers.autonomous_llm import (
    autonomous_llm,
    autonomous_llm_config,
    is_authenticated_autonomy_request,
)

ENV = {
    "AUTONOMOUS_LLM_MODEL_BASE_URL": "http://autonomy.example/v1",
    "AUTONOMOUS_LLM_MODEL_API_KEY": "autonomy-test-secret",
    "AUTONOMOUS_LLM_MODEL_MODEL": "daedalus/cheap",
}
DEFAULT = SimpleNamespace(max_retries=3, request_timeout=60)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)


def configured(monkeypatch):
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)


def test_unset_or_blank_preserves_existing_model(monkeypatch):
    assert autonomous_llm_config(DEFAULT) is None
    for name in ENV:
        monkeypatch.setenv(name, " ")
    assert autonomous_llm_config(DEFAULT) is None


def test_complete_transport_keeps_secret_private_and_retry_contract(monkeypatch):
    configured(monkeypatch)
    config = autonomous_llm_config(DEFAULT)
    assert config.model_name == "daedalus/cheap"
    assert config.base_url == "http://autonomy.example/v1"
    assert config.api_key.get_secret_value() == ENV["AUTONOMOUS_LLM_MODEL_API_KEY"]
    assert ENV["AUTONOMOUS_LLM_MODEL_API_KEY"] not in repr(config)
    assert config.api_type == "responses"
    assert (config.max_retries, config.request_timeout) == (3, 60)
    assert config.truncation == "auto"


@pytest.mark.parametrize("missing", list(ENV))
def test_partial_configuration_names_missing_field_without_secrets(
    monkeypatch, missing
):
    configured(monkeypatch)
    monkeypatch.delenv(missing)
    with pytest.raises(ValueError, match=missing) as error:
        autonomous_llm_config(DEFAULT)
    assert ENV["AUTONOMOUS_LLM_MODEL_API_KEY"] not in str(error.value)


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp/model",
        "http://",
        "https://user:secret@host/v1",
        "https://host/?key=secret",
        "http://[bad",
    ],
)
def test_invalid_endpoint_rejected_without_echoing_it(monkeypatch, url):
    configured(monkeypatch)
    monkeypatch.setenv("AUTONOMOUS_LLM_MODEL_BASE_URL", url)
    with pytest.raises(ValueError, match="must be an HTTP") as error:
        autonomous_llm_config(DEFAULT)
    assert url not in str(error.value)


@pytest.mark.parametrize(
    "scope,expected",
    [("autonomy", True), ("AUTONOMY", True), ("", False), ("chat", False)],
)
def test_selection_requires_trusted_scope(monkeypatch, scope, expected):
    monkeypatch.setattr(
        "nat_helpers.identity.trusted_request_header_from_context", lambda _: scope
    )
    assert is_authenticated_autonomy_request() is expected


def test_untrusted_scope_cannot_select_autonomy_provider(monkeypatch):
    def reject(_):
        raise ValueError("valid x-daedalus-internal-token is required")

    monkeypatch.setattr(
        "nat_helpers.identity.trusted_request_header_from_context", reject
    )
    assert not is_authenticated_autonomy_request()


def test_registered_client_lifecycle_closes_without_changing_default(monkeypatch):
    configured(monkeypatch)
    events = []
    original = SimpleNamespace(max_retries=3, request_timeout=60, model_name="chat")
    builder = SimpleNamespace(get_llm_config=lambda _: original)

    @asynccontextmanager
    async def build(config, received_builder):
        assert received_builder is builder
        events.append("opened")
        try:
            yield config
        finally:
            events.append("closed")

    monkeypatch.setattr("nat_helpers.autonomous_llm._registered_client", build)

    async def scenario():
        async with autonomous_llm(builder, "tool_calling_llm") as client:
            assert client.model_name == "daedalus/cheap"
            assert events == ["opened"]
        assert events == ["opened", "closed"]
        assert original.model_name == "chat"

    asyncio.run(scenario())
