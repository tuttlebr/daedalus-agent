"""Optional server-owned Responses transport for autonomous main-agent calls."""

import os
from urllib.parse import urlsplit

from pydantic import BaseModel, SecretStr


class AutonomousModelConfig(BaseModel):
    api_type: str = "responses"
    base_url: str
    api_key: SecretStr
    model_name: str
    max_retries: int
    request_timeout: float | None
    truncation: str = "auto"


_ENV_FIELDS = {
    "base_url": "AUTONOMOUS_LLM_MODEL_BASE_URL",
    "api_key": "AUTONOMOUS_LLM_MODEL_API_KEY",
    "model_name": "AUTONOMOUS_LLM_MODEL_MODEL",
}


def autonomous_llm_config(default_config):
    """Require an explicit complete transport; never inherit another API key."""
    values = {field: os.getenv(name, "").strip() for field, name in _ENV_FIELDS.items()}
    if not any(values.values()):
        return None
    missing = [name for field, name in _ENV_FIELDS.items() if not values[field]]
    if missing:
        raise ValueError("Autonomy model configuration requires " + ", ".join(missing))
    try:
        endpoint = urlsplit(values["base_url"])
        valid_url = (
            endpoint.scheme in {"http", "https"}
            and bool(endpoint.hostname)
            and not endpoint.username
            and not endpoint.password
            and not endpoint.query
            and not endpoint.fragment
        )
        endpoint.port
    except ValueError:
        valid_url = False
    if not valid_url:
        raise ValueError("AUTONOMOUS_LLM_MODEL_BASE_URL must be an HTTP(S) base URL")
    return AutonomousModelConfig(
        base_url=values["base_url"],
        api_key=SecretStr(values["api_key"]),
        model_name=values["model_name"],
        max_retries=default_config.max_retries,
        request_timeout=default_config.request_timeout,
    )


def is_authenticated_autonomy_request() -> bool:
    """Provider choice uses authenticated request metadata, never model input."""
    from nat_helpers.identity import trusted_request_header_from_context

    try:
        return (
            trusted_request_header_from_context("x-daedalus-execution-scope").lower()
            == "autonomy"
        )
    except (ValueError, AttributeError, RuntimeError):
        return False
