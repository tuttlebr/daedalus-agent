"""Tests for shared OpenAI image helper behavior."""

import asyncio
from dataclasses import dataclass

from nat_helpers.openai_images import stream_edit_images, stream_generate_images


def _run(coro):
    return asyncio.run(coro)


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
            model="gpt-image-2.5-sunburst",
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
            model="gpt-image-2.5-sunburst",
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
            model="gpt-image-2.5-sunburst",
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
        "model": "gpt-image-2.5-sunburst",
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
        "model": "gpt-image-2.5-sunburst",
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
        "model": "gpt-image-2.5-sunburst",
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
