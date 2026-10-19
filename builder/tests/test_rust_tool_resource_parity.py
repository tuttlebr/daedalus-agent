"""Python rollback registrations match the Rust contract resources exported from them.

``builder/migration/export_document_tools.py`` and ``export_domain_retriever.py``
generate ``runtime/resources/document-tools.json`` and ``domain-retriever.json``
from these Python registrations. Rust preparation advertises the resource
schema, while Python preparation (the rollback path) advertises the live Python
schema, so a change to either side must be re-exported rather than drift.
"""

import asyncio
import contextlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

RESOURCES = Path(__file__).resolve().parents[1] / "runtime" / "resources"


def _resource(name: str) -> dict:
    return json.loads((RESOURCES / name).read_text(encoding="utf-8"))


def _configured_schema(factory, config, name: str) -> dict:
    async def load():
        async with contextlib.asynccontextmanager(factory)(config, None) as tool:
            return tool.schema(name)

    return asyncio.run(load())


@pytest.fixture
def export_environment():
    # The exporters run with an empty environment so defaults are reproducible.
    with patch.dict(os.environ, {}, clear=True):
        yield


@pytest.mark.usefixtures("export_environment")
def test_document_tool_schema_and_defaults_match_rust_resource():
    from nat_nv_ingest.nat_nv_ingest import NvIngestFunctionConfig, nv_ingest_function

    resource = _resource("document-tools.json")
    config = NvIngestFunctionConfig()

    assert (
        _configured_schema(nv_ingest_function, config, resource["schema"]["name"])
        == resource["schema"]
    )
    assert config.model_dump() == resource["defaults"]


@pytest.mark.usefixtures("export_environment")
def test_domain_retriever_schema_and_defaults_match_rust_resource():
    from smart_milvus.register import DomainRetrieverConfig, domain_retriever_function

    resource = _resource("domain-retriever.json")
    # Same required connection fields as export_domain_retriever.py.
    config = DomainRetrieverConfig(
        uri="http://milvus:19530", embedding_model="synthetic"
    )

    assert (
        _configured_schema(
            domain_retriever_function, config, resource["schema"]["name"]
        )
        == resource["schema"]
    )
    assert config.model_dump(mode="json", by_alias=True) == resource["defaults"]
