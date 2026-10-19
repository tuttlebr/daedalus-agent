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
    # The deployment value, not the shorter default, must reach validation.
    assert loaded["llms"]["main"]["request_timeout"] == "3600"
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


def test_retired_tool_type_names_the_function_to_remove(runtime_config):
    runtime_config["functions"] = {"memory_guard": {"_type": "user_interaction"}}
    runtime_config["workflow"]["tools"] = ["memory_guard"]
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(runtime_config, ToolRegistry(runtime_config))

    detail = describe_validation_error(caught.value)
    assert "Retired function type user_interaction" in detail
    assert "functions.memory_guard" in detail
    assert "Memory Center" in detail


def test_unknown_tool_type_is_a_named_configuration_error(runtime_config):
    runtime_config["functions"] = {
        "custom": {"_type": "private-test-credential", "token": "x"}
    }
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(runtime_config, ToolRegistry(runtime_config))

    detail = describe_validation_error(caught.value)
    assert detail == "Unsupported functions.custom._type"
    assert "private-test-credential" not in detail


@pytest.fixture(autouse=True)
def _retrieval_factories():
    # Startup imports every factory; register the two retrieval tools here.
    import nat_nv_ingest.nat_nv_ingest  # noqa: F401
    import smart_milvus.register  # noqa: F401


def _document_tool(runtime_config, **fields):
    runtime_config["functions"] = {
        "documents": {"_type": "nat_nv_ingest", **fields},
    }
    runtime_config["workflow"]["tools"] = ["documents"]
    return runtime_config


def test_upload_collection_sources_must_agree(runtime_config, monkeypatch):
    monkeypatch.delenv("DOCUMENT_INGEST_DEFAULT_COLLECTION", raising=False)
    config = _document_tool(runtime_config, default_collection_name="user_uploads")
    validate_config(config, ToolRegistry(config))
    monkeypatch.setenv("DOCUMENT_INGEST_DEFAULT_COLLECTION", "team_uploads")
    config = _document_tool(runtime_config, default_collection_name=" Team Uploads ")
    validate_config(config, ToolRegistry(config))

    # HTTP uploads and metadata would use a collection tool search never reads.
    config = _document_tool(runtime_config)
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config, ToolRegistry(config))
    detail = describe_validation_error(caught.value)
    assert "functions.documents.default_collection_name" in detail
    assert "DOCUMENT_INGEST_DEFAULT_COLLECTION" in detail
    assert "team_uploads" not in detail


@pytest.mark.parametrize("database", ["", " default ", "default"])
def test_default_milvus_database_is_accepted(runtime_config, monkeypatch, database):
    monkeypatch.setenv("MILVUS_DATABASE", database)
    config = _document_tool(runtime_config, database_name=database)
    validate_config(config, ToolRegistry(config))


def test_milvus_database_must_be_the_ingestion_database(runtime_config, monkeypatch):
    monkeypatch.setenv("MILVUS_DATABASE", "private-database")
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(runtime_config, ToolRegistry(runtime_config))
    detail = describe_validation_error(caught.value)
    assert detail.startswith("MILVUS_DATABASE must be empty or default")
    assert "private-database" not in detail


@pytest.mark.parametrize(
    "function",
    [
        {"_type": "nat_nv_ingest", "database_name": "custom"},
        {
            "_type": "domain_retriever",
            "uri": "http://milvus.example:19530",
            "embedding_model": "embedder",
            "database_name": "custom",
        },
    ],
)
def test_tool_database_must_be_the_default(runtime_config, monkeypatch, function):
    monkeypatch.delenv("MILVUS_DATABASE", raising=False)
    runtime_config["functions"] = {"retrieval": function}
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(runtime_config, ToolRegistry(runtime_config))
    assert "functions.retrieval.database_name" in describe_validation_error(
        caught.value
    )
