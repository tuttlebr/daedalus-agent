"""Capture the domain retriever's public contracts from the retained Python image.

Run with --network none and PYTHONPATH=/workspace. No service is substituted:
factory initialization is lazy, and formatting uses the real Document model.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from export_authorization import fixture_strings


def canonical(value):
    """Represent nonfinite settings without putting invalid numbers in JSON."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def integer_parts(value):
    """Keep giant synthetic integers lossless without resembling API keys."""
    if isinstance(value, int) and len(str(value)) > 80:
        text = str(value)
        return {"$integer_parts": [text[i : i + 80] for i in range(0, len(text), 80)]}
    if isinstance(value, dict):
        return {key: integer_parts(item) for key, item in value.items()}
    if isinstance(value, list):
        return [integer_parts(item) for item in value]
    return value


async def export(root):
    from daedalus_runtime.retrieval import Document
    from smart_milvus import register as domain

    base = {"uri": "http://milvus:19530", "embedding_model": "synthetic"}
    with patch.dict(os.environ, {}, clear=True):
        defaults = domain.DomainRetrieverConfig(**base)
        async with contextlib.asynccontextmanager(domain.domain_retriever_function)(
            defaults, None
        ) as tool:
            tool.configure_contract("domain_retriever", defaults)
            resource = {
                "schema": tool.schema("domain_search"),
                "configuration_schema": defaults.model_json_schema(),
                "defaults": defaults.model_dump(mode="json", by_alias=True),
            }

        configurations = []
        for name in [
            *domain.DomainRetrieverConfig.model_fields,
            "vector_field",
            "unknown",
        ]:
            for value in [
                None,
                "",
                "synthetic",
                0,
                -1,
                1,
                1.5,
                20,
                50,
                51,
                True,
                [],
                {},
            ]:
                raw = {**base, name: value}
                try:
                    result = domain.DomainRetrieverConfig.model_validate(raw)
                    expected = {"ok": result.model_dump(mode="json", by_alias=True)}
                except ValueError:
                    expected = {"error": True}
                configurations.append({"input": raw, "env": {}, "expected": expected})
        for name in [
            "top_k",
            "reranker_top_n",
            "reranker_min_score",
            "distance_cutoff",
            "search_timeout",
        ]:
            for value in ["1.0", "0", "NaN", "inf", "-inf", -0.0]:
                raw = {**base, name: value}
                try:
                    result = domain.DomainRetrieverConfig.model_validate(raw)
                    expected = {
                        "ok": canonical(result.model_dump(mode="json", by_alias=True))
                    }
                except ValueError:
                    expected = {"error": True}
                configurations.append({"input": raw, "env": {}, "expected": expected})
        for raw in [
            *[
                {**base, name: value}
                for name in ["top_k", "reranker_top_n"]
                for value in [10**400, -(10**400)]
            ],
            {},
            {"uri": base["uri"]},
            {"embedding_model": "synthetic"},
            {**base, "domain_collections": {"custom": "collection"}},
            {**base, "domain_collections": {"custom": 1}},
            {**base, "vector_field": "alias", "vector_field_name": "name"},
            *[
                {**base, "uri": value}
                for value in [
                    "http://EXAMPLE.COM:80",
                    "https://example.com",
                    "ftp://example.com",
                    "http://user:pass@milvus:19530/db",
                ]
            ],
        ]:
            try:
                result = domain.DomainRetrieverConfig.model_validate(raw)
                expected = {"ok": result.model_dump(mode="json", by_alias=True)}
            except ValueError:
                expected = {"error": True}
            configurations.append({"input": raw, "env": {}, "expected": expected})

    for env in [
        {"MILVUS_TOKEN": " synthetic-token ", "MILVUS_USERNAME": "ignored"},
        {"MILVUS_USER": " fallback ", "MILVUS_PASSWORD": " password "},
        {"MILVUS_USERNAME": " ", "MILVUS_USER": "ignored"},
    ]:
        with patch.dict(os.environ, env, clear=True):
            result = domain.DomainRetrieverConfig(**base)
        configurations.append(
            {
                "input": base,
                "env": env,
                "expected": {"ok": result.model_dump(mode="json", by_alias=True)},
            }
        )

    formatting = []
    for count in [0, 1, 20, 21, 50]:
        documents = [
            Document(
                page_content=f"Synthetic 雪🌲 {index}",
                metadata={
                    "source": "https://example.test/source",
                    "distance": index / 10,
                },
            )
            for index in range(count)
        ]
        formatting.append(
            {
                "documents": [d.model_dump() for d in documents],
                "domain": "nvidia",
                "expected": domain._format_domain_results(
                    SimpleNamespace(results=documents), "nvidia"
                ),
            }
        )
    for content in [None, "", " ", "雪🌲\n\t\u007f"]:
        for metadata in [
            {},
            {"source": "", "url": "fallback"},
            {"source": [1, True, "雪"]},
            {"title": "雪" * 2049},
            {"distance": 0.0, "rerank_score": 0.9},
            {"distance": "1e-5", "rerank_score": None},
            {"distance": "bad"},
            {"distance": "NaN", "rerank_score": "inf"},
            {"distance": -0.0, "rerank_score": True},
            {"distance": [1]},
        ]:
            document = Document(page_content=content, metadata=metadata)
            try:
                expected = domain._format_domain_results(
                    SimpleNamespace(results=[document]), "custom"
                )
            except Exception as error:
                expected = {"error": type(error).__name__}
            formatting.append(
                {
                    "documents": [document.model_dump()],
                    "domain": "custom",
                    "expected": expected,
                }
            )
    document = Document(page_content="🌲" * 12001, metadata={"source": "雪" * 2049})
    formatting.append(
        {
            "documents": [document.model_dump()],
            "domain": "custom",
            "expected": domain._format_domain_results(
                SimpleNamespace(results=[document]), "custom"
            ),
        }
    )

    (root / "resources").mkdir(parents=True, exist_ok=True)
    (root / "tests/fixtures").mkdir(parents=True, exist_ok=True)
    (root / "resources/domain-retriever.json").write_text(
        json.dumps(resource, ensure_ascii=True, indent=2) + "\n"
    )
    (root / "tests/fixtures/domain-retriever.json").write_text(
        json.dumps(
            fixture_strings(
                integer_parts(
                    {
                        "source_sha256": hashlib.sha256(
                            Path(domain.__file__).read_bytes()
                        ).hexdigest(),
                        "configuration": configurations,
                        "formatting": formatting,
                    }
                )
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
