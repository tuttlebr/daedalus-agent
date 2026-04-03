"""Shared utilities for image-related NAT functions.

Provides Redis storage/retrieval for uploaded and generated media,
reference parsing, and response extraction for OpenAI-compatible
chat completion endpoints.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

import redis as redis_lib

logger = logging.getLogger(__name__)


def parse_ref(ref: str | dict | None) -> dict | None:
    """Parse a media reference that may be a JSON string or dict."""
    if ref is None:
        return None
    if isinstance(ref, dict):
        return ref
    if isinstance(ref, str):
        try:
            return json.loads(ref)
        except json.JSONDecodeError:
            return None
    return None


async def fetch_image_from_redis(
    redis_client: redis_lib.Redis,
    image_ref: dict,
) -> tuple[str, str] | tuple[None, str]:
    """Fetch image data from Redis.

    Returns ``(base64_data, mime_type)`` on success or
    ``(None, error_message)`` on failure.
    """
    if not image_ref or not isinstance(image_ref, dict):
        return (
            None,
            f"Error: Invalid or missing image reference. "
            f"Received: {type(image_ref).__name__} = {repr(image_ref)}",
        )

    image_id = image_ref.get("imageId")
    session_id = image_ref.get("sessionId")
    user_id = image_ref.get("userId")

    if not image_id:
        return (None, "Error: No imageId in image reference.")

    logger.info(
        "Fetching image %s from session %s (user: %s) via Redis",
        image_id,
        session_id,
        user_id or "anonymous",
    )

    redis_keys = []
    if user_id:
        redis_keys.append(f"user:{user_id}:image:{image_id}")
    if session_id:
        redis_keys.append(f"image:{session_id}:{image_id}")

    image_data_json = None
    for redis_key in redis_keys:
        try:
            image_data_json = await asyncio.to_thread(
                redis_client.execute_command, "JSON.GET", redis_key
            )
            if image_data_json:
                break
        except redis_lib.RedisError:
            continue

    if not image_data_json:
        return (
            None,
            "Error: Image not found. The image may have expired or the session is invalid.",
        )

    try:
        image_record = json.loads(image_data_json)
        image_base64 = image_record.get("data")
        mime_type = (
            image_ref.get("mimeType") or image_record.get("mimeType") or "image/png"
        )
        if not image_base64:
            return (None, "Error: Retrieved image data is empty.")
        return (image_base64, mime_type)
    except (json.JSONDecodeError, KeyError) as e:
        return (None, f"Error: Failed to parse image data from storage: {e}")


async def fetch_video_from_redis(
    redis_client: redis_lib.Redis,
    video_ref: dict,
) -> tuple[str, str] | tuple[None, str]:
    """Fetch video data from Redis.

    Returns ``(base64_data, mime_type)`` on success or
    ``(None, error_message)`` on failure.
    """
    if not video_ref or not isinstance(video_ref, dict):
        return (
            None,
            f"Error: Invalid or missing video reference. "
            f"Received: {type(video_ref).__name__} = {repr(video_ref)}",
        )

    video_id = video_ref.get("videoId")
    session_id = video_ref.get("sessionId")
    user_id = video_ref.get("userId")

    if not video_id:
        return (None, "Error: No videoId in video reference.")

    logger.info(
        "Fetching video %s from session %s (user: %s) via Redis",
        video_id,
        session_id,
        user_id or "anonymous",
    )

    redis_keys = []
    if user_id:
        redis_keys.append(f"user:{user_id}:video:{video_id}")
    if session_id:
        redis_keys.append(f"video:{session_id}:{video_id}")

    video_data_json = None
    for redis_key in redis_keys:
        try:
            video_data_json = await asyncio.to_thread(
                redis_client.execute_command, "JSON.GET", redis_key
            )
            if video_data_json:
                break
        except redis_lib.RedisError:
            continue

    if not video_data_json:
        return (
            None,
            "Error: Video not found. The video may have expired or the session is invalid.",
        )

    try:
        video_record = json.loads(video_data_json)
        video_base64 = video_record.get("data")
        mime_type = (
            video_ref.get("mimeType") or video_record.get("mimeType") or "video/mp4"
        )
        if not video_base64:
            return (None, "Error: Retrieved video data is empty.")
        return (video_base64, mime_type)
    except (json.JSONDecodeError, KeyError) as e:
        return (None, f"Error: Failed to parse video data from storage: {e}")


async def store_image_in_redis(
    redis_client: redis_lib.Redis,
    b64_data: str,
    mime_type: str,
    prompt: str,
    source: str = "image_generation",
) -> str:
    """Store a generated or augmented image in Redis.

    Returns the ``image_id`` for retrieval via ``/api/generated-image/{id}``.
    """
    image_id = str(uuid.uuid4())
    redis_key = f"generated:image:{image_id}"

    image_record = {
        "data": b64_data,
        "mimeType": mime_type,
        "prompt": prompt,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": source,
    }

    try:
        await asyncio.to_thread(
            redis_client.execute_command,
            "JSON.SET",
            redis_key,
            "$",
            json.dumps(image_record),
        )
        await asyncio.to_thread(redis_client.expire, redis_key, 604800)
    except redis_lib.RedisError as e:
        logger.error("Failed to store image in Redis: %s", e)

    return image_id


def extract_images_from_response(response) -> list[tuple[str, str]]:
    """Extract base64 image data from a chat completion response.

    Handles the response format where images are returned in
    ``message.images[].image_url.url`` as base64 data URLs.

    Returns a list of ``(base64_data, mime_type)`` tuples.
    """
    if not response.choices:
        return []

    message = response.choices[0].message

    # images may live on the message directly or in model_extra (non-standard field)
    images = getattr(message, "images", None)
    if images is None and hasattr(message, "model_extra") and message.model_extra:
        images = message.model_extra.get("images")

    if not images:
        return []

    results = []
    for img in images:
        if isinstance(img, dict):
            url = img.get("image_url", {}).get("url", "")
        else:
            image_url_obj = getattr(img, "image_url", None)
            url = getattr(image_url_obj, "url", "") if image_url_obj else ""

        if url.startswith("data:"):
            # Parse data URL: data:image/png;base64,iVBOR...
            header, _, b64_data = url.partition(",")
            mime_type = "image/png"
            if ":" in header and ";" in header:
                mime_type = header.split(":")[1].split(";")[0]
            results.append((b64_data, mime_type))
        elif url:
            # Raw base64 without data URL wrapper
            results.append((url, "image/png"))

    return results
