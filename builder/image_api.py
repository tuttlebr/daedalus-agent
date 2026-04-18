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

import base64
import logging
import os
from typing import Any, Literal

import redis
from fastapi import APIRouter, HTTPException
from nat_helpers.image_utils import fetch_image_from_redis, store_image_in_redis
from nat_helpers.openai_images import edit_images, generate_images
from openai import AsyncOpenAI, OpenAIError
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/images", tags=["images"])


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
    quality: Literal["auto", "low", "medium", "high", "standard", "hd"] | None = None
    size: (
        Literal["auto", "1024x1024", "1024x1536", "1536x1024", "1792x1024", "1024x1792"]
        | None
    ) = None
    output_format: Literal["png", "jpeg", "webp"] | None = None
    output_compression: int | None = Field(None, ge=0, le=100)
    background: Literal["transparent", "opaque", "auto"] | None = None
    moderation: Literal["low", "auto"] | None = None
    style: Literal["vivid", "natural"] | None = None
    user: str | None = None
    sessionId: str | None = None


class EditRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    imageRefs: list[ImageRef] = Field(..., min_length=1)
    maskRef: ImageRef | None = None
    n: int | None = Field(None, ge=1, le=10)
    quality: Literal["auto", "low", "medium", "high", "standard", "hd"] | None = None
    size: Literal["auto", "1024x1024", "1024x1536", "1536x1024"] | None = None
    input_fidelity: Literal["low", "high"] | None = None
    output_format: Literal["png", "jpeg", "webp"] | None = None
    output_compression: int | None = Field(None, ge=0, le=100)
    background: Literal["transparent", "opaque", "auto"] | None = None
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
        url = os.getenv(
            "REDIS_URL", "redis://daedalus-redis.daedalus.svc.cluster.local:6379"
        )
        _redis_client = redis.from_url(url, decode_responses=False)
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
) -> list[str]:
    redis_client = _get_redis()
    ids: list[str] = []
    for r in results:
        image_id = await store_image_in_redis(
            redis_client, r.b64_json, r.mime_type, prompt, source=source
        )
        ids.append(image_id)
    return ids


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/generate", response_model=ImageResponse)
async def generate(req: GenerateRequest) -> ImageResponse:
    model, api_key, base_url = _config_for("GENERATION")
    client = _get_client(api_key, base_url)

    options = req.model_dump(exclude_none=True, exclude={"prompt", "sessionId"})

    try:
        results = await generate_images(
            client, model=model, prompt=req.prompt, **options
        )
    except OpenAIError as e:
        logger.exception("images.generate failed")
        raise HTTPException(status_code=502, detail=f"OpenAI error: {e}") from e

    if not results:
        raise HTTPException(status_code=502, detail="No image returned by the model")

    ids = await _store_results(results, req.prompt, source="image_panel_generate")
    return ImageResponse(imageIds=ids, model=model, prompt=req.prompt)


@router.post("/edit", response_model=ImageResponse)
async def edit(req: EditRequest) -> ImageResponse:
    model, api_key, base_url = _config_for("AUGMENTATION")
    client = _get_client(api_key, base_url)
    redis_client = _get_redis()

    # Fetch source images from Redis, decode to bytes for SDK multipart upload
    source_files: list[tuple[str, bytes, str]] = []
    for idx, ref in enumerate(req.imageRefs):
        result = await fetch_image_from_redis(redis_client, ref.model_dump())
        if result[0] is None:
            raise HTTPException(status_code=400, detail=f"image {idx + 1}: {result[1]}")
        image_b64, mime = result
        try:
            image_bytes = base64.b64decode(image_b64)
        except (ValueError, TypeError) as e:
            raise HTTPException(
                status_code=400, detail=f"image {idx + 1}: decode failed: {e}"
            ) from e
        ext = "jpg" if "jpeg" in mime else mime.split("/")[-1]
        source_files.append((f"image_{idx}.{ext}", image_bytes, mime))

    mask_file: tuple[str, bytes, str] | None = None
    if req.maskRef is not None:
        mask_result = await fetch_image_from_redis(
            redis_client, req.maskRef.model_dump()
        )
        if mask_result[0] is None:
            raise HTTPException(status_code=400, detail=f"mask: {mask_result[1]}")
        mask_b64, mask_mime = mask_result
        try:
            mask_bytes = base64.b64decode(mask_b64)
        except (ValueError, TypeError) as e:
            raise HTTPException(
                status_code=400, detail=f"mask: decode failed: {e}"
            ) from e
        mask_file = (
            f"mask.{'jpg' if 'jpeg' in mask_mime else mask_mime.split('/')[-1]}",
            mask_bytes,
            mask_mime,
        )

    options = req.model_dump(
        exclude_none=True,
        exclude={"prompt", "imageRefs", "maskRef", "sessionId"},
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
        raise HTTPException(status_code=502, detail=f"OpenAI error: {e}") from e

    if not results:
        raise HTTPException(status_code=502, detail="No image returned by the model")

    ids = await _store_results(results, req.prompt, source="image_panel_edit")
    return ImageResponse(imageIds=ids, model=model, prompt=req.prompt)
