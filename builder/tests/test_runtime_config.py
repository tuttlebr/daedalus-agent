"""Startup compatibility and credential-safe configuration diagnostics."""

import pytest
import yaml
from daedalus_runtime.config import (
    ConfigValidationError,
    describe_validation_error,
    load_config,
    validate_config,
)
from daedalus_runtime.tools import ToolRegistry
from pydantic import BaseModel, ValidationError, field_validator


@pytest.fixture
def runtime_config():
    return {
        "llms": {
            "main": {
                "base_url": "https://model.example/v1",
                "model_name": "fixture",
                "api_key": "private-test-credential",
                "request_timeout": 60,
            }
        },
        "workflow": {"_type": "daedalus_rust_agent", "llm_name": "main"},
    }


def test_existing_one_hour_model_timeout_starts_after_env_expansion(
    runtime_config, tmp_path, monkeypatch
):
    runtime_config["llms"]["main"]["request_timeout"] = "${DAEDALUS_LLM_TIMEOUT:-60.0}"
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(runtime_config))
    monkeypatch.setenv("DAEDALUS_LLM_TIMEOUT", "3600")

    loaded = load_config(path)
    validate_config(loaded, ToolRegistry(loaded))


@pytest.mark.parametrize(
    "timeout",
    [0, -1, 3601, float("nan"), float("inf"), None, "private-test-credential"],
)
def test_invalid_model_timeout_names_field_without_exposing_value(
    runtime_config, timeout
):
    runtime_config["llms"]["main"]["request_timeout"] = timeout
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(runtime_config, ToolRegistry(runtime_config))

    detail = describe_validation_error(caught.value)
    assert "llms.main.request_timeout" in detail
    assert runtime_config["llms"]["main"]["api_key"] not in detail


def test_model_url_diagnostic_omits_embedded_credentials(runtime_config):
    runtime_config["llms"]["main"]["base_url"] = (
        "https://account:private-test-credential@model.example/v1"
    )
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(runtime_config, ToolRegistry(runtime_config))

    detail = describe_validation_error(caught.value)
    assert "llms.main.base_url" in detail
    assert "private-test-credential" not in detail
    assert "model.example" not in detail


def test_pydantic_diagnostic_omits_inputs_and_validator_context():
    class Config(BaseModel):
        credential: str

        @field_validator("credential")
        @classmethod
        def validate_credential(cls, value):
            raise ValueError("Invalid private value: " + value)

    with pytest.raises(ValidationError) as caught:
        Config.model_validate({"credential": "private-test-credential"})

    assert describe_validation_error(caught.value) == "credential: value_error"


def test_unexpected_validation_error_does_not_log_exception_contents():
    error = RuntimeError("Provider failure with private-test-credential")
    assert describe_validation_error(error) == "RuntimeError"


@pytest.mark.parametrize(
    "deferred,description", [("true", "Lights"), (True, ""), (True, None)]
)
def test_deferred_discovery_requires_boolean_and_capability_description(
    runtime_config, deferred, description
):
    runtime_config["function_groups"] = {
        "lights": {"defer_discovery": deferred, "discovery_description": description}
    }
    with pytest.raises(ConfigValidationError, match="function_groups.lights"):
        validate_config(runtime_config, ToolRegistry(runtime_config))


@pytest.mark.parametrize(
    "initial,extra",
    [
        (["read", "read"], {}),
        ([None], {}),
        ("read", {}),
        (["write"], {"include": ["read"]}),
        (["write"], {"exclude": ["write"]}),
        (["read"], {"defer_discovery": False}),
    ],
)
def test_initial_tools_cannot_expand_allowlist_or_ignore_discovery_mode(
    runtime_config, initial, extra
):
    runtime_config["function_groups"] = {
        "lights": {
            "defer_discovery": True,
            "discovery_description": "Lighting control",
            "initial_tools": initial,
            **extra,
        }
    }
    with pytest.raises(
        ConfigValidationError, match="function_groups.lights.initial_tools"
    ):
        validate_config(runtime_config, ToolRegistry(runtime_config))
