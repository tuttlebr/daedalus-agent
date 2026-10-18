"""Compatibility adapter sharing the native exploration wire contract."""

import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from jsonschema import Draft202012Validator
from pydantic import ConfigDict, create_model

from .tools import ToolConfig, ToolDefinition, register_tool

_path = Path(__file__).with_name("exploration.json")
if not _path.exists():
    _path = Path(__file__).parents[1] / "runtime/resources/exploration.json"
CONTRACT = json.loads(_path.read_text())
_types = {"string": str, "integer": int, "array": list[str]}
Input = create_model(
    "ExplorationInput",
    __config__=ConfigDict(extra="forbid"),
    **{
        name: (_types[schema["type"]], ... if name == "operation" else None)
        for name, schema in CONTRACT["parameters"]["properties"].items()
    },
)


class ExplorationConfig(ToolConfig, name="sandbox_exploration"):
    description: str | None = CONTRACT["description"]


class Definition(ToolDefinition):
    def configure_contract(self, kind, config):
        if not self.description.strip():
            raise ValueError("Exploration requires a nonempty description")
        self.parameters = CONTRACT["parameters"]
        Draft202012Validator.check_schema(self.parameters)
        self.validator = Draft202012Validator(self.parameters)


def grant(key, scope, now):
    def encode(value):
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    user, conversation = scope
    claims = {
        "iss": "daedalus-agent",
        "aud": "daedalus-exploration",
        "iat": now,
        "exp": now + 120,
        "owner": hashlib.sha256(user.encode()).hexdigest(),
        "scope": hashlib.sha256(f"{user}\0{conversation}".encode()).hexdigest(),
        "profile": "compute-offline-v1",
    }
    unsigned = (
        encode(b'{"alg":"HS256","typ":"JWT"}')
        + "."
        + encode(json.dumps(claims).encode())
    )
    return (
        unsigned + "." + encode(hmac.digest(key.encode(), unsigned.encode(), "sha256"))
    )


@register_tool(config_type=ExplorationConfig)
async def exploration_function(config, builder):
    from llm_sandbox.llm_sandbox_function import (
        LlmSandboxConfig,
        _publish_artifact,
        _trusted_scope_from_context,
    )

    endpoint = os.environ["EXPLORATION_BASE_URL"].rstrip("/")
    url = urlsplit(endpoint)
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("Invalid exploration endpoint")
    key = os.environ["EXPLORATION_GRANT_KEY"]
    if len(key) < 64:
        raise ValueError("Exploration grant key is too short")

    async def invoke(request: Input):
        scope = _trusted_scope_from_context()
        if scope is None:
            raise ValueError(
                "Exploration requires a trusted user and conversation context"
            )
        args = request.model_dump(exclude_unset=True)
        publish = args["operation"] == "publish_file"
        if publish:
            args["operation"] = "artifact"
        async with httpx.AsyncClient(timeout=45, follow_redirects=False) as client:
            async with client.stream(
                "POST",
                endpoint + "/v2/tool",
                json=args,
                headers={
                    "authorization": "Bearer " + grant(key, scope, int(time.time()))
                },
            ) as response:
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > 12_000_000:
                        raise ValueError("Exploration response exceeds limit")
                    content.extend(chunk)
                value = json.loads(content)
                if not response.is_success or not publish:
                    return json.dumps(value)
        data = base64.b64decode(value["contentBase64"], validate=True)
        if (
            len(data) > 6_291_456
            or value["size"] != len(data)
            or value["sha256"] != hashlib.sha256(data).hexdigest()
            or not isinstance(value.get("runId"), str)
            or not value["runId"]
            or not isinstance(value.get("path"), str)
            or not value["path"]
            or value["runId"] != args["runId"]
            or value["path"] != args["path"]
        ):
            raise ValueError("Artifact integrity or provenance validation failed")
        return await _publish_artifact(
            LlmSandboxConfig(),
            scope=scope,
            source_path=value["path"],
            collected_file=value,
            request_id=value["runId"],
        )

    description = (
        CONTRACT["description"] if config.description is None else config.description
    )
    if not description.strip():
        raise ValueError("Exploration requires a nonempty description")
    yield Definition.from_fn(invoke, description=description)
