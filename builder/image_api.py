"""FastAPI router for the /v1/images/generate and /v1/images/edit panel endpoints.

These are non-agent HTTP endpoints that power the dedicated image
panel in the frontend. They bypass the agent loop: a POST comes in
with structured params, we call OpenAI directly via the shared
`nat_helpers.openai_images` helpers, persist each returned image to
Redis, and return `{imageIds, model}` for the frontend to render via
`/api/generated-image/{id}`.

Env var contract (same as the agent tools):
  IMAGE_GENERATION_BASE_URL, IMAGE_GENERATION_API_KEY, IMAGE_GENERATION_MODEL
  IMAGE_AUGMENTATION_BASE_URL, IMAGE_AUGMENTATION_API_KEY, IMAGE_AUGMENTATION_MODEL
  OPENAI_API_KEY                        (fallback when the per-tool key is
                                         empty or an unexpanded placeholder)
  REDIS_URL                              (defaults to redis://daedalus-redis.daedalus.svc.cluster.local:6379)
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import logging
import os
from collections.abc import AsyncIterator
from typing import Annotated, Any, Literal

import redis
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from nat_helpers.image_utils import fetch_image_from_redis, store_image_in_redis
from nat_helpers.internal_auth import require_trusted_user as _require_trusted_user
from nat_helpers.openai_images import (
    ImageResult,
    ImageStreamEvent,
    edit_images,
    generate_images,
    stream_edit_images,
    stream_generate_images,
)
from nat_helpers.redis_url import redis_url_from_env
from openai import AsyncOpenAI, OpenAIError
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/images", tags=["images"])


# PNG parsing is intentionally small and dependency-free.  The frontend keeps
# uploaded originals in Redis, and masks must retain their original alpha and
# dimensions when passed to the OpenAI Image API.  The VLM derivative is a
# flattened JPEG, so Pillow/sharp-style reprocessing here would recreate the
# very failure this validation is meant to prevent.
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
_OPENAI_MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024
_OPENAI_MAX_MASK_BYTES = 4 * 1024 * 1024


def _png_metadata(image_bytes: bytes) -> tuple[int, int, bool] | None:
    """Return ``(width, height, has_alpha)`` for a valid-enough PNG header.

    This is a preflight check, not a general-purpose image decoder.  It
    validates the PNG chunk boundaries necessary to trust the IHDR dimensions
    and recognizes both explicit alpha color types and the PNG ``tRNS`` chunk.
    ``None`` means the asset cannot be used as the PNG half of an Image API
    mask edit.
    """
    if not image_bytes.startswith(_PNG_SIGNATURE):
        return None

    offset = len(_PNG_SIGNATURE)
    width = height = 0
    color_type: int | None = None
    saw_ihdr = False
    saw_iend = False
    has_alpha = False

    while offset + 12 <= len(image_bytes):
        chunk_length = int.from_bytes(image_bytes[offset : offset + 4], "big")
        chunk_type = image_bytes[offset + 4 : offset + 8]
        chunk_data_start = offset + 8
        chunk_data_end = chunk_data_start + chunk_length
        chunk_end = chunk_data_end + 4  # trailing CRC
        if chunk_end > len(image_bytes):
            return None

        if chunk_type == b"IHDR":
            # IHDR must be the first PNG chunk and is always 13 bytes.
            if saw_ihdr or offset != len(_PNG_SIGNATURE) or chunk_length != 13:
                return None
            width = int.from_bytes(
                image_bytes[chunk_data_start : chunk_data_start + 4], "big"
            )
            height = int.from_bytes(
                image_bytes[chunk_data_start + 4 : chunk_data_start + 8], "big"
            )
            color_type = image_bytes[chunk_data_start + 9]
            if width <= 0 or height <= 0 or color_type not in {0, 2, 3, 4, 6}:
                return None
            has_alpha = color_type in {4, 6}
            saw_ihdr = True
        elif chunk_type == b"tRNS" and saw_ihdr and color_type in {0, 2, 3}:
            # A tRNS chunk supplies alpha for grayscale, true-color, and
            # indexed PNGs. Its detailed value is immaterial for the API's
            # "contains an alpha channel" requirement.
            has_alpha = True
        elif chunk_type == b"IEND":
            if chunk_length != 0:
                return None
            saw_iend = True
            break

        offset = chunk_end

    if not saw_ihdr or not saw_iend:
        return None
    return (width, height, has_alpha)


def _mask_validation_error(source_bytes: bytes, mask_bytes: bytes) -> str | None:
    """Return an actionable Image API mask-preflight error, if any.

    OpenAI requires a mask and its primary source image to share format and
    dimensions, and the mask must carry alpha.  This panel supports that
    contract explicitly as a PNG-on-PNG workflow; rejecting unsupported files
    locally turns an opaque upstream 400/502 into a recoverable user error.
    """
    source = _png_metadata(source_bytes)
    if source is None:
        return (
            "mask: the primary input image must be a PNG when using a mask; "
            "use an uncompressed PNG source and mask of the same dimensions"
        )

    mask = _png_metadata(mask_bytes)
    if mask is None:
        return "mask: upload a PNG mask with an alpha channel"
    if not mask[2]:
        return "mask: the PNG mask must contain an alpha channel"
    if source[:2] != mask[:2]:
        return (
            "mask: the PNG mask must have the same dimensions as the primary "
            "input image"
        )
    return None


def _has_transparency(image: Image.Image) -> bool:
    return image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    )


def _normalize_edit_source(
    image_bytes: bytes,
) -> tuple[bytes, str, str]:
    """Return a decoded, single-frame Image API upload.

    Stored uploads may be decoder-sensitive JPEG variants such as MPO, animated
    containers, or legacy records whose MIME metadata does not match their
    bytes. Decode the first image, apply EXIF orientation, strip container
    metadata, and re-encode to one of the formats accepted by GPT Image edits.
    PNG sources stay PNG so source/mask format matching remains possible;
    transparency also selects PNG. Other sources become a baseline JPEG.
    """
    if not image_bytes:
        raise ValueError("image file is empty")

    try:
        with Image.open(io.BytesIO(image_bytes)) as opened:
            source_format = str(opened.format or "").upper()
            opened.seek(0)
            normalized = ImageOps.exif_transpose(opened)
            use_png = source_format == "PNG" or _has_transparency(normalized)
            output = io.BytesIO()

            if use_png:
                mode = "RGBA" if _has_transparency(normalized) else "RGB"
                normalized.convert(mode).save(output, format="PNG", optimize=False)
                mime_type = "image/png"
                extension = "png"
            else:
                normalized.convert("RGB").save(
                    output,
                    format="JPEG",
                    quality=95,
                    subsampling=0,
                    progressive=False,
                    optimize=False,
                )
                mime_type = "image/jpeg"
                extension = "jpg"
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ValueError(f"image file could not be decoded: {exc}") from exc

    normalized_bytes = output.getvalue()
    if len(normalized_bytes) >= _OPENAI_MAX_EDIT_IMAGE_BYTES:
        raise ValueError("normalized image must be less than 50MB")
    if mime_type == "image/png" and not normalized_bytes.startswith(_PNG_SIGNATURE):
        raise ValueError("normalization did not produce a valid PNG file")
    if mime_type == "image/jpeg" and not normalized_bytes.startswith(_JPEG_SIGNATURE):
        raise ValueError("normalization did not produce a valid JPEG file")
    return normalized_bytes, mime_type, extension


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class ImageRef(BaseModel):
    imageId: str
    sessionId: str | None = None
    userId: str | None = None
    mimeType: str | None = None


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    n: int | None = Field(None, ge=1, le=10)
    quality: Literal["auto", "low", "medium", "high"] | None = None
    size: str | None = None
    output_format: Literal["png", "jpeg", "webp"] | None = None
    output_compression: int | None = Field(None, ge=0, le=100)
    background: Literal["transparent", "opaque", "auto"] | None = None
    moderation: Literal["low", "auto"] | None = None
    stream: bool = False
    partial_images: int | None = Field(None, ge=0, le=3)
    user: str | None = None
    sessionId: str | None = None


class EditRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    imageRefs: list[ImageRef] = Field(..., min_length=1)
    maskRef: ImageRef | None = None
    n: int | None = Field(None, ge=1, le=10)
    quality: Literal["auto", "low", "medium", "high"] | None = None
    size: str | None = None
    input_fidelity: Literal["low", "high"] | None = None
    output_format: Literal["png", "jpeg", "webp"] | None = None
    output_compression: int | None = Field(None, ge=0, le=100)
    background: Literal["transparent", "opaque", "auto"] | None = None
    moderation: Literal["low", "auto"] | None = None
    stream: bool = False
    partial_images: int | None = Field(None, ge=0, le=3)
    user: str | None = None
    sessionId: str | None = None


class ImageResponse(BaseModel):
    imageIds: list[str]
    model: str
    prompt: str


# ---------------------------------------------------------------------------
# Client resolution (cached across requests per-process)
# ---------------------------------------------------------------------------


def _resolve_key(raw: str | None) -> str | None:
    """Drop unexpanded shell-style placeholders and fall back to OPENAI_API_KEY."""
    val = (raw or "").strip()
    if val.startswith("${") and val.endswith("}"):
        logger.warning(
            "api_key env var is an unexpanded placeholder (%s); "
            "falling back to OPENAI_API_KEY",
            val,
        )
        val = ""
    return val or os.getenv("OPENAI_API_KEY") or None


_client_cache: dict[str, AsyncOpenAI] = {}


def _get_client(api_key: str, base_url: str | None) -> AsyncOpenAI:
    cache_key = f"{base_url or ''}|{api_key}"
    client = _client_cache.get(cache_key)
    if client is None:
        kwargs: dict[str, Any] = {"api_key": api_key, "timeout": 300.0}
        if base_url:
            kwargs["base_url"] = base_url
        client = AsyncOpenAI(**kwargs)
        _client_cache[cache_key] = client
    return client


_redis_client: redis.Redis | None = None


def _get_redis() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(redis_url_from_env(), decode_responses=False)
    return _redis_client


def _config_for(prefix: str) -> tuple[str, str, str | None]:
    """Return (model, api_key, base_url) for 'GENERATION' or 'AUGMENTATION'."""
    model = os.getenv(f"IMAGE_{prefix}_MODEL")
    if not model:
        raise HTTPException(
            status_code=500,
            detail=f"IMAGE_{prefix}_MODEL env var not set on the backend",
        )
    api_key = _resolve_key(os.getenv(f"IMAGE_{prefix}_API_KEY"))
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail=(
                f"No usable API key for IMAGE_{prefix}_* (env var empty or "
                "placeholder, and OPENAI_API_KEY not set)"
            ),
        )
    base_url = os.getenv(f"IMAGE_{prefix}_BASE_URL") or None
    return model, api_key, base_url


async def _store_results(
    results: list,
    prompt: str,
    source: str,
    user_id: str,
    session_id: str | None,
) -> list[str]:
    redis_client = _get_redis()
    ids: list[str] = []
    for r in results:
        image_id = await store_image_in_redis(
            redis_client,
            r.b64_json,
            r.mime_type,
            prompt,
            source=source,
            user_id=user_id,
            session_id=session_id,
        )
        ids.append(image_id)
    return ids


async def _store_result(
    result: ImageResult,
    prompt: str,
    source: str,
    user_id: str,
    session_id: str | None,
) -> str:
    return (await _store_results([result], prompt, source, user_id, session_id))[0]


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


async def _stream_stored_images(
    events: AsyncIterator[ImageStreamEvent],
    *,
    prompt: str,
    source: str,
    user_id: str,
    session_id: str | None,
    model: str,
) -> AsyncIterator[str]:
    final_ids: list[str] = []
    try:
        async for event in events:
            image_id = await _store_result(
                event.image,
                prompt,
                source=f"{source}.partial" if event.partial else source,
                user_id=user_id,
                session_id=session_id,
            )
            if event.partial:
                yield _sse(
                    "partial",
                    {
                        "type": "partial",
                        "imageId": image_id,
                        "imageIds": [image_id],
                        "partialIndex": event.partial_index,
                    },
                )
            else:
                final_ids.append(image_id)
        if not final_ids:
            yield _sse(
                "error",
                {"type": "error", "error": "No image returned by the model"},
            )
            return
        yield _sse(
            "completed",
            ImageResponse(imageIds=final_ids, model=model, prompt=prompt).model_dump(),
        )
        yield "data: [DONE]\n\n"
    except OpenAIError:
        logger.exception("%s stream failed", source)
        yield _sse(
            "error",
            {"type": "error", "error": "Upstream image service error"},
        )
    except Exception:
        logger.exception("%s stream failed", source)
        yield _sse(
            "error",
            {"type": "error", "error": "Image generation stream failed"},
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/generate", response_model=ImageResponse)
async def generate(
    req: GenerateRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_session_id: Annotated[str | None, Header(alias="x-session-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> ImageResponse | StreamingResponse:
    user_id = _require_trusted_user(x_user_id, x_daedalus_internal_token)
    model, api_key, base_url = _config_for("GENERATION")
    client = _get_client(api_key, base_url)

    options = req.model_dump(
        exclude_none=True,
        exclude={"prompt", "sessionId", "user", "stream", "partial_images"},
    )
    if req.stream:
        return StreamingResponse(
            _stream_stored_images(
                stream_generate_images(
                    client,
                    model=model,
                    prompt=req.prompt,
                    partial_images=req.partial_images,
                    **options,
                ),
                prompt=req.prompt,
                source="image_panel_generate",
                user_id=user_id,
                session_id=(x_session_id or req.sessionId or None),
                model=model,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        results = await generate_images(
            client, model=model, prompt=req.prompt, **options
        )
    except OpenAIError as e:
        logger.exception("images.generate failed")
        # F-022: log the full upstream error server-side; return a generic
        # message so provider/model/endpoint details are not leaked to callers.
        raise HTTPException(
            status_code=502, detail="Upstream image service error"
        ) from e

    if not results:
        raise HTTPException(status_code=502, detail="No image returned by the model")

    ids = await _store_results(
        results,
        req.prompt,
        source="image_panel_generate",
        user_id=user_id,
        session_id=(x_session_id or req.sessionId or None),
    )
    return ImageResponse(imageIds=ids, model=model, prompt=req.prompt)


@router.post("/edit", response_model=ImageResponse)
async def edit(
    req: EditRequest,
    x_user_id: Annotated[str | None, Header(alias="x-user-id")] = None,
    x_session_id: Annotated[str | None, Header(alias="x-session-id")] = None,
    x_daedalus_internal_token: Annotated[
        str | None, Header(alias="x-daedalus-internal-token")
    ] = None,
) -> ImageResponse | StreamingResponse:
    user_id = _require_trusted_user(x_user_id, x_daedalus_internal_token)
    model, api_key, base_url = _config_for("AUGMENTATION")
    client = _get_client(api_key, base_url)
    redis_client = _get_redis()

    # Prefer the upload-time edit derivative, then decode/re-encode again at
    # this trust boundary. The second pass repairs legacy records and prevents
    # MIME-labelled MPO/animated/decoder-sensitive containers from reaching
    # OpenAI as opaque multipart bytes.
    source_files: list[tuple[str, bytes, str]] = []
    for idx, ref in enumerate(req.imageRefs):
        result = await fetch_image_from_redis(
            redis_client,
            ref.model_dump(),
            expected_user_id=user_id,
            prefer_vlm_data=False,
            prefer_edit_data=True,
        )
        if result[0] is None:
            raise HTTPException(status_code=400, detail=f"image {idx + 1}: {result[1]}")
        image_b64, _mime = result
        try:
            image_bytes = base64.b64decode(image_b64, validate=True)
        except (ValueError, TypeError, binascii.Error) as e:
            raise HTTPException(
                status_code=400, detail=f"image {idx + 1}: decode failed: {e}"
            ) from e
        try:
            normalized_bytes, normalized_mime, ext = await asyncio.to_thread(
                _normalize_edit_source, image_bytes
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"image {idx + 1}: {exc}",
            ) from exc
        source_files.append((f"image_{idx}.{ext}", normalized_bytes, normalized_mime))

    mask_file: tuple[str, bytes, str] | None = None
    if req.maskRef is not None:
        mask_result = await fetch_image_from_redis(
            redis_client,
            req.maskRef.model_dump(),
            expected_user_id=user_id,
            prefer_vlm_data=False,
        )
        if mask_result[0] is None:
            raise HTTPException(status_code=400, detail=f"mask: {mask_result[1]}")
        mask_b64, _mask_mime = mask_result
        try:
            mask_bytes = base64.b64decode(mask_b64, validate=True)
        except (ValueError, TypeError, binascii.Error) as e:
            raise HTTPException(
                status_code=400, detail=f"mask: decode failed: {e}"
            ) from e
        if len(mask_bytes) >= _OPENAI_MAX_MASK_BYTES:
            raise HTTPException(
                status_code=400,
                detail="mask: PNG mask must be less than 4MB",
            )
        mask_error = _mask_validation_error(source_files[0][1], mask_bytes)
        if mask_error:
            raise HTTPException(status_code=400, detail=mask_error)
        # Validation establishes the actual wire format independently of an
        # untrusted ImageRef MIME hint, so label the multipart part correctly.
        mask_file = ("mask.png", mask_bytes, "image/png")

    options = req.model_dump(
        exclude_none=True,
        exclude={
            "prompt",
            "imageRefs",
            "maskRef",
            "sessionId",
            "user",
            "stream",
            "partial_images",
        },
    )
    if req.stream:
        return StreamingResponse(
            _stream_stored_images(
                stream_edit_images(
                    client,
                    model=model,
                    image=source_files[0] if len(source_files) == 1 else source_files,
                    prompt=req.prompt,
                    mask=mask_file,
                    partial_images=req.partial_images,
                    **options,
                ),
                prompt=req.prompt,
                source="image_panel_edit",
                user_id=user_id,
                session_id=(x_session_id or req.sessionId or None),
                model=model,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        results = await edit_images(
            client,
            model=model,
            image=source_files[0] if len(source_files) == 1 else source_files,
            prompt=req.prompt,
            mask=mask_file,
            **options,
        )
    except OpenAIError as e:
        logger.exception("images.edit failed")
        # F-022: log the full upstream error server-side; return a generic
        # message so provider/model/endpoint details are not leaked to callers.
        raise HTTPException(
            status_code=502, detail="Upstream image service error"
        ) from e

    if not results:
        raise HTTPException(status_code=502, detail="No image returned by the model")

    ids = await _store_results(
        results,
        req.prompt,
        source="image_panel_edit",
        user_id=user_id,
        session_id=(x_session_id or req.sessionId or None),
    )
    return ImageResponse(imageIds=ids, model=model, prompt=req.prompt)
