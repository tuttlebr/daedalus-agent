import base64
import json
import logging
import os
from typing import Any

import httpx
import redis
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.image_utils import (
    fetch_image_from_redis,
    fetch_video_from_redis,
    parse_ref,
    store_image_in_redis,
)
from nat_helpers.openai_images import edit_images, generate_images
from openai import AsyncOpenAI
from pydantic import Field

logger = logging.getLogger(__name__)


class VisualMediaFunctionConfig(FunctionBaseConfig, name="visual_media"):
    """Unified image generation, image editing, and media analysis tool."""

    redis_url: str = Field(
        "redis://redis:6379",
        description="Redis connection URL for uploaded and generated media.",
    )
    image_api_key: str | None = Field(
        None,
        description="Fallback image API key. Falls back to OPENAI_API_KEY.",
    )
    image_api_endpoint: str | None = Field(
        None,
        description="Fallback OpenAI-compatible image API base URL.",
    )
    generation_api_key: str | None = Field(
        None,
        description="Generation API key. Falls back to image_api_key or OPENAI_API_KEY.",
    )
    generation_api_endpoint: str | None = Field(
        None,
        description="OpenAI-compatible generation API base URL.",
    )
    edit_api_key: str | None = Field(
        None,
        description="Image editing API key. Falls back to image_api_key or OPENAI_API_KEY.",
    )
    edit_api_endpoint: str | None = Field(
        None,
        description="OpenAI-compatible image editing API base URL.",
    )
    image_timeout: float = Field(120.0, description="Image API timeout in seconds.")
    generation_model: str = Field(
        "gpt-image-2", description="Model used for text-to-image generation."
    )
    edit_model: str = Field(
        "gpt-image-1.5", description="Model used for image editing."
    )
    quality: str | None = Field(default=None, description="Optional image quality.")
    input_fidelity: str | None = Field(
        default=None, description="Optional image-edit fidelity setting."
    )
    size: str | None = Field(default=None, description="Optional output image size.")
    n: int | None = Field(default=None, description="Optional number of images.")
    moderation: str | None = Field(
        default=None, description="Optional generation moderation setting."
    )
    output_format: str | None = Field(
        default=None, description="Optional generation output format."
    )
    output_compression: int | None = Field(
        default=None, description="Optional generation output compression."
    )
    background: str | None = Field(
        default=None, description="Optional generation background setting."
    )
    user: str | None = Field(
        default=None, description="Optional end-user identifier for image API calls."
    )
    comprehension_api_endpoint: str = Field(
        "http://localhost:8000",
        description="OpenAI-compatible VLM API base URL.",
    )
    comprehension_api_key: str | None = Field(
        None,
        description="VLM API key. Falls back to NVIDIA_API_KEY or not-used.",
    )
    comprehension_model: str = Field(
        "nvidia/NVIDIA-Nemotron-Nano-12B-v2",
        description="VLM model used for image/video comprehension.",
    )
    comprehension_timeout: float = Field(
        120.0, description="VLM API timeout in seconds."
    )
    max_tokens: int = Field(1024, description="Default VLM response token limit.")


def _configured_key(value: str | None, env_name: str) -> str:
    configured = (value or "").strip()
    if configured.startswith("${") and configured.endswith("}"):
        configured = ""
    return configured or os.getenv(env_name, "")


def _chat_completions_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def _ref_requires_user_id(media_ref: str | dict | list[dict] | None) -> bool:
    parsed = parse_ref(media_ref) if isinstance(media_ref, str) else media_ref
    if isinstance(parsed, list):
        return any(_ref_requires_user_id(item) for item in parsed)
    return isinstance(parsed, dict) and bool((parsed.get("userId") or "").strip())


def _validated_user_id(
    media_ref: str | dict | list[dict] | None,
    user_id: str | None,
) -> tuple[str | None, str | None]:
    expected = (user_id or "").strip()
    if _ref_requires_user_id(media_ref) and not expected:
        return (
            None,
            "Error: user_id is required for uploaded user-scoped media. "
            "Pass user_id from the authenticated [IDENTITY] message.",
        )
    return (expected or None, None)


@register_function(config_type=VisualMediaFunctionConfig)
async def visual_media_function(config: VisualMediaFunctionConfig, builder: Builder):  # noqa: ARG001
    redis_client = redis.from_url(config.redis_url, decode_responses=False)
    image_clients: dict[str, AsyncOpenAI] = {}
    vlm_client: httpx.AsyncClient | None = None

    def _get_image_client(operation: str) -> AsyncOpenAI:
        if operation not in image_clients:
            if operation == "generate":
                endpoint = config.generation_api_endpoint or config.image_api_endpoint
                key_value = config.generation_api_key or config.image_api_key
            else:
                endpoint = config.edit_api_endpoint or config.image_api_endpoint
                key_value = config.edit_api_key or config.image_api_key

            api_key = _configured_key(key_value, "OPENAI_API_KEY")
            if not api_key:
                raise ValueError(
                    f"Image API key is required for {operation} operation."
                )
            kwargs: dict[str, Any] = {
                "api_key": api_key,
                "timeout": config.image_timeout,
            }
            if endpoint:
                kwargs["base_url"] = endpoint
            image_clients[operation] = AsyncOpenAI(**kwargs)
        return image_clients[operation]

    def _get_vlm_client() -> httpx.AsyncClient:
        nonlocal vlm_client
        if vlm_client is None:
            api_key = (
                _configured_key(config.comprehension_api_key, "NVIDIA_API_KEY")
                or "not-used"
            )
            vlm_client = httpx.AsyncClient(
                timeout=config.comprehension_timeout,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
        return vlm_client

    async def _generate(prompt: str) -> str:
        if not prompt or not prompt.strip():
            return "Error: prompt is required for operation='generate'."

        results = await generate_images(
            _get_image_client("generate"),
            model=config.generation_model,
            prompt=prompt,
            quality=config.quality,
            size=config.size,
            n=config.n,
            moderation=config.moderation,
            output_format=config.output_format,
            output_compression=config.output_compression,
            background=config.background,
            user=config.user,
        )
        refs = []
        for result in results:
            image_id = await store_image_in_redis(
                redis_client,
                result.b64_json,
                result.mime_type,
                prompt,
                source="visual_media.generate",
            )
            refs.append(f"![Generated image](/api/generated-image/{image_id})")
        return "\n".join(refs) if refs else "Error: No image was returned."

    async def _edit(
        prompt: str,
        imageRef: str | dict | list[dict] | None,
        user_id: str | None,
    ) -> str:
        if not prompt or not prompt.strip():
            return "Error: prompt is required for operation='edit'."
        if isinstance(imageRef, str):
            try:
                imageRef = json.loads(imageRef)
            except json.JSONDecodeError:
                return f"Error: Could not parse imageRef: {imageRef}"
        if isinstance(imageRef, dict):
            image_refs = [imageRef]
        elif isinstance(imageRef, list):
            image_refs = imageRef
        else:
            return "Error: imageRef is required for operation='edit'."
        if not image_refs:
            return "Error: imageRef is required for operation='edit'."

        expected_user_id, user_error = _validated_user_id(image_refs, user_id)
        if user_error:
            return user_error

        source_files: list[tuple[str, bytes, str]] = []
        for idx, ref in enumerate(image_refs):
            image_base64, mime_type_or_error = await fetch_image_from_redis(
                redis_client, ref, expected_user_id=expected_user_id
            )
            if image_base64 is None:
                return f"Error fetching image {idx + 1}: {mime_type_or_error}"
            try:
                image_bytes = base64.b64decode(image_base64)
            except (ValueError, TypeError) as exc:
                return f"Error decoding image {idx + 1}: {exc}"
            mime_type = mime_type_or_error
            extension = "jpg" if "jpeg" in mime_type else mime_type.split("/")[-1]
            source_files.append((f"image_{idx}.{extension}", image_bytes, mime_type))

        results = await edit_images(
            _get_image_client("edit"),
            model=config.edit_model,
            image=source_files[0] if len(source_files) == 1 else source_files,
            prompt=prompt,
            quality=config.quality,
            input_fidelity=config.input_fidelity,
            size=config.size,
            n=config.n,
        )
        refs = []
        for result in results:
            image_id = await store_image_in_redis(
                redis_client,
                result.b64_json,
                result.mime_type,
                prompt,
                source="visual_media.edit",
            )
            refs.append(f"![Edited image](/api/generated-image/{image_id})")
        return "\n".join(refs) if refs else "Error: No image was returned."

    async def _analyze(
        question: str,
        imageRef: str | dict | None,
        image_url: str | None,
        videoRef: str | dict | None,
        video_url: str | None,
        max_tokens: int | None,
        user_id: str | None,
    ) -> str:
        if not question or not question.strip():
            return "Error: question is required for operation='analyze'."

        parsed_image_ref = parse_ref(imageRef)
        parsed_video_ref = parse_ref(videoRef)
        if not (parsed_image_ref or image_url or parsed_video_ref or video_url):
            return (
                "Error: media is required for operation='analyze'. Provide imageRef, "
                "image_url, videoRef, or video_url."
            )

        expected_user_id, user_error = _validated_user_id(
            parsed_video_ref or parsed_image_ref, user_id
        )
        if user_error:
            return user_error

        media_content: dict[str, Any] | None = None
        if video_url:
            media_content = {"type": "video_url", "video_url": {"url": video_url}}
        elif parsed_video_ref:
            video_base64, mime_type_or_error = await fetch_video_from_redis(
                redis_client, parsed_video_ref, expected_user_id=expected_user_id
            )
            if video_base64 is None:
                return mime_type_or_error
            media_content = {
                "type": "video_url",
                "video_url": {
                    "url": f"data:{mime_type_or_error};base64,{video_base64}"
                },
            }
        elif image_url:
            media_content = {"type": "image_url", "image_url": {"url": image_url}}
        elif parsed_image_ref:
            image_base64, mime_type_or_error = await fetch_image_from_redis(
                redis_client, parsed_image_ref, expected_user_id=expected_user_id
            )
            if image_base64 is None:
                return mime_type_or_error
            media_content = {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{mime_type_or_error};base64,{image_base64}"
                },
            }

        is_video = (
            media_content is not None and media_content.get("type") == "video_url"
        )
        payload = {
            "model": config.comprehension_model,
            "messages": [
                {"role": "system", "content": "/no_think" if is_video else "/think"},
                {
                    "role": "user",
                    "content": [{"type": "text", "text": question}, media_content],
                },
            ],
            "max_tokens": max_tokens if max_tokens is not None else config.max_tokens,
        }

        response = await _get_vlm_client().post(
            _chat_completions_url(config.comprehension_api_endpoint),
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        choices = data.get("choices", [])
        if choices:
            content = choices[0].get("message", {}).get("content", "")
            if content:
                return content
        return "Error: Unexpected response format from the Vision Language Model."

    async def visual_media(
        operation: str,
        prompt: str = "",
        imageRef: str | dict | list[dict] | None = None,
        image_url: str | None = None,
        videoRef: str | dict | None = None,
        video_url: str | None = None,
        question: str = "",
        max_tokens: int | None = None,
        user_id: str = "",
    ) -> str:
        """Generate, edit, or analyze visual media.

        Args:
            operation: generate, edit, or analyze.
            prompt: Text prompt for generate/edit. Used as question fallback
                for analyze.
            imageRef: Uploaded image reference for edit/analyze.
            image_url: Public image URL for analyze.
            videoRef: Uploaded video reference for analyze.
            video_url: Public video URL for analyze.
            question: Analysis question. Falls back to prompt.
            max_tokens: Optional analysis response token limit.
            user_id: Authenticated username from the [IDENTITY] message. Required
                when imageRef/videoRef contains a userId.
        """
        op = (operation or "").strip().lower()
        try:
            if op == "generate":
                return await _generate(prompt)
            if op == "edit":
                return await _edit(prompt, imageRef, user_id)
            if op == "analyze":
                if isinstance(imageRef, list):
                    return (
                        "Error: analyzing multiple images in one tool call is not "
                        "supported. Call operation='analyze' once per imageRef."
                    )
                return await _analyze(
                    question or prompt,
                    imageRef,
                    image_url,
                    videoRef,
                    video_url,
                    max_tokens,
                    user_id,
                )
            return "Error: operation must be one of generate, edit, analyze."
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Media API returned %d for operation=%s url=%s body=%s",
                exc.response.status_code,
                op or "unknown",
                exc.request.url,
                exc.response.text[:500],
            )
            return f"Error: media API returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            logger.error("Media API request failed: %s", exc)
            return f"Error: could not reach media API: {exc}"
        except Exception as exc:
            logger.error("visual_media operation failed: %s", exc, exc_info=True)
            return f"Error: {exc}"

    try:
        yield FunctionInfo.from_fn(
            visual_media,
            description=(
                "Unified visual media tool. Args: operation='generate' to create "
                "a new image from prompt; operation='edit' to modify uploaded "
                "imageRef with prompt; operation='analyze' to answer a question "
                "about imageRef, image_url, videoRef, or video_url. Pass user_id "
                "from [IDENTITY] when uploaded refs include userId. Image outputs "
                "return markdown refs that must be forwarded verbatim."
            ),
        )
    except GeneratorExit:
        logger.warning("visual_media function exited early!")
    finally:
        if vlm_client is not None:
            await vlm_client.aclose()
