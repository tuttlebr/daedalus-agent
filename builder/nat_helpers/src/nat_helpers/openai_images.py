"""Shared client wrappers for OpenAI's /v1/images/* endpoints.

The unified visual_media agent tool and the dedicated user-facing panel's
FastAPI routes both call these helpers so the SDK surface is consumed in
exactly one place.

Targets the gpt-image-2 schema — all optional kwargs listed in that
schema are forwarded verbatim when the caller sets them, and dropped
when they're None (so SDK defaults kick in). The helper is also
parameter-compatible with earlier gpt-image-1.x models for the shared
kwargs; model-specific constraints (e.g. gpt-image-2 not supporting
`background: transparent`, or `input_fidelity` being a no-op for
gpt-image-2 edits) are enforced by the API, not here.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ImageResult:
    """A single image returned from OpenAI's images API."""

    b64_json: str
    mime_type: str = "image/png"


@dataclass(slots=True)
class ImageStreamEvent:
    """A streamed image event from OpenAI's images API."""

    image: ImageResult
    partial: bool
    partial_index: int | None = None
    image_index: int = 0


# Keys forwarded verbatim when set. Both endpoints share most of these;
# moderation is generation-only and input_fidelity is edits-only. None values
# are dropped centrally so the SDK defaults kick in.
_GENERATE_KEYS = (
    "quality",
    "size",
    "n",
    "output_format",
    "output_compression",
    "background",
    "moderation",
    "user",
)

_EDIT_KEYS = (
    "quality",
    "size",
    "n",
    "output_format",
    "output_compression",
    "background",
    "input_fidelity",
    "user",
)

_GENERATE_STREAM_KEYS = (*_GENERATE_KEYS, "partial_images")
_EDIT_STREAM_KEYS = (*_EDIT_KEYS, "partial_images")


def _mime_for_output_format(output_format: str | None) -> str:
    match output_format:
        case "jpeg":
            return "image/jpeg"
        case "webp":
            return "image/webp"
        case _:
            return "image/png"


def _prune(mapping: dict[str, Any], allowed: tuple[str, ...]) -> dict[str, Any]:
    return {k: v for k, v in mapping.items() if k in allowed and v is not None}


def _event_value(event: Any, key: str) -> Any:
    if isinstance(event, dict):
        return event.get(key)
    return getattr(event, key, None)


def _event_image_index(event: Any) -> int:
    value = (
        _event_value(event, "image_index")
        or _event_value(event, "index")
        or _event_value(event, "output_index")
        or 0
    )
    return value if isinstance(value, int) else 0


def _event_b64(event: Any) -> str | None:
    value = _event_value(event, "b64_json") or _event_value(event, "partial_image_b64")
    return value if isinstance(value, str) and value else None


def _event_results(event: Any, mime: str) -> list[ImageResult]:
    b64 = _event_b64(event)
    if b64:
        return [ImageResult(b64_json=b64, mime_type=mime)]

    data = _event_value(event, "data")
    if isinstance(data, list):
        return [
            ImageResult(b64_json=item["b64_json"], mime_type=mime)
            for item in data
            if isinstance(item, dict) and item.get("b64_json")
        ]
    return []


async def _stream_image_events(
    stream: Any,
    mime: str,
) -> AsyncIterator[ImageStreamEvent]:
    """Normalize OpenAI image stream events.

    The Image API examples currently surface final images as stream events too.
    If there is no explicit completed event, use the last partial per image as
    the final result so callers still finish cleanly.
    """
    last_by_image: dict[int, ImageStreamEvent] = {}
    saw_final = False

    async for event in stream:
        event_type = str(_event_value(event, "type") or "")
        if event_type.endswith(".partial_image") or event_type.endswith(
            "partial_image"
        ):
            b64 = _event_b64(event)
            if not b64:
                continue
            image_index = _event_image_index(event)
            partial = ImageStreamEvent(
                image=ImageResult(b64_json=b64, mime_type=mime),
                partial=True,
                partial_index=_event_value(event, "partial_image_index"),
                image_index=image_index,
            )
            last_by_image[image_index] = partial
            yield partial
            continue

        if "completed" in event_type or "final" in event_type:
            for result in _event_results(event, mime):
                saw_final = True
                yield ImageStreamEvent(image=result, partial=False)

    if not saw_final:
        for image_index in sorted(last_by_image):
            partial = last_by_image[image_index]
            yield ImageStreamEvent(
                image=partial.image,
                partial=False,
                partial_index=partial.partial_index,
                image_index=image_index,
            )


async def generate_images(
    client: AsyncOpenAI,
    *,
    model: str,
    prompt: str,
    **options: Any,
) -> list[ImageResult]:
    """Call client.images.generate and unpack the response.

    Raises on API error so callers can decide how to report it.
    """
    kwargs = {"model": model, "prompt": prompt, **_prune(options, _GENERATE_KEYS)}
    logger.info(
        "images.generate model=%s n=%s quality=%s size=%s",
        model,
        kwargs.get("n"),
        kwargs.get("quality"),
        kwargs.get("size"),
    )

    response = await client.images.generate(**kwargs)
    mime = _mime_for_output_format(kwargs.get("output_format"))

    results: list[ImageResult] = []
    for item in response.data or []:
        b64 = getattr(item, "b64_json", None)
        if b64:
            results.append(ImageResult(b64_json=b64, mime_type=mime))
    return results


async def stream_generate_images(
    client: AsyncOpenAI,
    *,
    model: str,
    prompt: str,
    **options: Any,
) -> AsyncIterator[ImageStreamEvent]:
    """Stream client.images.generate and normalize partial/final images."""
    kwargs = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        **_prune(options, _GENERATE_STREAM_KEYS),
    }
    logger.info(
        "images.generate stream model=%s n=%s quality=%s size=%s partial_images=%s",
        model,
        kwargs.get("n"),
        kwargs.get("quality"),
        kwargs.get("size"),
        kwargs.get("partial_images"),
    )
    stream = await client.images.generate(**kwargs)
    async for event in _stream_image_events(
        stream, _mime_for_output_format(kwargs.get("output_format"))
    ):
        yield event


async def edit_images(
    client: AsyncOpenAI,
    *,
    model: str,
    image: Any,
    prompt: str,
    mask: Any | None = None,
    **options: Any,
) -> list[ImageResult]:
    """Call client.images.edit and unpack the response.

    `image` is the shape the SDK accepts — a single file-like/tuple or a
    list of them. `mask`, when provided, is a single file-like/tuple.
    """
    kwargs: dict[str, Any] = {
        "model": model,
        "image": image,
        "prompt": prompt,
        **_prune(options, _EDIT_KEYS),
    }
    if mask is not None:
        kwargs["mask"] = mask

    logger.info(
        "images.edit model=%s n=%s quality=%s size=%s input_fidelity=%s mask=%s",
        model,
        kwargs.get("n"),
        kwargs.get("quality"),
        kwargs.get("size"),
        kwargs.get("input_fidelity"),
        mask is not None,
    )

    response = await client.images.edit(**kwargs)
    mime = _mime_for_output_format(kwargs.get("output_format"))

    results: list[ImageResult] = []
    for item in response.data or []:
        b64 = getattr(item, "b64_json", None)
        if b64:
            results.append(ImageResult(b64_json=b64, mime_type=mime))
    return results


async def stream_edit_images(
    client: AsyncOpenAI,
    *,
    model: str,
    image: Any,
    prompt: str,
    mask: Any | None = None,
    **options: Any,
) -> AsyncIterator[ImageStreamEvent]:
    """Stream client.images.edit and normalize partial/final images."""
    kwargs: dict[str, Any] = {
        "model": model,
        "image": image,
        "prompt": prompt,
        "stream": True,
        **_prune(options, _EDIT_STREAM_KEYS),
    }
    if mask is not None:
        kwargs["mask"] = mask

    logger.info(
        "images.edit stream model=%s n=%s quality=%s size=%s partial_images=%s mask=%s",
        model,
        kwargs.get("n"),
        kwargs.get("quality"),
        kwargs.get("size"),
        kwargs.get("partial_images"),
        mask is not None,
    )
    stream = await client.images.edit(**kwargs)
    async for event in _stream_image_events(
        stream, _mime_for_output_format(kwargs.get("output_format"))
    ):
        yield event
