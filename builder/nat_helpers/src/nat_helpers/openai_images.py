"""Shared client wrappers for OpenAI's /v1/images/* endpoints.

Both the agent tools (image_generation, image_augmentation) and the
dedicated user-facing panel's FastAPI routes use these helpers so the
SDK surface is consumed in exactly one place.

All the optional kwargs that gpt-image-1 / gpt-image-1.5 accept are
forwarded verbatim when the caller sets them, and dropped when they're
None (so SDK defaults kick in).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ImageResult:
    """A single image returned from OpenAI's images API."""

    b64_json: str
    mime_type: str = "image/png"


# Keys forwarded verbatim when set. Both endpoints share most of these;
# input_fidelity is edits-only and style is dall-e-3-only but the SDK
# tolerates extras that equal None so we drop None centrally.
_GENERATE_KEYS = (
    "quality",
    "size",
    "n",
    "output_format",
    "output_compression",
    "background",
    "moderation",
    "style",
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
