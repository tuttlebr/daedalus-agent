"""The transitional executor never owns runs or loses state after a leaf fails."""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
from daedalus_runtime.service import ToolService, create_app
from daedalus_runtime.tools import ToolDefinition
from nat_helpers.agent_loop_guard import current_agent_run
from nat_helpers.identity import authenticated_user_id_from_context
from opentelemetry import trace


def check_executor():
    fixture = json.loads(Path("/fixtures/executor-v1.json").read_text())
    os.environ["DAEDALUS_INTERNAL_API_TOKEN"] = "synthetic-internal-token"  # nosec B105
    os.environ["DAEDALUS_MEMORY_MODE"] = "disabled"
    identities = []

    async def leaf(fail: bool = False):
        assert trace.get_current_span().get_span_context().trace_id == int(
            "1234567890abcdef1234567890abcdef", 16
        )
        identities.append(authenticated_user_id_from_context())
        run = current_agent_run()
        run.attempts["briefing"] += 1
        if fail:
            raise RuntimeError("PRIVATE_ERROR_CONTENT")
        return str(run.attempts["briefing"])

    class Registry:
        async def get_function(self, name):
            assert name == "fixture_tool"
            return ToolDefinition.from_fn(leaf)

    async def check():
        app = create_app()
        service = ToolService(
            {"workflow": {"tools": ["fixture_tool"]}},
            Registry(),
            SimpleNamespace(groups={}),
        )
        app.state.tools = service
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client:
            headers = {
                "x-daedalus-internal-token": "synthetic-internal-token",
                "x-user-id": "synthetic-alice",
                "traceparent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
            }

            async def call(body, owner="synthetic-alice"):
                return await client.post(
                    "/runtime/v1/tools/call",
                    headers=headers | {"x-user-id": owner},
                    json=body,
                )

            body = copy.deepcopy(fixture["request"])
            response = await call(body)
            assert response.status_code == 200
            result = json.loads(response.text.splitlines()[-1])["data"]
            assert result == fixture["result"]
            assert "PRIVATE_ERROR_CONTENT" not in response.text
            assert not service.runs
            body["arguments"]["fail"] = False
            body["context"]["executor_state"] = result["executor_state"]
            assert (
                json.loads((await call(body)).text.splitlines()[-1])["data"]["content"]
                == "3"
            )
            body["context"]["executor_state"] = {}
            assert (
                json.loads((await call(body, "synthetic-bob")).text.splitlines()[-1])[
                    "data"
                ]["content"]
                == "1"
            )
            body["context"]["available_tools"] = []
            assert (await call(body)).status_code == 400
            body["context"]["version"] = 2
            assert (await call(body)).status_code == 422
            assert (
                await client.post("/runtime/v1/tools/call", json=fixture["request"])
            ).status_code == 401
            assert identities == ["synthetic-alice", "synthetic-alice", "synthetic-bob"]
            assert not service.runs
        await service.outputs.close()

    asyncio.run(check())


if __name__ == "__main__":
    check_executor()
    print("Explicit executor v1 state, identity, validation and run ownership passed")
