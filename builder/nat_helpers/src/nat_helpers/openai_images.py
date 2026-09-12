"""Shared client wrappers for OpenAI's /v1/images/* endpoints.

The unified visual_media agent tool and the dedicated user-facing panel's
FastAPI routes both call these helpers so the SDK surface is consumed in
exactly one place.

Targets the gpt-image-2.5-sunburst schema — all optional kwargs listed in that
schema are forwarded verbatim when the caller sets them, and dropped
when they're None (so SDK defaults kick in). The helper is also
parameter-compatible with earlier gpt-image-1.x models for the shared
kwargs. GPT Image 2.5 Sunburst transparent backgrounds are normalized to an
alpha-capable PNG or WebP output before the request is sent.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from nat_helpers.content_credentials import check_signing_configuration
from nat_helpers.image_brief import normalize_image_options
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
    pruned = {k: v for k, v in mapping.items() if k in allowed and v is not None}
    if pruned.get("background") == "transparent":
        # JPEG cannot carry an alpha channel. PNG is the API default and the
        # cookbook-recommended format; preserve WebP when explicitly selected.
        if pruned.get("output_format") not in {"png", "webp"}:
            pruned["output_format"] = "png"
        if pruned["output_format"] == "png":
            pruned.pop("output_compression", None)
    return pruned


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

    Only explicit provider completion events are final. An exhausted or
    interrupted stream must never promote a preview into signed final output.
    """
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
            yield partial
            continue

        if event_type in {"image_generation.completed", "image_edit.completed"}:
            for result in _event_results(event, mime):
                yield ImageStreamEvent(image=result, partial=False)


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
    kwargs = {
        "model": model,
        "prompt": prompt,
        **_prune(normalize_image_options(model, options, "generate"), _GENERATE_KEYS),
    }
    logger.info(
        "images.generate model=%s n=%s quality=%s size=%s",
        model,
        kwargs.get("n"),
        kwargs.get("quality"),
        kwargs.get("size"),
    )

    check_signing_configuration()
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
        **_prune(
            normalize_image_options(model, options, "generate"), _GENERATE_STREAM_KEYS
        ),
    }
    logger.info(
        "images.generate stream model=%s n=%s quality=%s size=%s partial_images=%s",
        model,
        kwargs.get("n"),
        kwargs.get("quality"),
        kwargs.get("size"),
        kwargs.get("partial_images"),
    )
    check_signing_configuration()
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
        **_prune(normalize_image_options(model, options, "edit"), _EDIT_KEYS),
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

    check_signing_configuration()
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
        **_prune(normalize_image_options(model, options, "edit"), _EDIT_STREAM_KEYS),
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
    check_signing_configuration()
    stream = await client.images.edit(**kwargs)
    async for event in _stream_image_events(
        stream, _mime_for_output_format(kwargs.get("output_format"))
    ):
        yield event
