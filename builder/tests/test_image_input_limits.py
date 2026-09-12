"""Measure actual decoding while replacing only storage/provider boundaries."""

import asyncio
import base64
import tracemalloc
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError


def test_panel_rejects_more_references_than_the_ui_supports():
    from image_api import EditRequest

    with pytest.raises(ValidationError):
        EditRequest(prompt="edit", imageRefs=[{"imageId": "same"}] * 17)


def test_chat_reuses_identical_decoded_inputs(monkeypatch):
    import visual_media.visual_media_function as mod

    encoded = base64.b64encode(b"x" * (1024 * 1024)).decode()
    fetch = AsyncMock(return_value=(encoded, "image/png"))
    captured = {}

    async def edit(_client, **kwargs):
        captured["parts"] = kwargs["image"]
        captured["peak"] = tracemalloc.get_traced_memory()[1]
        return [SimpleNamespace(b64_json="eA==", mime_type="image/png")]

    monkeypatch.setattr(mod, "fetch_image_from_redis", fetch)
    monkeypatch.setattr(mod, "fetch_image_context", AsyncMock(return_value=None))
    monkeypatch.setattr(
        mod,
        "prepare_image_request",
        AsyncMock(
            return_value=SimpleNamespace(
                prompt="edit",
                params={},
                model_dump=lambda: {},
            )
        ),
    )
    monkeypatch.setattr(mod, "store_image_in_redis", AsyncMock(return_value="result"))
    monkeypatch.setattr(mod, "edit_images", edit)
    monkeypatch.setattr(mod, "resolve_authenticated_user_id", lambda _="": "alice")
    monkeypatch.setattr(mod.AsyncOpenAI.return_value, "close", AsyncMock())

    async def run():
        generator = mod.visual_media_function(
            mod.VisualMediaFunctionConfig(), MagicMock()
        )
        info = await generator.__anext__()
        try:
            tracemalloc.start()
            return await info.fn(
                operation="edit", prompt="edit", imageRef=[{"imageId": "same"}] * 16
            )
        finally:
            tracemalloc.stop()
            await generator.aclose()

    assert "result" in asyncio.run(run())
    print(f"decoded_fetches={fetch.await_count} peak_python_bytes={captured['peak']}")
    assert len(captured["parts"]) == 16  # preserve user order and multiplicity
    assert len({id(part[1]) for part in captured["parts"]}) == 1
    assert fetch.await_count == 1


def test_input_budget_checks_size_before_base64_decode(monkeypatch):
    import nat_helpers.image_input_budget as mod

    monkeypatch.setattr(mod, "MAX_IMAGE_REQUEST_BYTES", 6)
    budget = mod.ImageInputBudget()
    assert budget.decode("MTIzNA==") == b"1234"
    decode = MagicMock(side_effect=AssertionError("oversize payload was decoded"))
    monkeypatch.setattr(mod.base64, "b64decode", decode)
    with pytest.raises(ValueError, match="budget"):
        budget.decode("MTIzNA==")
    decode.assert_not_called()


def test_repeated_parts_still_consume_outbound_budget(monkeypatch):
    import nat_helpers.image_input_budget as mod

    monkeypatch.setattr(mod, "MAX_IMAGE_REQUEST_BYTES", 6)
    budget = mod.ImageInputBudget()
    part = b"abc"
    budget.add_part(part)
    budget.add_part(part)
    with pytest.raises(ValueError, match="multipart"):
        budget.add_part(part)


def test_reference_cache_includes_all_ownership_assertions():
    from nat_helpers.image_input_budget import image_reference_key

    assert image_reference_key(
        {"imageId": "a", "userId": "alice"}
    ) != image_reference_key({"imageId": "a", "userId": "bob"})


@pytest.mark.parametrize("encoded", ["eA==!", "not base64", "%%%%"])
def test_input_budget_rejects_corrupt_base64(encoded):
    from nat_helpers.image_input_budget import ImageInputBudget

    with pytest.raises(ValueError, match="base64"):
        ImageInputBudget().decode(encoded)
