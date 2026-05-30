"""Shared utilities for image-related NAT functions.

Provides Redis storage/retrieval for uploaded and generated media,
plus reference parsing.
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


def _resolve_user_scope(
    media_ref: dict,
    expected_user_id: str | None,
) -> tuple[str | None, str | None]:
    """Return the user id to use for lookup, or an error message."""
    ref_user_id = (media_ref.get("userId") or "").strip()
    expected = (expected_user_id or "").strip()

    if expected and ref_user_id and ref_user_id != expected:
        return (
            None,
            "Error: Media reference belongs to a different authenticated user.",
        )

    return (expected or ref_user_id or None, None)


async def fetch_image_from_redis(
    redis_client: redis_lib.Redis,
    image_ref: dict,
    expected_user_id: str | None = None,
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
    user_id, user_error = _resolve_user_scope(image_ref, expected_user_id)
    if user_error:
        return (None, user_error)

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
    if not user_id and session_id and session_id != "generated":
        redis_keys.append(f"image:{session_id}:{image_id}")
    # Generated/edited outputs from the /v1/images/* panel live at
    # generated:image:{id}, outside any user or session scope. Always try
    # this key last so generated images can be reused as edit inputs.
    redis_keys.append(f"generated:image:{image_id}")

    image_data_json = None
    matched_key = ""
    for redis_key in redis_keys:
        try:
            image_data_json = await asyncio.to_thread(
                redis_client.execute_command, "JSON.GET", redis_key
            )
            if image_data_json:
                matched_key = redis_key
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
        if matched_key.startswith("generated:image:"):
            owner_user_id = str(
                image_record.get("userId") or image_record.get("user") or ""
            ).strip()
            if expected_user_id and owner_user_id and owner_user_id != expected_user_id:
                return (
                    None,
                    "Error: Generated image belongs to a different authenticated user.",
                )

        vlm_base64 = image_record.get("vlmData")
        if vlm_base64:
            vlm_mime_type = image_record.get("vlmMimeType") or "image/jpeg"
            return (vlm_base64, vlm_mime_type)

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
    expected_user_id: str | None = None,
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
    user_id, user_error = _resolve_user_scope(video_ref, expected_user_id)
    if user_error:
        return (None, user_error)

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
    if not user_id and session_id:
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


def parse_stored_vtt(
    raw_json: str | bytes | None,
    expected_user_id: str | None = None,
) -> tuple[str, None] | tuple[None, str]:
    """Validate a stored VTT/SRT record and return its transcript text.

    The frontend stores transcripts as a RedisJSON document (see
    ``frontend/pages/api/session/vttStorage.ts``) with a ``data`` field holding
    the raw transcript and an optional ``userId`` owner. This is the pure,
    network-free half of :func:`fetch_vtt_from_redis` so the ownership and
    parsing rules are unit-testable.

    Returns ``(transcript_text, None)`` on success or ``(None, error_message)``.
    """
    if not raw_json:
        return (
            None,
            "Error: Transcript not found. It may have expired (transcripts are "
            "kept for 7 days); please re-upload it.",
        )

    try:
        record = json.loads(raw_json)
    except (json.JSONDecodeError, TypeError) as exc:
        return (None, f"Error: Failed to parse stored transcript: {exc}")

    # RedisJSON returns the bare object for ``JSON.GET key`` and a single-element
    # list for ``JSON.GET key $``. Accept either shape.
    if isinstance(record, list):
        record = record[0] if record else None
    if not isinstance(record, dict):
        return (None, "Error: Stored transcript is malformed.")

    # SECURITY: a transcript stored under an authenticated owner may only be
    # read back by that same user. The vtt_id/session_id reach this tool via an
    # LLM tool call and must not be trusted to grant cross-user access; the
    # stored ``userId`` is the authority. (Mirrors canAccessStoredVTT.)
    owner_user_id = str(record.get("userId") or "").strip()
    expected = (expected_user_id or "").strip()
    if owner_user_id and owner_user_id != expected:
        return (
            None,
            "Error: Transcript belongs to a different authenticated user.",
        )

    data = record.get("data")
    if not data or not str(data).strip():
        return (None, "Error: Stored transcript is empty; please re-upload it.")
    return (str(data), None)


async def fetch_vtt_from_redis(
    redis_client: redis_lib.Redis,
    session_id: str | None,
    vtt_id: str | None,
    expected_user_id: str | None = None,
) -> tuple[str, None] | tuple[None, str]:
    """Fetch an uploaded VTT/SRT transcript from Redis by id.

    Transcripts live at ``vtt:{session_id}:{vtt_id}`` (no user-scoped key —
    ownership is enforced from the stored ``userId`` via :func:`parse_stored_vtt`).

    Returns ``(transcript_text, None)`` on success or ``(None, error_message)``.
    """
    if not vtt_id or not session_id:
        return (
            None,
            "Error: both vtt_id and session_id are required to fetch an uploaded "
            "transcript.",
        )

    redis_key = f"vtt:{session_id}:{vtt_id}"
    logger.info(
        "Fetching transcript %s from session %s (user: %s) via Redis",
        vtt_id,
        session_id,
        expected_user_id or "anonymous",
    )

    try:
        raw_json = await asyncio.to_thread(
            redis_client.execute_command, "JSON.GET", redis_key
        )
    except redis_lib.RedisError as exc:
        logger.error("Redis error fetching transcript %s: %s", vtt_id, exc)
        return (None, "Error: transcript storage is temporarily unavailable.")

    return parse_stored_vtt(raw_json, expected_user_id)


async def store_image_in_redis(
    redis_client: redis_lib.Redis,
    b64_data: str,
    mime_type: str,
    prompt: str,
    source: str = "image_generation",
    user_id: str | None = None,
    session_id: str | None = None,
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
    if user_id:
        image_record["userId"] = user_id
    if session_id:
        image_record["sessionId"] = session_id

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
        raise

    return image_id
