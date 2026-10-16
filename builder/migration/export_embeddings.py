"""Capture the retained role-aware embedding provider's public and wire contracts."""

import argparse
import asyncio
import base64
import gzip
import hashlib
import inspect
import json
import math
import struct
import zlib
from pathlib import Path

from export_authorization import fixture_strings


def error(exc):
    from pydantic import ValidationError

    observed = {"error": type(exc).__name__}
    if isinstance(exc, ValidationError):
        observed["validation"] = exc.errors(include_input=False, include_url=False)
    return observed


def safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return {"$float": value.hex()}
    if isinstance(value, dict):
        return {k: safe(v) for k, v in value.items()}
    return value


def fixture_numbers(value):
    """Keep long synthetic integers readable without resembling API keys."""
    if isinstance(value, int) and len(str(value)) > 80:
        return {"$integer": str(value)}
    if isinstance(value, dict):
        return {key: fixture_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [fixture_numbers(item) for item in value]
    return value


async def export(root, revision):
    import httpx
    import zstandard
    from nat_helpers import vllm_embeddings as provider

    base = {"base_url": "http://synthetic.invalid", "model_name": "synthetic-model"}
    configurations = []
    inputs = [
        base,
        {"base_url": base["base_url"], "model": "alias-model"},
        {**base, "model": "ignored", "extra": True},
    ]
    values = [
        None,
        "",
        " ",
        0,
        1,
        -1,
        1.5,
        2.0,
        True,
        False,
        [],
        {},
        "雪🌲",
        "1",
        "1.0",
        "1_000",
        "01",
        "١",
        "1e2",
        "inf",
        "nan",
        "true",
        " yes",
        "off",
        65,
        10**100,
    ]
    for field in provider.DaedalusVLLMEmbedderConfig.model_fields:
        inputs.append({k: v for k, v in base.items() if k != field})
        inputs.extend({**base, field: value} for value in values)
    inputs.extend(
        [
            None,
            [],
            "bad",
            {"model": "fixture"},
            {"base_url": "host", "model": None, "model_name": "preferred"},
        ]
    )
    for raw in inputs:
        try:
            config = provider.DaedalusVLLMEmbedderConfig.model_validate(raw)
            values = config.model_dump()
            values["api_key"] = (
                config.api_key.get_secret_value()
                if config.api_key is not None
                else None
            )
            expected = {"ok": safe(values)}
        except Exception as exc:
            expected = error(exc)
        configurations.append({"input": raw, "expected": expected})

    construction = []
    for change in [
        {},
        {"base_url": ""},
        {"base_url": " "},
        {"model_name": ""},
        {"model_name": "\t"},
        {"api_key": "synthetic-key"},
        {"api_key": "雪"},
        {"api_key": " synthetic-key "},
        {"api_key": "key\nvalue"},
        {"base_url": "invalid"},
        {"timeout_seconds": "inf"},
    ]:
        raw = {**base, **change}
        try:
            client = provider.create_embeddings(
                provider.DaedalusVLLMEmbedderConfig.model_validate(raw)
            )
            expected = {
                "endpoint": client._endpoint,
                "headers": dict(client._sync_client.headers),
            }
            for name in ["user-agent", "accept-encoding", "connection"]:
                expected["headers"].pop(name, None)
            await client.aclose()
        except Exception as exc:
            expected = error(exc)
        construction.append({"input": raw, "expected": expected})

    requests = []
    for url in [
        "http://synthetic.invalid",
        "http://synthetic.invalid/",
        "http://synthetic.invalid/v1",
        "http://synthetic.invalid/v1/embeddings///",
        " http://synthetic.invalid/ ",
        "http://synthetic.invalid/custom?x=1",
    ]:
        for role in ["query", "document"]:
            client = provider.DaedalusVLLMEmbeddings(
                base_url=url,
                model="synthetic 雪🌲",
                truncate_prompt_tokens=17,
                verify_ssl=False,
            )
            requests.append(
                {
                    "url": url,
                    "model": "synthetic 雪🌲",
                    "truncate": 17,
                    "text": "Synthetic query 雪🌲\n",
                    "role": role,
                    "expected": {
                        "endpoint": client._endpoint,
                        "payload": client._request_payload(
                            "Synthetic query 雪🌲\n", role
                        ),
                    },
                }
            )
            await client.aclose()

    responses = []

    def add(name, value=None, *, raw=None, status=200, encoding="utf-8", headers=None):
        raw = json.dumps(value).encode(encoding) if raw is None else raw
        response = httpx.Response(status, content=raw, headers=headers or {})
        try:
            vector = provider.DaedalusVLLMEmbeddings._extract_embedding(response)
            expected = {"bits": [struct.pack(">d", x).hex() for x in vector]}
        except Exception as exc:
            expected = error(exc)
        responses.append(
            {
                "name": name,
                "status": status,
                "body": base64.b64encode(raw).decode(),
                "headers": headers or {},
                "expected": expected,
            }
        )

    for value in [
        None,
        [],
        {},
        {"data": None},
        {"data": []},
        {"data": [{}, {}]},
        *(
            {"data": [item]}
            for item in [
                None,
                0,
                [],
                "bad",
                {},
                {"embedding": None},
                {"embedding": []},
                {"embedding": 1},
                {"embedding": "bad"},
            ]
        ),
    ]:
        add(f"shape-{len(responses)}", value)
    for vector in [
        [0.1, -0.0, 1.5],
        [True, False],
        ["1_000", " \u0661.\u0662e+2 "],
        ["nan", "-NaN", "Infinity", "-inf"],
        [1e308, 10**308],
        [10**400],
        [None],
        [{}],
        [[]],
        ["bad"],
        ["1__2"],
        ["\ud800"],
        [float("nan"), float("inf"), -float("inf")],
    ]:
        add(f"vector-{len(responses)}", {"data": [{"embedding": vector}]})
    for encoding in [
        "utf-8-sig",
        "utf-16",
        "utf-16-le",
        "utf-16-be",
        "utf-32",
        "utf-32-le",
        "utf-32-be",
    ]:
        add(encoding, {"data": [{"embedding": [0.25]}]}, encoding=encoding)
    add("ignored-surrogate", {"data": [{"embedding": [1]}], "ignored": "\ud800"})
    for raw in [
        b"",
        b"not json",
        b'{"data":[{"embedding":[1,]}]}',
        b'{"data":[{"embedding":[1]}]}\xff',
        b'{"data":[{"embedding":[' + b"9" * 4400 + b"]}]}",
    ]:
        add(f"invalid-json-{len(responses)}", raw=raw)
    for status in [201, 301, 307, 400, 429, 500]:
        add(f"status-{status}", {"data": [{"embedding": [1]}]}, status=status)

    compression = []
    raw = json.dumps({"data": [{"embedding": [0.25, -0.0, "١.٢"]}]}).encode()
    compressor = zstandard.ZstdCompressor()
    for name, encoding, body in [
        ("zstd", "zstd", compressor.compress(raw)),
        (
            "zstd-frames",
            "zstd",
            compressor.compress(raw[:20]) + compressor.compress(raw[20:]),
        ),
        ("broken-zstd", "zstd", b"not zstd"),
        ("stacked", "gzip, deflate", zlib.compress(gzip.compress(raw))),
        ("unknown", "future-codec", raw),
    ]:
        try:
            response = httpx.Response(
                200, content=body, headers={"Content-Encoding": encoding}
            )
            expected = {
                "bits": [
                    struct.pack(">d", n).hex()
                    for n in provider.DaedalusVLLMEmbeddings._extract_embedding(
                        response
                    )
                ]
            }
        except Exception as exc:
            expected = error(exc)
        compression.append(
            {
                "name": name,
                "encoding": encoding,
                "body": base64.b64encode(body).decode(),
                "expected": expected,
            }
        )

    payload = {
        "revision": revision,
        "module_sha256": hashlib.sha256(
            Path(inspect.getfile(provider)).read_bytes()
        ).hexdigest(),
        "configuration_schema": provider.DaedalusVLLMEmbedderConfig.model_json_schema(),
        "configurations": configurations,
        "construction": construction,
        "requests": requests,
        "responses": responses,
        "compression": compression,
        "zstandard_version": zstandard.__version__,
    }
    (root / "tests/fixtures/embeddings.json").write_text(
        json.dumps(
            fixture_strings(fixture_numbers(payload)), ensure_ascii=False, indent=2
        )
        + "\n"
    )
    (root / "resources/embeddings.json").write_text(
        json.dumps({"configuration_schema": payload["configuration_schema"]}, indent=2)
        + "\n"
    )
    print(
        {
            key: len(payload[key])
            for key in ["configurations", "construction", "requests", "responses"]
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    asyncio.run(export(args.root, args.revision))
