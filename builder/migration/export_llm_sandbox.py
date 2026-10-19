"""Freeze sandbox schemas and pure helpers from the retained Python tool.

These synthetic offline cases complement the real HTTP service and frontend
artifact-publication checks; they do not replace those integration checks.
"""

import argparse
import asyncio
import base64
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import httpx
from export_authorization import failure


def fixture_strings(value):
    """Chunk synthetic strings by serialized length, including doubled escapes."""
    if isinstance(value, str) and len(json.dumps(value, ensure_ascii=False)) > 78:
        parts, current, width = [], "", 0
        for character in value:
            size = len(json.dumps(character, ensure_ascii=False)) - 2
            if width + size > 72:
                parts.append(current)
                current, width = "", 0
            current += character
            width += size
        if current:
            parts.append(current)
        return {"$string_parts": parts}
    if isinstance(value, list):
        return [fixture_strings(item) for item in value]
    if isinstance(value, dict):
        return {key: fixture_strings(item) for key, item in value.items()}
    return value


def capabilities():
    return {
        "isolation": "bubblewrap",
        "stateless": True,
        "shellEnabled": True,
        "networkMode": "isolated",
        "path": "/usr/bin:/bin",
        "commands": ["true", "printf", "cat", "雪"],
        "limits": {
            "maxTimeoutSeconds": 60,
            "defaultTimeoutSeconds": 30,
            "inputBytes": 4096,
        },
        "workspacePersistence": {"supported": True, "ttlSeconds": 3600},
    }


def execution():
    content = "Synthetic artifact 雪🌲\n".encode()
    return {
        "requestId": "synthetic-request",
        "exitCode": 0,
        "stdout": "Synthetic stdout 雪🌲\n",
        "stderr": "Synthetic stderr\n",
        "durationMs": 12,
        "timedOut": False,
        "truncated": False,
        "workspacePersisted": True,
        "files": [
            {
                "path": "reports/report.txt",
                "size": len(content),
                "mode": "0644",
                "contentBase64": base64.b64encode(content).decode(),
                "truncated": False,
            }
        ],
        "missingFiles": [],
    }


def artifact():
    return {
        "artifact": {
            "version": 1,
            "documentId": "synthetic-document",
            "sessionId": "synthetic-session",
            "filename": "report.txt",
            "mimeType": "text/plain",
            "size": 12,
            "downloadUrl": "/api/session/documentStorage?documentId=synthetic-document&sessionId=synthetic-session",
        }
    }


def observe(fn, *args, **kwargs):
    try:
        return {"ok": fn(*args, **kwargs)}
    except Exception as error:
        return {"error": type(error).__name__, "message": str(error)}


def mutations(value, fields, variants):
    yield value
    for path in fields:
        for variant in [*variants, ...]:
            mutated = copy.deepcopy(value)
            parent = mutated
            for key in path[:-1]:
                parent = parent[key]
            if variant is ...:
                parent.pop(path[-1], None)
            else:
                parent[path[-1]] = variant
            yield mutated


async def export(root):
    from llm_sandbox import llm_sandbox_function as module

    variables = [
        "LLM_SANDBOX_BASE_URL",
        "LLM_SANDBOX_API_KEY",
        "DAEDALUS_ARTIFACT_PUBLISH_URL",
        "DAEDALUS_INTERNAL_API_TOKEN",
    ]
    for name in variables:
        os.environ.pop(name, None)
    factory = contextlib.asynccontextmanager(module.llm_sandbox_function)
    defaults = module.LlmSandboxConfig()
    async with factory(defaults, None) as tool:
        resources = {
            "defaults": defaults.model_dump(mode="json"),
            "configuration_schema": defaults.model_json_schema(),
            "schema": tool.schema("llm_sandbox"),
            "reserved_environment": sorted(module.RESERVED_ENV_NAMES),
            "reserved_prefixes": module.RESERVED_ENV_PREFIXES,
            "artifact_marker": module.ARTIFACT_REF_MARKER,
        }
        inputs = []
        variants = [
            None,
            "",
            "Synthetic",
            0,
            -1,
            1,
            1.5,
            True,
            False,
            [],
            {},
            ["true"],
            "execute",
            1e30,
        ]
        for field in [*resources["schema"]["parameters"]["properties"], "unknown"]:
            for value in variants:
                raw = {"operation": "execute", "argv": ["true"]}
                if field in {"file_path", "file_content", "append"}:
                    raw = {
                        "operation": "write_file",
                        "file_path": "report.txt",
                        "file_content": "Synthetic file",
                    }
                elif field == "command":
                    raw = {"operation": "execute"}
                raw[field] = value
                try:
                    expected = {"ok": await tool.ainvoke(raw)}
                except Exception as error:
                    expected = failure(error)
                inputs.append({"input": raw, "expected": expected})
        for raw in [
            {},
            None,
            [],
            "text",
            {"argv": ["true", None]},
            {"operation": "read_file", "file_path": "a"},
            {"operation": "list_commands"},
            {"operation": "publish_file", "file_path": "report.txt"},
            {"operation": "write_file", "file_path": "report.txt", "file_content": ""},
        ]:
            try:
                expected = {"ok": await tool.ainvoke(raw)}
            except Exception as error:
                expected = failure(error)
            inputs.append({"input": raw, "expected": expected})

    configuration = []
    for field in [*resources["configuration_schema"]["properties"], "unknown"]:
        for value in [
            None,
            "",
            "Synthetic",
            " \t\u001c",
            0,
            -1,
            1,
            1.5,
            5,
            30,
            600,
            601,
            True,
            False,
            [],
            {},
            "1.5",
            "NaN",
            "inf",
            "off",
            "1_0",
            10**30,
        ]:
            raw = {field: value}
            try:
                config = module.LlmSandboxConfig.model_validate(raw)
                expected = {
                    "ok": config.model_dump(mode="json"),
                    "api_key": config.api_key.get_secret_value(),
                    "internal_token": config.internal_api_token.get_secret_value(),
                }
                try:
                    async with factory(config, None) as tool:
                        expected["schema"] = tool.schema("configured_sandbox")
                except Exception as error:
                    expected["schema_error"] = type(error).__name__
            except ValueError:
                expected = {"error": True}
            configuration.append({"input": raw, "expected": expected})

    environment = []
    for values in [
        {
            "LLM_SANDBOX_API_KEY": "synthetic-sandbox-token",
            "DAEDALUS_INTERNAL_API_TOKEN": "synthetic-internal-token",
        },
        {"LLM_SANDBOX_BASE_URL": "http://synthetic.svc/"},
        {"LLM_SANDBOX_BASE_URL": "invalid unvalidated default"},
        {"DAEDALUS_ARTIFACT_PUBLISH_URL": "invalid unvalidated default"},
    ]:
        with patch.dict(os.environ, values):
            config = module.LlmSandboxConfig()
            environment.append(
                {
                    "environment": values,
                    "expected": {
                        "ok": config.model_dump(mode="json"),
                        "api_key": config.api_key.get_secret_value(),
                        "internal_token": config.internal_api_token.get_secret_value(),
                    },
                }
            )

    urls = []
    for value in [
        "",
        " https://example.test/// ",
        "https://example.test:443",
        "https://example.test:99999",
        "https://example.test:abc",
        "http://example.test",
        "http://sandbox.svc",
        "HTTP://Sandbox.SVC.CLUSTER.LOCAL./",
        "http://frontend:3000",
        "http://frontend",
        "https://user:pass@example.test",
        "https://@example.test",
        "https://example.test/path",
        "https://example.test?",
        "https://example.test#",
        "https://example.test?q=x",
        "https://example.test#fragment",
        "https://[::1]",
        "https://[not-an-ip]",
        "https://example.test\\@other.test",
        "https://ｅxample.test",
        "https://example.test：443",
        "\nhttps://exa\tmple.test\r/",
        "https://example.test/\u001c",
        "https://example.test/api/internal/sandboxArtifacts",
        "http://frontend:3000/api/internal/sandboxArtifacts",
        "http://publish.svc/api/internal/sandboxArtifacts",
        "https://example.test/api/internal/sandboxArtifacts/",
    ]:
        for kind, fn in [
            ("base", module._validate_base_url),
            ("publisher", module._validate_artifact_publish_url),
        ]:
            urls.append({"kind": kind, "input": value, "expected": observe(fn, value)})

    paths = []
    for value in [
        None,
        0,
        False,
        [],
        {},
        "",
        ".",
        "./",
        "a",
        "a/b",
        "./a//b/",
        "a/./b",
        "a/../b",
        "../a",
        "/a",
        "//a",
        "\\a\\b",
        "a\x00b",
        "雪/🌲.txt",
        " \t",
        "...",
        "a/.hidden",
    ]:
        paths.append(
            {
                "input": value,
                "working": module._normalize_working_directory(value),
                "file": module._normalize_file_path(value),
            }
        )

    environments = []
    for value in [
        "",
        " \u001c",
        "{}",
        "[]",
        "null",
        "false",
        "{",
        '{"A":}',
        '{"A" 1}',
        '{"A": "\\q"}',
        '{"A":"unterminated}',
        '{"A":1,}',
        "{} trailing",
        "\ufeff{}",
        '{"A": "line\n"}',
        '{"A": 1}',
        '{"A":null}',
        '{"A": {}}',
        '{"A":"1","A":"2"}',
        '{"A":"雪🌲","_ok":""}',
    ] + [
        json.dumps({key: "value"})
        for key in [
            *module.RESERVED_ENV_NAMES,
            "LD_PRELOAD",
            "DYLD_LIBRARY_PATH",
            "bad-name",
            "2bad",
            "雪",
            "PATH ",
            "path",
            "OK",
            "_1",
        ]
    ]:
        environments.append({"input": value, "expected": module._parse_env_json(value)})

    scopes = []
    for headers in [
        None,
        {},
        {"x-user-id": "alice"},
        {"X-User-Id": " alice ", "X-Conversation-Id": "雪🌲"},
        {"x-user-id": "alice", "x-conversation-id": "one"},
        {"x-user-id": "bob", "x-conversation-id": "one"},
        {"x-user-id": "alice", "x-conversation-id": "two"},
        {"x-user-id": " \u001c", "x-conversation-id": "one"},
        {"x-user-id": 1, "x-conversation-id": "one"},
    ]:
        scope = module._trusted_scope_from_headers(headers)
        scopes.append(
            {
                "input": headers,
                "scope": scope,
                "workspace": module._workspace_id_from_scope(scope),
            }
        )

    validations = []
    variants = [None, "", "Synthetic", 0, -1, 1, 1.0, True, False, [], {}, ["true"]]
    fixtures = [
        (
            "capabilities",
            capabilities(),
            module._validate_capabilities,
            module._format_commands,
            [[key] for key in capabilities()]
            + [
                ["limits", "maxTimeoutSeconds"],
                ["workspacePersistence", "supported"],
                ["workspacePersistence", "ttlSeconds"],
            ],
        ),
        (
            "execution",
            execution(),
            module._validate_execute_result,
            module._format_execute_result,
            [[key] for key in execution()]
            + [["files", 0, key] for key in execution()["files"][0]],
        ),
        (
            "artifact",
            artifact(),
            lambda raw: module._validate_published_artifact(
                raw, expected_path="reports/report.txt", expected_size=12
            ),
            lambda raw: module._format_publish_result(
                raw, request_id="synthetic-request", source_path="reports/report.txt"
            ),
            [["artifact"]] + [["artifact", key] for key in artifact()["artifact"]],
        ),
    ]
    for kind, raw, validate, render, fields in fixtures:
        for value in [None, [], "text", *mutations(raw, fields, variants)]:
            expected = observe(validate, value)
            if "ok" in expected:
                expected["render"] = observe(render, expected["ok"])
            validations.append({"kind": kind, "input": value, "expected": expected})
    for content in [
        "",
        "AA==",
        "AB==",
        "AA===",
        "AA==\n",
        "!!!!",
        "/w==",
        "4g==",
        "4oKs",
        "雪",
    ]:
        value = execution()
        value["files"][0]["contentBase64"] = content
        try:
            value["files"][0]["size"] = len(base64.b64decode(content, validate=True))
        except ValueError:
            pass
        expected = observe(module._validate_execute_result, value)
        if "ok" in expected:
            expected["render"] = observe(module._format_execute_result, value)
        validations.append({"kind": "execution", "input": value, "expected": expected})
    for url in [
        "/api/session/documentStorage?sessionId=synthetic-session&documentId=synthetic-document",
        "/api/session/documentStorage?documentId=synthetic-document&sessionId=synthetic-session&extra=1",
        "/api/session/documentStorage?documentId=synthetic-document&sessionId=synthetic-session&documentId=synthetic-document",
        "https://example.test/api/session/documentStorage?documentId=synthetic-document&sessionId=synthetic-session",
        "/api/session/documentStorage?documentId=synthetic-document&sessionId=synthetic-session#x",
        "/api/session/documentStorage?documentId=synthetic-document&sessionId=synthetic-session#",
        "/api/session/documentStorage?documentId=synthetic%2Ddocument&sessionId=synthetic-session",
    ]:
        value = artifact()
        value["artifact"]["downloadUrl"] = url
        validated = observe(
            module._validate_published_artifact,
            value,
            expected_path="reports/report.txt",
            expected_size=12,
        )
        if "ok" in validated:
            validated["render"] = observe(
                module._format_publish_result,
                validated["ok"],
                request_id="synthetic-request",
                source_path="reports/report.txt",
            )
        validations.append({"kind": "artifact", "input": value, "expected": validated})

    http_errors = []
    for status in [301, 400, 401, 429, 500, 502, 503, 504]:
        for payload in [
            None,
            {},
            [],
            {"requestId": "synthetic-雪🌲", "error": "failure\n"},
            {"requestId": 1, "error": ["ignored"]},
            {"error": "雪🌲" * 400},
        ]:
            response = httpx.Response(status, json=payload)
            http_errors.append(
                {
                    "status": status,
                    "body": response.text,
                    "expected": module._http_error(response),
                }
            )
    http_errors.append(
        {
            "status": 500,
            "body": "not json",
            "expected": module._http_error(httpx.Response(500, text="not json")),
        }
    )
    fixture = {
        "source_sha256": hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest(),
        "configuration": configuration,
        "environment": environment,
        "inputs": inputs,
        "urls": urls,
        "paths": paths,
        "environment_json": environments,
        "scopes": scopes,
        "validation": validations,
        "http_errors": http_errors,
        "json_errors": [
            {"input": value, "expected": observe(json.loads, value)}
            for value in [
                "",
                " ",
                "not json",
                "{",
                "[",
                "[1,]",
                '{"a":}',
                '{"a" 1}',
                '{"a":1,}',
                '{"a":1',
                "[1 2]",
                '"unterminated',
                '"bad\\q"',
                '"\\u12xx"',
                '"line\n"',
                "{} x",
                "\ufeff{}",
                '{"a":"雪","b":}',
                '\n{"a":\n}',
                "01",
                "-01",
                "1.",
                "1e",
                "{true:1}",
            ]
        ],
    }
    counts = {
        key: len(value) for key, value in fixture.items() if isinstance(value, list)
    }
    configuration = fixture.pop("configuration")
    for index, start in enumerate(range(0, len(configuration), 165)):
        path = root / "tests/fixtures" / f"llm-sandbox-configuration-{index}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                fixture_strings(
                    {
                        "source_sha256": fixture["source_sha256"],
                        "configuration": configuration[start : start + 165],
                    }
                ),
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
    for folder, value in [
        ("resources", resources),
        ("tests/fixtures", fixture_strings(fixture)),
    ]:
        path = root / folder / "llm-sandbox.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=folder == "resources", indent=2) + "\n"
        )
    print(counts)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
