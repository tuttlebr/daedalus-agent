import asyncio
import json
import logging
import os

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

import redis

logger = logging.getLogger(__name__)


class ImageComprehensionFunctionConfig(
    FunctionBaseConfig,
    name="image_comprehension",
):
    """
    Configuration for image/video comprehension function.
    Uses Vision Language Models (VLM) to answer questions about images and videos.
    """

    api_endpoint: str = Field(
        "http://localhost:8000",
        description="Base URL for the VLM API endpoint",
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


class ImageComprehensionInput(BaseModel):
    """Input model for the image/video comprehension function."""

    question: str = Field(..., description="Question to ask about the image or video")
    imageRef: dict | None = Field(
        None,
        description="Image reference with imageId and sessionId for uploaded images",
    )
    image_url: str | None = Field(
        None,
        description="Direct URL to an image (alternative to imageRef)",
    )
    videoRef: dict | None = Field(
        None,
        description="Video reference with videoId and sessionId for uploaded videos",
    )
    video_url: str | None = Field(
        None,
        description="Direct URL to a video (alternative to videoRef). Supported formats: MP4, FLV, 3GP",
    )
    max_tokens: int | None = Field(
        None, description="Maximum number of tokens in the response"
    )

    @classmethod
    def _parse_json_string(cls, v):
        """Helper to parse JSON strings into dictionaries."""
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return v
        return v

    def __init__(self, **data):
        # Pre-process imageRef and videoRef to handle JSON strings
        if "imageRef" in data:
            data["imageRef"] = self._parse_json_string(data["imageRef"])
        if "videoRef" in data:
            data["videoRef"] = self._parse_json_string(data["videoRef"])
        super().__init__(**data)


@register_function(config_type=ImageComprehensionFunctionConfig)
async def image_comprehension_function(
    config: ImageComprehensionFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    # Get API key
    api_key = config.api_key or os.getenv("NVIDIA_API_KEY") or "not-used"

    # Initialize OpenAI client pointing to the VLM endpoint
    openai_client = AsyncOpenAI(
        base_url=config.api_endpoint,
        api_key=api_key,
        timeout=config.timeout,
    )

    # Initialize Redis client
    redis_client = redis.from_url(
        config.redis_url,
        decode_responses=False,  # We need binary data for images/videos
    )

    async def fetch_image_from_redis(
        imageRef: dict,
    ) -> tuple[str, str] | tuple[None, str]:
        """
        Fetch image data from Redis.

        Args:
            imageRef: Image reference with imageId, sessionId, and optionally userId

        Returns:
            Tuple of (base64_data, mime_type) or (None, error_message)
        """
        if not imageRef or not isinstance(imageRef, dict):
            logger.error(
                "Invalid imageRef received. Type: %s, Value: %s",
                type(imageRef),
                imageRef,
            )
            return (
                None,
                "Error: Invalid or missing image reference. "
                f"Expected a dictionary with imageId, sessionId. "
                f"Received: {type(imageRef).__name__} = {repr(imageRef)}",
            )

        image_id = imageRef.get("imageId")
        session_id = imageRef.get("sessionId")
        user_id = imageRef.get("userId")

        if not image_id:
            return (None, "Error: No imageId in image reference.")

        logger.info(
            "Fetching image %s from session %s (user: %s) via Redis",
            image_id,
            session_id,
            user_id or "anonymous",
        )

        # Construct Redis key based on whether user is authenticated
        redis_keys = []
        if user_id:
            redis_keys.append(f"user:{user_id}:image:{image_id}")
        if session_id:
            redis_keys.append(f"image:{session_id}:{image_id}")

        # Try to fetch image data from Redis
        image_data_json = None
        for redis_key in redis_keys:
            try:
                logger.info("Trying Redis key: %s", redis_key)
                image_data_json = await asyncio.to_thread(
                    redis_client.execute_command, "JSON.GET", redis_key
                )
                if image_data_json:
                    logger.info("Successfully found image with key: %s", redis_key)
                    break
            except redis.RedisError as e:
                logger.debug("Failed to fetch with key %s: %s", redis_key, str(e))
                continue

        if not image_data_json:
            logger.error(
                "Image %s not found in Redis. Tried keys: %s",
                image_id,
                ", ".join(redis_keys),
            )
            return (
                None,
                "Error: Image not found. The image may have expired or the session is invalid.",
            )

        try:
            image_record = json.loads(image_data_json)
            image_base64 = image_record.get("data")
            mime_type = (
                imageRef.get("mimeType") or image_record.get("mimeType") or "image/png"
            )

            if not image_base64:
                logger.error("Image data is empty for image %s", image_id)
                return (None, "Error: Retrieved image data is empty.")

            logger.info(
                "Successfully retrieved image from Redis (size: %d bytes)",
                len(image_base64),
            )
            return (image_base64, mime_type)

        except (json.JSONDecodeError, KeyError) as e:
            logger.error("Error parsing image data from Redis: %s", e)
            return (None, "Error: Failed to parse image data from storage.")

    async def fetch_video_from_redis(
        videoRef: dict,
    ) -> tuple[str, str] | tuple[None, str]:
        """
        Fetch video data from Redis.

        Args:
            videoRef: Video reference with videoId, sessionId, and optionally userId

        Returns:
            Tuple of (base64_data, mime_type) or (None, error_message)
        """
        if not videoRef or not isinstance(videoRef, dict):
            logger.error(
                "Invalid videoRef received. Type: %s, Value: %s",
                type(videoRef),
                videoRef,
            )
            return (
                None,
                "Error: Invalid or missing video reference. "
                f"Expected a dictionary with videoId, sessionId. "
                f"Received: {type(videoRef).__name__} = {repr(videoRef)}",
            )

        video_id = videoRef.get("videoId")
        session_id = videoRef.get("sessionId")
        user_id = videoRef.get("userId")

        if not video_id:
            return (None, "Error: No videoId in video reference.")

        logger.info(
            "Fetching video %s from session %s (user: %s) via Redis",
            video_id,
            session_id,
            user_id or "anonymous",
        )

        # Construct Redis key based on whether user is authenticated
        redis_keys = []
        if user_id:
            redis_keys.append(f"user:{user_id}:video:{video_id}")
        if session_id:
            redis_keys.append(f"video:{session_id}:{video_id}")

        # Try to fetch video data from Redis
        video_data_json = None
        for redis_key in redis_keys:
            try:
                logger.info("Trying Redis key: %s", redis_key)
                video_data_json = await asyncio.to_thread(
                    redis_client.execute_command, "JSON.GET", redis_key
                )
                if video_data_json:
                    logger.info("Successfully found video with key: %s", redis_key)
                    break
            except redis.RedisError as e:
                logger.debug("Failed to fetch with key %s: %s", redis_key, str(e))
                continue

        if not video_data_json:
            logger.error(
                "Video %s not found in Redis. Tried keys: %s",
                video_id,
                ", ".join(redis_keys),
            )
            return (
                None,
                "Error: Video not found. The video may have expired or the session is invalid.",
            )

        try:
            video_record = json.loads(video_data_json)
            video_base64 = video_record.get("data")
            mime_type = (
                videoRef.get("mimeType") or video_record.get("mimeType") or "video/mp4"
            )

            if not video_base64:
                logger.error("Video data is empty for video %s", video_id)
                return (None, "Error: Retrieved video data is empty.")

            logger.info(
                "Successfully retrieved video from Redis (size: %d bytes)",
                len(video_base64),
            )
            return (video_base64, mime_type)

        except (json.JSONDecodeError, KeyError) as e:
            logger.error("Error parsing video data from Redis: %s", e)
            return (None, "Error: Failed to parse video data from storage.")

    def _parse_ref(ref: str | dict | None) -> dict | None:
        """Parse a reference that may be a JSON string or dict."""
        if ref is None:
            return None
        if isinstance(ref, dict):
            return ref
        if isinstance(ref, str):
            try:
                return json.loads(ref)
            except json.JSONDecodeError:
                logger.error("Failed to parse reference as JSON: %s", ref[:100])
                return None
        return None

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

        Supported video codecs: H264, H265, VP8, VP9, FLV
        Supported video formats: MP4, FLV, 3GP
        """
        try:
            if not question or not question.strip():
                return "Error: No question provided."

            # Parse refs that may come as JSON strings from LLM tool calls
            parsed_imageRef = _parse_ref(imageRef)
            parsed_videoRef = _parse_ref(videoRef)

            has_image = parsed_imageRef or image_url
            has_video = parsed_videoRef or video_url

            if not has_image and not has_video:
                return "Error: No media provided. Please provide an image (imageRef or image_url) or video (videoRef or video_url)."

            # Determine the media source - video takes precedence if both provided
            media_content = None

            if video_url:
                # Use direct video URL
                logger.info("Using direct video URL: %s", video_url[:100])
                media_content = {"type": "video_url", "video_url": {"url": video_url}}
            elif parsed_videoRef:
                # Fetch video from Redis
                result = await fetch_video_from_redis(parsed_videoRef)
                if result[0] is None:
                    return result[1]  # Return error message

                video_base64, mime_type = result
                # Construct data URL for base64 video
                video_data_url = f"data:{mime_type};base64,{video_base64}"
                media_content = {
                    "type": "video_url",
                    "video_url": {"url": video_data_url},
                }
            elif image_url:
                # Use direct image URL
                logger.info("Using direct image URL: %s", image_url[:100])
                media_content = {"type": "image_url", "image_url": {"url": image_url}}
            elif parsed_imageRef:
                # Fetch image from Redis
                result = await fetch_image_from_redis(parsed_imageRef)
                if result[0] is None:
                    return result[1]  # Return error message

                image_base64, mime_type = result
                # Construct data URL for base64 image
                image_data_url = f"data:{mime_type};base64,{image_base64}"
                media_content = {
                    "type": "image_url",
                    "image_url": {"url": image_data_url},
                }

            media_type = "video" if (video_url or parsed_videoRef) else "image"
            logger.info(
                "Sending %s comprehension request to %s with model %s",
                media_type,
                config.api_endpoint,
                config.model,
            )

            # Make the chat completion request using OpenAI SDK
            response = await openai_client.chat.completions.create(
                model=config.model,
                messages=[
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": question}, media_content],
                    }
                ],
                max_tokens=max_tokens if max_tokens is not None else config.max_tokens,
            )

            # Extract the response content
            if response.choices and len(response.choices) > 0:
                answer = response.choices[0].message.content
                logger.info("Successfully received response from VLM")
                return answer

            logger.error("Unexpected response format: %s", response)
            return "Error: Unexpected response format from the Vision Language Model."

        except Exception as e:
            logger.error("Error during media comprehension: %s", str(e), exc_info=True)
            return f"Error: {str(e)}"

    try:
        # Register the function with proper description
        logger.info("Registering function comprehend_media")

        description = (
            "Analyzes an image or video and answers questions about its content using a Vision Language Model. "
            "Use when a user uploads an image/video and asks questions about what's in it, "
            "wants to identify objects, describe scenes, read text, or understand visual content. "
            "For images: provide imageRef (object with imageId and sessionId) or image_url (direct URL). "
            "For videos: provide videoRef (object with videoId and sessionId) or video_url (direct URL). "
            "Supported video codecs: H264, H265, VP8, VP9, FLV. Supported video formats: MP4, FLV, 3GP. "
            "Returns a text response answering the question about the image or video."
        )

        function_info = FunctionInfo.from_fn(
            comprehend_media,
            description=description,
        )
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up image_comprehension workflow.")
