"""Tests for the consolidated NVIDIA documentation capability."""

import asyncio
import json

import pytest
from nat_helpers import nvidia_docs
from pydantic import ValidationError


class _FakeClient:
    def __init__(self, result=None, delay=0):
        self.result = result or {"content": [{"text": "official result"}]}
        self.delay = delay
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.result


@pytest.mark.parametrize(
    "product",
    ["dynamo", "openshell", "aistore", "aiperf", "nvcf", "dsx"],
)
def test_product_routes_to_one_fixed_endpoint(monkeypatch, product):
    built = []
    client = _FakeClient()

    def _factory(endpoint, timeout):
        built.append((endpoint, timeout))
        return client

    monkeypatch.setattr(nvidia_docs, "_build_mcp_client", _factory)

    payload = json.loads(
        asyncio.run(
            nvidia_docs.search_nvidia_docs(product, "  configuration  ", timeout=5)
        )
    )

    assert built == [(nvidia_docs.NVIDIA_DOCS_ENDPOINTS[product], 5)]
    assert client.calls == [("searchDocs", {"query": "configuration"})]
    assert payload["product"] == product
    assert payload["endpoint"] == nvidia_docs.NVIDIA_DOCS_ENDPOINTS[product]


def test_product_schema_rejects_arbitrary_endpoint_selection():
    with pytest.raises(ValidationError):
        nvidia_docs.NvidiaDocsInput(product="https://example.test/mcp", query="x")


def test_search_has_one_end_to_end_timeout(monkeypatch):
    monkeypatch.setattr(
        nvidia_docs,
        "_build_mcp_client",
        lambda *_args: _FakeClient(delay=0.05),
    )

    payload = json.loads(
        asyncio.run(nvidia_docs.search_nvidia_docs("dynamo", "routing", timeout=0.01))
    )

    assert payload == {"error": "docs_timeout", "product": "dynamo"}
