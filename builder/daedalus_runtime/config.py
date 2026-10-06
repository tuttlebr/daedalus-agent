"""Load application configuration without an agent framework dependency."""

from __future__ import annotations

import copy
import math
import os
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlsplit

import yaml

_ENV = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def merge_config(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_config(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _expand(value: Any) -> Any:
    # Expand after parsing: an environment value is always data, never YAML.
    if isinstance(value, str):
        return _ENV.sub(lambda m: os.getenv(m[1]) or m[2] or "", value)
    if isinstance(value, dict):
        return {key: _expand(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_expand(item) for item in value]
    return value


def load_config(path: str | Path, *, _seen: frozenset = frozenset()) -> dict:
    path = Path(path).resolve()
    if path in _seen or len(_seen) >= 16:
        raise ValueError("Circular or excessively deep configuration inheritance")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Application configuration must be a mapping")
    base = data.pop("base", None)
    if base:
        data = merge_config(
            load_config(path.parent / str(base), _seen=_seen | {path}), data
        )
    return _expand(data)


def validate_config(config: dict, registry) -> None:
    """Reject unsupported or unbounded runtime settings before accepting work."""
    from nat_helpers.model_routing import ModelRoutingConfig, validate_skill_mappings

    workflow = config["workflow"]
    if workflow.get("_type") != "daedalus_rust_agent":
        raise ValueError("workflow._type must be daedalus_rust_agent")
    for name, default, maximum in (
        ("max_iterations", 128, 512),
        ("max_history", 50, 1000),
        ("max_history_tokens", 32000, 1_000_000),
        ("daily_summary_research_budget_seconds", 300, 1800),
        ("daily_summary_synthesis_retry_timeout_seconds", 75, 600),
    ):
        value = float(workflow.get(name, default))
        if not math.isfinite(value) or not 1 <= value <= maximum:
            raise ValueError(f"Invalid workflow.{name}")
    functions = config.get("functions", {})
    groups = config.get("function_groups", {})
    if set(functions) & set(groups):
        raise ValueError("Tool and MCP group names must be distinct")
    for field in ("tools", "daily_summary_tools", "daily_summary_final_tools"):
        names = workflow.get(field, [])
        if not isinstance(names, list) or any(
            not isinstance(name, str) for name in names
        ):
            raise ValueError(f"workflow.{field} must be a list of names")
        if len(names) != len(set(names)) or set(names) - (set(functions) | set(groups)):
            raise ValueError(f"Unknown or duplicate tool in workflow.{field}")
    for name in functions:
        registry.get_function_config(name)
    if workflow["llm_name"] not in config.get("llms", {}):
        raise ValueError("Unknown main model")
    for model in config["llms"].values():
        endpoint = urlsplit(model.get("base_url", ""))
        if (
            endpoint.scheme not in {"http", "https"}
            or not endpoint.hostname
            or endpoint.username
            or endpoint.password
        ):
            raise ValueError(
                "Model base_url must be an HTTP(S) endpoint without credentials"
            )
        if model.get("api_type", "responses") not in {"responses", "chat"}:
            raise ValueError("Unsupported model api_type")
        if (
            not isinstance(model.get("model_name"), str)
            or not model["model_name"].strip()
        ):
            raise ValueError("Model name is required")
        if not 0 <= int(model.get("max_retries", 3)) <= 8:
            raise ValueError("Model max_retries must be between zero and eight")
        deadline = float(model.get("request_timeout", 60))
        if not math.isfinite(deadline) or not 1 <= deadline <= 600:
            raise ValueError(
                "Model request_timeout must be between one and 600 seconds"
            )
    routing = ModelRoutingConfig.model_validate(workflow)
    validate_skill_mappings(
        SimpleNamespace(
            tools=workflow.get("tools", []),
            skill_model_profiles=routing.skill_model_profiles,
        ),
        registry,
    )
