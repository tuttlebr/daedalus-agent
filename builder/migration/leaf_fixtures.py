"""External dependency fixtures, mounted only by leaf_check into test containers."""

import asyncio
import os

import httpx


def install():
    import source_verifier.source_verifier_function as verifier
    from daedalus_runtime.tools import ToolConfig, ToolDefinition, register_tool
    from nat_helpers.agent_loop_guard import current_agent_run

    endpoint = os.environ["DAEDALUS_TEST_PEER"]

    async def fetch(url, config):
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.get(endpoint + "/source", params={"url": url})
            response.raise_for_status()
            return verifier.FetchResult(status="ok", content=response.text)

    verifier._fetch_source = fetch

    class StatefulConfig(ToolConfig, name="fixture_stateful"):
        pass

    @register_tool(config_type=StatefulConfig)
    async def stateful(config, registry):
        async def call(label: str):
            """Return the label and increment the current run sequence."""
            run = current_agent_run()
            before = run.attempts["sequence"]
            await asyncio.sleep(0.02)
            run.attempts["sequence"] += 1
            return {"label": label, "before": before}

        yield ToolDefinition.from_fn(call)
