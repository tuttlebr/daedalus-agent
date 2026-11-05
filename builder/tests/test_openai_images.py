"""Tests for shared OpenAI image helper behavior."""

import asyncio
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from nat_helpers.openai_images import (
    edit_images,
    generate_images,
    stream_edit_images,
    stream_generate_images,
)


def _run(coro):
    return asyncio.run(coro)


def test_gif_generation_uses_sdk_extension_fields_and_returns_gif_mime():
    from unittest.mock import AsyncMock

    client = SimpleNamespace(
        images=SimpleNamespace(
            generate=AsyncMock(
                return_value=SimpleNamespace(
                    data=[SimpleNamespace(b64_json="R0lGODlh")]
                )
            )
        )
    )
    results = _run(
        generate_images(
            client,
            model="gpt-image-2.6-sunburst",
            prompt="A waving bird loop",
            output_format="gif",
            frame_count=3,
            frame_duration_ms=125,
            complexity="low",
            partial_images=2,
            stream=True,
            output_compression=70,
        )
    )
    assert client.images.generate.call_args.kwargs == {
        "model": "gpt-image-2.6-sunburst",
        "prompt": "A waving bird loop",
        "output_format": "gif",
        "extra_body": {"complexity": "low", "frame_count": 3, "frame_duration_ms": 130},
    }
    assert results[0].mime_type == "image/gif"


def test_gif_streaming_is_rejected_before_provider_call():
    async def collect():
        return [
            event
            async for event in stream_generate_images(
                None, model="gpt-image-2.6-sunburst", prompt="loop", output_format="gif"
            )
        ]

    with pytest.raises(ValueError, match="streaming"):
        _run(collect())


def test_image_to_gif_forwards_source_and_animation_settings():
    from unittest.mock import AsyncMock

    provider = AsyncMock(
        return_value=SimpleNamespace(data=[SimpleNamespace(b64_json="R0lGODlh")])
    )
    client = SimpleNamespace(images=SimpleNamespace(edit=provider))
    source = ("source.png", b"source-image", "image/png")
    results = _run(
        edit_images(
            client,
            model="gpt-image-2.6-sunburst",
            image=source,
            prompt="Animate this reference",
            output_format="gif",
            frame_count=3,
            frame_duration_ms=125,
            complexity="low",
            stream=True,
            partial_images=2,
            output_compression=70,
        )
    )
    assert provider.call_args.kwargs == {
        "model": "gpt-image-2.6-sunburst",
        "image": source,
        "prompt": "Animate this reference",
        "output_format": "gif",
        "extra_body": {"complexity": "low", "frame_count": 3, "frame_duration_ms": 130},
    }
    assert results[0].mime_type == "image/gif"


def test_gif_edit_rejects_mask_and_stream_before_provider_call():
    with pytest.raises(ValueError, match="masks"):
        _run(
            edit_images(
                None,
                model="gpt-image-2.6-sunburst",
                image=b"source",
                prompt="loop",
                output_format="gif",
                mask=b"mask",
            )
        )

    async def collect():
        return [
            event
            async for event in stream_edit_images(
                None,
                model="gpt-image-2.6-sunburst",
                image=b"source",
                prompt="loop",
                output_format="gif",
            )
        ]

    with pytest.raises(ValueError, match="streaming"):
        _run(collect())


@dataclass
class _Event:
    type: str
    b64_json: str
    partial_image_index: int | None = None


class _Stream:
    def __init__(self, events):
        self.events = events

    async def __aiter__(self):
        for event in self.events:
            yield event


class _Images:
    def __init__(self, events):
        self.events = events
        self.kwargs = None

    async def generate(self, **kwargs):
        self.kwargs = kwargs
        return _Stream(self.events)

    async def edit(self, **kwargs):
        self.kwargs = kwargs
        return _Stream(self.events)


class _Client:
    def __init__(self, events):
        self.images = _Images(events)


async def _collect(client):
    return [
        event
        async for event in stream_generate_images(
            client,
            model="gpt-image-2.6-sunburst",
            prompt="draw a river",
            output_format="webp",
            partial_images=2,
        )
    ]


async def _collect_edit(client):
    return [
        event
        async for event in stream_edit_images(
            client,
            model="gpt-image-2.6-sunburst",
            image=("source.png", b"image", "image/png"),
            prompt="change the color",
            moderation="low",
            background="transparent",
            output_format="jpeg",
            output_compression=70,
            partial_images=2,
        )
    ]


async def _collect_transparent_generate(client):
    return [
        event
        async for event in stream_generate_images(
            client,
            model="gpt-image-2.6-sunburst",
            prompt="draw an isolated river icon",
            background="transparent",
            partial_images=2,
        )
    ]


def test_stream_generate_images_forwards_options_without_promoting_partials():
    client = _Client(
        [
            _Event("image_generation.partial_image", "partial-1", 0),
            _Event("image_generation.partial_image", "partial-2", 1),
        ]
    )

    events = _run(_collect(client))

    assert client.images.kwargs == {
        "model": "gpt-image-2.6-sunburst",
        "prompt": "draw a river",
        "stream": True,
        "output_format": "webp",
        "partial_images": 2,
    }
    assert [(event.image.b64_json, event.partial) for event in events] == [
        ("partial-1", True),
        ("partial-2", True),
    ]
    assert all(event.image.mime_type == "image/webp" for event in events)


def test_stream_generate_images_uses_explicit_completed_event():
    client = _Client(
        [
            _Event("image_generation.partial_image", "partial", 0),
            _Event("image_generation.completed", "final"),
        ]
    )

    events = _run(_collect(client))

    assert [(event.image.b64_json, event.partial) for event in events] == [
        ("partial", True),
        ("final", False),
    ]


def test_stream_generate_images_uses_png_for_transparent_output_by_default():
    client = _Client([_Event("image_generation.completed", "final")])

    events = _run(_collect_transparent_generate(client))

    assert client.images.kwargs == {
        "model": "gpt-image-2.6-sunburst",
        "prompt": "draw an isolated river icon",
        "stream": True,
        "background": "transparent",
        "output_format": "png",
        "partial_images": 2,
    }
    assert events[0].image.mime_type == "image/png"


def test_stream_edit_images_drops_moderation_and_normalizes_transparent_jpeg():
    client = _Client([_Event("image_edit.completed", "final")])

    events = _run(_collect_edit(client))

    assert client.images.kwargs == {
        "model": "gpt-image-2.6-sunburst",
        "image": ("source.png", b"image", "image/png"),
        "prompt": "change the color",
        "stream": True,
        "background": "transparent",
        "output_format": "png",
        "partial_images": 2,
    }
    assert [(event.image.b64_json, event.partial) for event in events] == [
        ("final", False)
    ]


def test_image_stream_error_does_not_promote_a_partial_to_success():
    import pytest
    from nat_helpers.openai_images import _stream_image_events

    async def broken():
        yield {"type": "image_generation.partial_image", "partial_image_b64": "eA=="}
        raise OSError("fixture connection interrupted")

    async def collect():
        events = []
        with pytest.raises(OSError, match="interrupted"):
            async for event in _stream_image_events(broken(), "image/png"):
                events.append(event)
        assert len(events) == 1 and events[0].partial is True

    asyncio.run(collect())


def test_abandoning_image_stream_closes_provider_connection():
    async def check():
        class Stream(_Stream):
            closed = False

            async def close(self):
                self.closed = True

        for mode in ("generate", "edit"):
            stream = Stream([_Event("image_generation.partial_image", "partial", 0)])
            client = _Client([])

            async def create(**kwargs):
                return stream

            setattr(client.images, mode, create)
            options = (
                {"image": ("input.png", b"image", "image/png")}
                if mode == "edit"
                else {}
            )
            function = stream_edit_images if mode == "edit" else stream_generate_images
            events = function(
                client, model="gpt-image-2.6-sunburst", prompt="fixture", **options
            )
            await events.__anext__()
            assert not stream.closed
            await events.aclose()
            assert stream.closed

    _run(check())


@pytest.mark.parametrize("mode", ["generate", "edit"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("complexity", [None, "low", "medium", "high"])
def test_sunburst_complexity_reaches_sdk_for_all_request_paths(
    mode, stream, complexity
):
    client = _Client([])
    captured = {}

    async def call(**kwargs):
        captured.update(kwargs)
        if stream:
            event_type = "image_edit" if mode == "edit" else "image_generation"
            return _Stream([_Event(f"{event_type}.completed", "final")])
        return SimpleNamespace(data=[SimpleNamespace(b64_json="final")])

    setattr(client.images, mode, call)
    kwargs = {
        "model": "gpt-image-2.6-sunburst",
        "prompt": "fixture",
        "complexity": complexity,
        "quality": "max",
        "input_fidelity": "high",
    }
    if mode == "edit":
        kwargs["image"] = ("source.png", b"source", "image/png")
        kwargs["mask"] = ("mask.png", b"mask", "image/png")

    async def run():
        if stream:
            function = stream_edit_images if mode == "edit" else stream_generate_images
            return [event async for event in function(client, **kwargs)]
        function = edit_images if mode == "edit" else generate_images
        return await function(client, **kwargs)

    assert len(_run(run())) == 1
    assert captured["model"] == "gpt-image-2.6-sunburst"
    assert captured["quality"] == "max"
    assert "input_fidelity" not in captured
    assert "complexity" not in captured  # Not a named argument in the pinned SDK.
    if complexity is None:
        assert "extra_body" not in captured
    else:
        assert captured["extra_body"] == {"complexity": complexity}
    if mode == "edit":
        assert captured["image"] == kwargs["image"]
        assert captured["mask"] == kwargs["mask"]
