"""External dependency fixtures, mounted only by leaf_check into test containers."""

import asyncio
import os

import httpx


def install():
    import nat_nv_ingest.nat_nv_ingest as documents
    import pymilvus
    import source_verifier.source_verifier_function as verifier
    from daedalus_runtime.tools import ToolConfig, ToolDefinition, register_tool
    from nat_helpers.agent_loop_guard import current_agent_run

    endpoint = os.environ["DAEDALUS_TEST_PEER"]

    class Milvus:
        def __init__(self, **kwargs):
            pass

        def request(self, operation, **kwargs):
            with httpx.Client(trust_env=False) as client:
                response = client.post(endpoint + "/milvus/" + operation, json=kwargs)
                response.raise_for_status()
                return response.json()

        def list_collections(self, **kwargs):
            return self.request("list", **kwargs)

        def describe_collection(self, collection_name, **kwargs):
            return self.request("describe", collection_name=collection_name, **kwargs)

        def search(self, **kwargs):
            return self.request("search", **kwargs)

        def close(self):
            pass

    async def fetch(url, config):
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.get(endpoint + "/source", params={"url": url})
            response.raise_for_status()
            return verifier.FetchResult(status="ok", content=response.text)

    documents.MilvusClient = Milvus
    pymilvus.MilvusClient = Milvus
    verifier._fetch_source = fetch

    class StatefulConfig(ToolConfig, name="fixture_stateful"):
        pass

    @register_tool(config_type=StatefulConfig)
    async def stateful(config, registry):
        async def call(label: str):
            run = current_agent_run()
            before = run.attempts["sequence"]
            await asyncio.sleep(0.02)
            run.attempts["sequence"] += 1
            return {"label": label, "before": before}

        yield ToolDefinition.from_fn(call)
