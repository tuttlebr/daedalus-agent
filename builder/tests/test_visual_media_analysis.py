"""Returned image references must support authenticated visual checks."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from nat_helpers.identity import authenticated_request_headers_scope
from visual_media import visual_media_function as visual

IMAGE_ID = "12345678-abcd-4321-abcd-123456789abc"
IMAGE_PATH = f"/api/generated-image/{IMAGE_ID}"
IMAGE_REF = {"imageId": IMAGE_ID, "sessionId": "generated"}
IMAGE_DATA = "aW1hZ2U="


@pytest.fixture
def analysis_tool(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "synthetic-token")
    records = {
        f"generated:image:{IMAGE_ID}": json.dumps(
            {"data": IMAGE_DATA, "mimeType": "image/png", "userId": "alice"}
        )
    }
    redis_client = MagicMock()
    redis_client.execute_command.side_effect = lambda _command, key: records.get(key)
    monkeypatch.setattr(visual.redis, "from_url", lambda *_args, **_kw: redis_client)
    client = MagicMock()
    response = MagicMock()
    response.json.return_value = {
        "choices": [{"message": {"content": "The image matches the request."}}]
    }
    client.post = AsyncMock(return_value=response)
    client.aclose = AsyncMock()
    monkeypatch.setattr(visual.httpx, "AsyncClient", lambda **_kw: client)

    async def invoke(arguments, user="alice", token="synthetic-token"):
        config = visual.VisualMediaFunctionConfig()
        generator = visual.visual_media_function(config, MagicMock())
        tool = await generator.__anext__()
        tool.configure_contract("visual_media", config)
        try:
            with authenticated_request_headers_scope(
                {"x-user-id": user, "x-daedalus-internal-token": token}
            ):
                return await tool.ainvoke(
                    {
                        "operation": "analyze",
                        "question": "Does this image match the request?",
                        **arguments,
                    }
                )
        finally:
            await generator.aclose()

    return SimpleNamespace(
        invoke=invoke, client=client, redis=redis_client, records=records
    )


@pytest.mark.parametrize(
    "arguments",
    [
        {"image_url": IMAGE_PATH},
        {"image_url": f"![Generated image]({IMAGE_PATH})"},
        {"imageRef": IMAGE_PATH},
        {"imageRef": f"![Edited image]({IMAGE_PATH})"},
        {"imageRef": IMAGE_REF},
        {"imageRef": json.dumps(IMAGE_REF)},
    ],
)
def test_analyze_returned_image_uses_stored_bytes(analysis_tool, arguments):
    result = asyncio.run(analysis_tool.invoke(arguments))

    assert result == "The image matches the request."
    analysis_tool.redis.execute_command.assert_any_call(
        "JSON.GET", f"generated:image:{IMAGE_ID}"
    )
    payload = analysis_tool.client.post.call_args.kwargs["json"]
    assert payload["messages"][1]["content"][1] == {
        "type": "image_url",
        "image_url": {"url": f"data:image/png;base64,{IMAGE_DATA}"},
    }


@pytest.mark.parametrize("field", ["image_url", "imageRef"])
def test_analyze_returned_image_rejects_other_owner(analysis_tool, field):
    result = asyncio.run(analysis_tool.invoke({field: IMAGE_PATH}, user="bob"))

    assert "different authenticated user" in result
    analysis_tool.client.post.assert_not_awaited()


@pytest.mark.parametrize("field", ["image_url", "imageRef"])
@pytest.mark.parametrize("identity", [{"user": ""}, {"token": "wrong-token"}])
def test_analyze_returned_image_requires_trusted_identity(
    analysis_tool, field, identity
):
    result = asyncio.run(analysis_tool.invoke({field: IMAGE_PATH}, **identity))

    assert result.startswith("Error: visual media request denied:")
    analysis_tool.redis.execute_command.assert_not_called()
    analysis_tool.client.post.assert_not_awaited()


def test_analyze_expired_image_does_not_call_vlm(analysis_tool):
    analysis_tool.records.clear()

    result = asyncio.run(analysis_tool.invoke({"image_url": IMAGE_PATH}))

    assert "Image not found" in result
    analysis_tool.client.post.assert_not_awaited()


@pytest.mark.parametrize(
    "url",
    [
        "/api/session/imageStorage",
        "/api/generated-image/",
        "/api/generated-image/../private",
        "/api/generated-image/%2e%2e",
        f"{IMAGE_PATH}/extra",
        f"//127.0.0.1{IMAGE_PATH}",
        f"http://127.0.0.1{IMAGE_PATH}",
        f"http://169.254.169.254{IMAGE_PATH}",
        "file:///etc/passwd",
        "data:image/png;base64,AAAA",
    ],
)
def test_analyze_does_not_treat_other_urls_as_app_images(analysis_tool, url):
    result = asyncio.run(analysis_tool.invoke({"image_url": url}))

    assert result.startswith("Error: media URL is not allowed:")
    analysis_tool.redis.execute_command.assert_not_called()
    analysis_tool.client.post.assert_not_awaited()
