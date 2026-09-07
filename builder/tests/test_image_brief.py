import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from nat_helpers import image_brief as mod
from nat_helpers.image_brief import ImageBrief, ImageContext, ImageOptions
from nat_helpers.image_utils import fetch_image_context


def prepare(**kwargs):
    return asyncio.run(
        mod.prepare_image_request(
            model="gpt-image-2",
            mode=kwargs.pop("mode", "generate"),
            prompt=kwargs.pop("prompt", "A watercolor bird"),
            options=kwargs.pop("options", {}),
            **kwargs,
        )
    )


def test_exact_prompt_bypasses_skill_and_model_and_preserves_bytes(monkeypatch):
    planner = AsyncMock(side_effect=AssertionError("must not plan"))
    monkeypatch.setattr(mod, "_plan_brief", planner)
    monkeypatch.setattr(
        mod, "photography_guidance", lambda: pytest.fail("must not load")
    )
    prompt = '  Paint "HELLO"\nwith blue ink.  '
    result = prepare(prompt=prompt, guidance="exact", preserve="face", use_model=True)
    assert result.prompt == result.originalPrompt == prompt
    assert result.guidance == "exact"
    planner.assert_not_called()


def test_create_and_chat_render_the_same_brief_once(monkeypatch):
    brief = ImageBrief(
        medium="watercolor", subject="bird", options=ImageOptions(quality="high")
    )
    planner = AsyncMock(return_value=brief)
    monkeypatch.setattr(mod, "_plan_brief", planner)
    create = prepare(use_model=True)
    chat = prepare(brief=brief)
    assert create.prompt == chat.prompt
    assert create.params == chat.params == {"quality": "high"}
    assert create.skillVersion == chat.skillVersion
    assert "photorealistic" not in create.prompt
    planner.assert_awaited_once()


def test_preparation_failure_preserves_request_and_explicit_constraints(monkeypatch):
    monkeypatch.setattr(mod, "_plan_brief", AsyncMock(side_effect=TimeoutError))
    result = prepare(
        mode="edit",
        prompt="Make the coat blue",
        preserve="face and pose",
        use_model=True,
    )
    assert result.guidance == "fallback"
    assert result.warning
    assert "Make the coat blue" in result.prompt
    assert "face and pose" in result.prompt


def test_reference_order_and_literal_lettering_are_preserved():
    refs = [{"imageId": "product"}, {"imageId": "style"}]
    result = prepare(
        mode="edit",
        prompt='Use Image 2 styling, label it "Acme®".',
        refs=refs,
        brief=ImageBrief(
            references=["product photo", "style reference"], exact_text=["Acme®"]
        ),
    )
    assert result.inputImages == refs
    assert result.prompt.index("Image 1: product photo") < result.prompt.index(
        "Image 2: style reference"
    )
    assert '"Acme®"' in result.prompt
    assert result.prompt.endswith(result.originalPrompt)


def test_bad_agent_reference_indexing_is_rejected():
    with pytest.raises(ValueError, match="Reference descriptions"):
        prepare(refs=[{"imageId": "one"}], brief=ImageBrief(references=["one", "two"]))


def test_invalid_planner_reference_indexing_falls_back(monkeypatch):
    monkeypatch.setattr(
        mod, "_plan_brief", AsyncMock(return_value=ImageBrief(references=["invented"]))
    )
    assert prepare(use_model=True).guidance == "fallback"


def test_latest_request_can_replace_inherited_constraints_and_settings():
    parent = ImageContext(
        originalPrompt="A red coat",
        prompt="old prompt",
        guidance="assisted",
        brief=ImageBrief(preserve=["red coat", "identity"], exact_text=["OLD"]),
        params={"background": "transparent", "quality": "high", "output_format": "png"},
    )
    result = prepare(
        mode="edit",
        prompt="Blue coat on an opaque background, remove the text",
        parent=parent,
        brief=ImageBrief(
            preserve=["identity"],
            exact_text=[],
            options=ImageOptions(background="opaque"),
        ),
        options={"quality": "low"},
    )
    assert result.brief.preserve == ["identity"]
    assert "red coat" not in result.prompt and '"OLD"' not in result.prompt
    assert result.params["quality"] == "low"
    assert result.params["background"] == "opaque"


def test_partial_followup_inherits_rules_but_not_the_previous_edit_or_batch():
    parent = ImageContext(
        originalPrompt="A character",
        prompt="old",
        guidance="assisted",
        brief=ImageBrief(
            medium="watercolor",
            preserve=["identity"],
            exact_text=["ACME"],
            changes=["red coat"],
        ),
        params={"quality": "high", "n": 4},
    )
    result = prepare(
        mode="edit",
        prompt="Make the lighting warmer",
        parent=parent,
        brief=ImageBrief(lighting="warmer"),
    )
    assert result.brief.medium == "watercolor"
    assert result.brief.preserve == ["identity"]
    assert result.brief.exact_text == ["ACME"]
    assert result.brief.changes == []
    assert "n" not in result.params


@pytest.mark.parametrize("size", ["1920x1080", "3841x2160", "512x512", "3840x1024"])
def test_invalid_sizes_rejected_before_optional_model(size, monkeypatch):
    planner = AsyncMock()
    monkeypatch.setattr(mod, "_plan_brief", planner)
    with pytest.raises(ValueError):
        prepare(options={"size": size}, use_model=True)
    planner.assert_not_called()


def test_api_normalization_omits_fidelity_and_preserves_alpha():
    result = mod.normalize_image_options(
        "gpt-image-2",
        {
            "input_fidelity": "high",
            "size": "3840x2160",
            "background": "transparent",
            "output_format": "jpeg",
            "output_compression": 90,
            "moderation": "low",
        },
        "edit",
    )
    assert result == {
        "size": "3840x2160",
        "background": "transparent",
        "output_format": "png",
    }


def test_context_fetch_checks_owner_and_reads_metadata_only():
    context = prepare()
    redis = MagicMock()
    redis.execute_command.return_value = json.dumps(
        {".userId": "alice", ".imageContext": context.model_dump()}
    )
    assert asyncio.run(fetch_image_context(redis, {"imageId": "one"}, "bob")) is None
    assert (
        asyncio.run(fetch_image_context(redis, {"imageId": "one"}, "alice")) == context
    )
    assert redis.execute_command.call_args.args == (
        "JSON.GET",
        "generated:image:one",
        ".userId",
        ".imageContext",
    )


def test_create_route_returns_and_stores_prepared_context(monkeypatch):
    import importlib.util
    import sys
    from pathlib import Path

    import fastapi

    router = SimpleNamespace(post=lambda *args, **kwargs: lambda fn: fn)
    monkeypatch.setattr(fastapi, "APIRouter", lambda **kwargs: router)
    spec = importlib.util.spec_from_file_location(
        "image_api_guidance_test", Path(__file__).parents[1] / "image_api.py"
    )
    image_api = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, image_api)
    spec.loader.exec_module(image_api)

    monkeypatch.setattr(image_api, "_require_trusted_user", lambda *_: "alice")
    monkeypatch.setattr(
        image_api, "_config_for", lambda *_: ("gpt-image-2", "test-key", None)
    )
    monkeypatch.setattr(image_api, "_get_client", lambda *_: object())
    generate = AsyncMock(
        return_value=[SimpleNamespace(b64_json="aW1n", mime_type="image/png")]
    )
    storage = AsyncMock(return_value=["output"])
    monkeypatch.setattr(image_api, "generate_images", generate)
    monkeypatch.setattr(image_api, "_store_results", storage)
    monkeypatch.setattr(
        mod, "_plan_brief", AsyncMock(return_value=ImageBrief(subject="bird"))
    )
    result = asyncio.run(image_api.generate(image_api.GenerateRequest(prompt="A bird")))
    assert result.imageContext.originalPrompt == "A bird"
    assert generate.call_args.kwargs["prompt"] == result.imageContext.prompt
    assert storage.call_args.kwargs["image_context"] == result.imageContext


def test_stream_completion_retains_prepared_context(monkeypatch):
    import image_api
    from nat_helpers.openai_images import ImageResult, ImageStreamEvent

    context = prepare()
    storage = AsyncMock(return_value="output")
    monkeypatch.setattr(image_api, "_store_result", storage)

    async def run():
        async def events():
            yield ImageStreamEvent(ImageResult("aW1n"), partial=False)

        return [
            chunk
            async for chunk in image_api._stream_stored_images(
                events(),
                prompt=context.prompt,
                source="test",
                user_id="alice",
                session_id="session",
                model="gpt-image-2",
                image_context=context,
            )
        ]

    chunks = asyncio.run(run())
    completed = json.loads(chunks[0].split("data: ", 1)[1])
    assert completed["imageContext"] == context.model_dump()
    assert storage.call_args.kwargs["image_context"] == context


def test_chat_runtime_schema_options_description_and_no_second_model_call(monkeypatch):
    from visual_media import visual_media_function as visual

    planner = AsyncMock(side_effect=AssertionError("chat must not call planner"))
    monkeypatch.setattr(mod, "_plan_brief", planner)
    monkeypatch.setattr(visual, "resolve_authenticated_user_id", lambda *_: "alice")
    monkeypatch.setattr(visual.AsyncOpenAI.return_value, "close", AsyncMock())
    generate = AsyncMock(
        return_value=[SimpleNamespace(b64_json="aW1n", mime_type="image/png")]
    )
    monkeypatch.setattr(visual, "generate_images", generate)
    storage = AsyncMock(return_value="output")
    monkeypatch.setattr(visual, "store_image_in_redis", storage)

    async def run():
        generator = visual.visual_media_function(
            visual.VisualMediaFunctionConfig(
                generation_api_key="test-key", description="Source-only rules."
            ),
            MagicMock(),
        )
        info = await generator.__anext__()
        try:
            assert "Source-only rules." in info.description
            assert "gpt-image-2-photography" in info.description
            assert "options" in info.input_schema.model_json_schema()["properties"]
            return await info.fn(
                operation="generate",
                prompt="Four logo ideas",
                brief={"subject": "logo", "medium": "flat vector-like design"},
                options={"n": 4, "background": "transparent", "quality": "high"},
            )
        finally:
            await generator.aclose()

    assert "output" in asyncio.run(run())
    assert generate.call_args.kwargs["n"] == 4
    assert generate.call_args.kwargs["output_format"] == "png"
    assert (
        storage.call_args.kwargs["image_context"]["originalPrompt"] == "Four logo ideas"
    )
    planner.assert_not_called()
