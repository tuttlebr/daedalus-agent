"""Capture the retained memory-deletion tool's offline contracts.

The token helper uses a recording value source only to capture pure validation.
Separate acceptance checks must exercise actual Redis consumption and Hindsight.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

from export_authorization import fixture_strings


def failure(exc):
    output = {"error": type(exc).__name__}
    if hasattr(exc, "errors"):
        output["validation"] = [
            {
                **{key: item[key] for key in ["type", "loc", "msg"]},
                **(
                    {"ctx": {key: str(value) for key, value in item["ctx"].items()}}
                    if "ctx" in item
                    else {}
                ),
            }
            for item in exc.errors()
        ]
    return output


async def export(root):
    from nat_helpers.identity import authenticated_request_headers_scope
    from user_interaction import approval_tokens as approvals
    from user_interaction import user_interaction_function as interaction

    factory = contextlib.asynccontextmanager(interaction.user_interaction_function)
    defaults = interaction.UserInteractionConfig()
    resources = {
        "defaults": defaults.model_dump(mode="json"),
        "configuration_schema": defaults.model_json_schema(),
        "schemas": {},
    }
    for mask in range(4):
        operations = [
            name
            for index, name in enumerate(["confirm_action", "delete_memory_guarded"])
            if mask & (1 << index)
        ]
        config = interaction.UserInteractionConfig(enabled_operations=operations)
        async with factory(config, None) as tool:
            resources["schemas"][str(mask)] = tool.schema("user_interaction")
    redis_client = approvals.make_redis_client("redis://localhost:6379")
    kwargs = redis_client.connection_pool.connection_kwargs
    resources["redis_defaults"] = {
        name: kwargs.get(name)
        for name in [
            "socket_timeout",
            "socket_connect_timeout",
            "protocol",
            "decode_responses",
            "retry_on_timeout",
            "retry_on_error",
        ]
    }
    resources["redis_defaults"]["retry_count"] = getattr(
        kwargs.get("retry"), "_retries", None
    )
    connection = redis_client.connection_pool.make_connection()
    resources["redis_connection"] = {
        "socket_timeout": connection.socket_timeout,
        "socket_connect_timeout": connection.socket_connect_timeout,
        "retry_count": connection.retry._retries,
        "retry_errors": [kind.__name__ for kind in connection.retry._supported_errors],
    }
    redis_client.close()

    configurations = []
    for field in [*resources["configuration_schema"]["properties"], "unknown"]:
        for value in [
            None,
            "",
            "Synthetic description",
            " \u001c",
            0,
            1,
            True,
            False,
            [],
            {},
            "yes",
            ["confirm_action"],
            ["delete_memory_guarded"],
            ["delete_memory_guarded", "confirm_action", "confirm_action"],
            ["unknown"],
        ]:
            raw = {field: value}
            try:
                config = interaction.UserInteractionConfig.model_validate(raw)
                expected = {"ok": config.model_dump(mode="json")}
                try:
                    async with factory(config, None) as tool:
                        expected["schema"] = tool.schema("configured_interaction")
                except Exception as exc:
                    expected["schema_error"] = type(exc).__name__
            except ValueError:
                expected = {"error": True}
            configurations.append({"input": raw, "expected": expected})

    inputs = []
    valid = {
        "operation": "confirm_action",
        "action": "Synthetic memory removal",
        "reason": "User requested a reset",
    }
    raw_inputs = [
        {},
        None,
        [],
        {"operation": "unknown"},
        {"operation": "confirm_action"},
        {**valid, "action": ""},
        {**valid, "action": " \u001c"},
        {**valid, "action": None},
        {**valid, "reason": 1},
        {**valid, "target": "forged-user"},
        {**valid, "approval_token": "synthetic-token"},
        valid,
        {**valid, "risks": "Synthetic risk", "alternatives": "retain|export"},
        {**valid, "action": "雪 🌲\n<script>literal</script>"},
        {"operation": "delete_memory_guarded"},
        {"operation": "delete_memory_guarded", "approval_token": " "},
        {
            "operation": "delete_memory_guarded",
            "approval_token": "",
            "reason": "forged",
        },
    ]
    with patch.dict(
        os.environ, {"DAEDALUS_INTERNAL_API_TOKEN": "synthetic-internal"}, clear=True
    ):
        for mask in range(4):
            enabled = [
                name
                for index, name in enumerate(
                    ["confirm_action", "delete_memory_guarded"]
                )
                if mask & (1 << index)
            ]
            config = interaction.UserInteractionConfig(enabled_operations=enabled)
            async with factory(config, None) as tool:
                for raw in raw_inputs:
                    for headers in [
                        {},
                        {
                            "x-user-id": "synthetic-user",
                            "x-daedalus-internal-token": "wrong",
                        },
                        {
                            "x-user-id": " synthetic-user ",
                            "x-daedalus-internal-token": "synthetic-internal",
                        },
                    ]:
                        with authenticated_request_headers_scope(headers):
                            try:
                                expected = {"ok": await tool.ainvoke(raw)}
                            except Exception as exc:
                                expected = failure(exc)
                        inputs.append(
                            {
                                "mask": mask,
                                "input": raw,
                                "headers": headers,
                                "expected": expected,
                            }
                        )

    class TokenSource:
        def __init__(self, value):
            self.value = value
            self.calls = []

        def getdel(self, key):
            self.calls.append(key)
            value, self.value = self.value, None
            return value

    tokens = []
    token = "synthetic-approval"  # nosec B105 - disposable fixture approval
    user = "synthetic-user"
    approved = {"user_id": user, "action_type": "delete_memory", "target": user}
    payloads = [
        None,
        "",
        "invalid JSON",
        "[]",
        "null",
        "true",
        "{}",
        json.dumps(approved),
    ]
    for field in [
        "user_id",
        "action_type",
        "target",
        "server_name",
        "tool_name",
        "arguments_sha256",
    ]:
        for value in ["wrong", " ", None, 0, 1, [], [1], {}, {"x": 1}, True]:
            payloads.append(json.dumps({**approved, field: value}))
    for raw in payloads:
        source = TokenSource(raw)
        try:
            expected = {
                "ok": approvals.validate_approval_token(
                    source,
                    user_id=user,
                    token=token,
                    action_type="delete_memory",
                    target=user,
                )
            }
        except Exception as exc:
            expected = failure(exc)
        tokens.append(
            {
                "raw": raw,
                "user": user,
                "token": token,
                "expected": expected,
                "keys": source.calls,
                "remaining": source.value,
            }
        )

    urls = []
    for explicit, env in [
        (None, {}),
        ("redis://example.test/2", {"REDIS_PORT": "6380"}),
        ("  ", {"REDIS_URL": "redis://example.test/2", "REDIS_PORT": "6380"}),
        (
            None,
            {
                "REDIS_HOST": "2001:db8::8",
                "REDIS_PORT": "6380",
                "REDIS_USERNAME": "approval user",
                "REDIS_PASSWORD": "synthetic@password /#",
                "REDIS_TLS_ENABLED": "YES",
                "REDIS_TLS_CA_FILE": "/synthetic ca.pem",
            },
        ),
        (
            None,
            {
                "REDIS_URL": "rediss://example.test:6379/3?ssl_ca_certs=/synthetic.pem",
                "REDIS_PORT": "6380",
            },
        ),
        (None, {"REDIS_URL": "redis://[::1]/4", "REDIS_PORT": "6380"}),
        (None, {"REDIS_URL": "redis://example.test:invalid"}),
        (None, {"REDIS_URL": "redis://example.test:invalid", "REDIS_PORT": "6380"}),
    ]:
        with patch.dict(os.environ, env, clear=True):
            try:
                expected = {"ok": approvals.build_redis_url(explicit)}
            except Exception as exc:
                expected = failure(exc)
        urls.append({"explicit": explicit, "env": env, "expected": expected})

    fixture = {
        "source_sha256": {
            Path(module.__file__).name: hashlib.sha256(
                Path(module.__file__).read_bytes()
            ).hexdigest()
            for module in [interaction, approvals]
        },
        "configuration": configurations,
        "inputs": inputs,
        "tokens": tokens,
        "urls": urls,
    }
    for folder, value in [
        ("resources", resources),
        ("tests/fixtures", fixture_strings(fixture)),
    ]:
        path = root / folder / "user-interaction.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, indent=2, ensure_ascii=folder == "resources") + "\n"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
