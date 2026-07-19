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
            model="gpt-image-2",
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
            model="gpt-image-2",
            image=("source.png", b"image", "image/png"),
            prompt="change the color",
            moderation="low",
            partial_images=2,
        )
    ]


def test_stream_generate_images_forwards_stream_options_and_finalizes_last_partial():
    client = _Client(
        [
            _Event("image_generation.partial_image", "partial-1", 0),
            _Event("image_generation.partial_image", "partial-2", 1),
        ]
    )

    events = _run(_collect(client))

    assert client.images.kwargs == {
        "model": "gpt-image-2",
        "prompt": "draw a river",
        "stream": True,
        "output_format": "webp",
        "partial_images": 2,
    }
    assert [(event.image.b64_json, event.partial) for event in events] == [
        ("partial-1", True),
        ("partial-2", True),
        ("partial-2", False),
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


def test_stream_edit_images_drops_generate_only_moderation():
    client = _Client([_Event("image_edit.completed", "final")])

    events = _run(_collect_edit(client))

    assert client.images.kwargs == {
        "model": "gpt-image-2",
        "image": ("source.png", b"image", "image/png"),
        "prompt": "change the color",
        "stream": True,
        "partial_images": 2,
    }
    assert [(event.image.b64_json, event.partial) for event in events] == [
        ("final", False)
    ]
