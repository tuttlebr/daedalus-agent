import logging
import os

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
)
from pydantic import Field

logger = logging.getLogger(__name__)


class ImageComprehensionFunctionConfig(
    FunctionBaseConfig,
    name="image_comprehension",
):
    """Configuration for image/video comprehension via OpenAI-compatible chat completions."""

    api_endpoint: str = Field(
        "http://localhost:8000",
        description="Base URL for the OpenAI-compatible VLM API endpoint",
    )
    redis_url: str = Field(
        "redis://redis:6379",
        description="Redis connection URL for retrieving uploaded images and videos",
    )
    timeout: float = Field(120.0, description="HTTP timeout in seconds")
    api_key: str | None = Field(
        default=None,
        description="Optional API key. Falls back to NVIDIA_API_KEY env var.",
    )
    model: str = Field(
        "nvidia/NVIDIA-Nemotron-Nano-12B-v2",
        description="VLM model to use for image and video comprehension",
    )
    max_tokens: int = Field(
        1024,
        description="Maximum number of tokens in the response",
    )


@register_function(config_type=ImageComprehensionFunctionConfig)
async def image_comprehension_function(
    config: ImageComprehensionFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    api_key = config.api_key or os.getenv("NVIDIA_API_KEY") or "not-used"
    api_url = config.api_endpoint.rstrip("/") + "/chat/completions"

    http_client = httpx.AsyncClient(
        timeout=config.timeout,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )

    redis_client = redis.from_url(config.redis_url, decode_responses=False)

    async def comprehend_media(
        question: str,
        imageRef: str | dict | None = None,
        image_url: str | None = None,
        videoRef: str | dict | None = None,
        video_url: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        Ask a question about an image or video using a Vision Language Model.

        Args:
            question: Question to ask about the image or video
            imageRef: Image reference object with imageId and sessionId (for uploaded images)
            image_url: Direct URL to an image (alternative to imageRef)
            videoRef: Video reference object with videoId and sessionId (for uploaded videos)
            video_url: Direct URL to a video (alternative to videoRef)
            max_tokens: Maximum number of tokens in the response

        Returns:
            The model's response to the question about the image or video
        """
        try:
            if not question or not question.strip():
                return "Error: No question provided."

            parsed_imageRef = parse_ref(imageRef)
            parsed_videoRef = parse_ref(videoRef)

            if not (parsed_imageRef or image_url or parsed_videoRef or video_url):
                return (
                    "Error: No media provided. Please provide an image "
                    "(imageRef or image_url) or video (videoRef or video_url)."
                )

            media_content = None

            if video_url:
                media_content = {"type": "video_url", "video_url": {"url": video_url}}
            elif parsed_videoRef:
                result = await fetch_video_from_redis(redis_client, parsed_videoRef)
                if result[0] is None:
                    return result[1]
                video_base64, mime_type = result
                media_content = {
                    "type": "video_url",
                    "video_url": {"url": f"data:{mime_type};base64,{video_base64}"},
                }
            elif image_url:
                media_content = {"type": "image_url", "image_url": {"url": image_url}}
            elif parsed_imageRef:
                result = await fetch_image_from_redis(redis_client, parsed_imageRef)
                if result[0] is None:
                    return result[1]
                image_base64, mime_type = result
                media_content = {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{image_base64}"},
                }

            effective_max_tokens = (
                max_tokens if max_tokens is not None else config.max_tokens
            )

            is_video = (
                media_content is not None and media_content.get("type") == "video_url"
            )

            payload = {
                "model": config.model,
                "messages": [
                    {
                        "role": "system",
                        "content": "/no_think" if is_video else "/think",
                    },
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": question}, media_content],
                    },
                ],
                "max_tokens": effective_max_tokens,
            }

            response = await http_client.post(api_url, json=payload)
            response.raise_for_status()
            data = response.json()

            choices = data.get("choices", [])
            if choices:
                content = choices[0].get("message", {}).get("content", "")
                if content:
                    return content

            return "Error: Unexpected response format from the Vision Language Model."

        except httpx.HTTPStatusError as exc:
            logger.error(
                "VLM API returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return f"Error: VLM API returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            logger.error("VLM API request failed: %s", exc)
            return f"Error: Could not reach VLM API: {exc}"
        except Exception as e:
            logger.error("Error during media comprehension: %s", str(e), exc_info=True)
            return f"Error: {str(e)}"

    try:
        logger.info("Registering function comprehend_media")

        description = (
            "Read-only analysis of an image or video. Returns a TEXT response, never a modified image. "
            "Use when a user uploads media and asks questions about what's in it, wants to identify "
            "objects, describe scenes, read text, or understand visual content. Do NOT use when the "
            "user wants the image modified, augmented, or enhanced. "
            "For images: provide imageRef (object with imageId and sessionId) or image_url (direct URL). "
            "For videos: provide videoRef (object with videoId and sessionId) or video_url (direct URL)."
        )

        function_info = FunctionInfo.from_fn(comprehend_media, description=description)
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up image_comprehension workflow.")
        await http_client.aclose()
