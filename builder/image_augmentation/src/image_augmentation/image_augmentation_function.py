import json
import logging
import os
from typing import Literal

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import BaseModel, Field

import redis

logger = logging.getLogger(__name__)


# API Models based on the OpenAPI schema (flux-kontext)
class Artifact(BaseModel):
    """Generated image artifact."""

    base64: str = Field(
        ..., description="Base64-encoded string of the generated image (JPEG)"
    )
    finishReason: Literal["SUCCESS", "ERROR", "CONTENT_FILTERED"] = Field(
        ..., description="The result of the generation process"
    )
    seed: int = Field(..., description="The seed used during generation")


class ImageResponse(BaseModel):
    """Response model for image augmentation."""

    artifacts: list[Artifact] = Field(..., min_length=1, max_length=1)


class ImageAugmentationFunctionConfig(
    FunctionBaseConfig,
    name="image_augmentation",
):
    api_endpoint: str = Field(
        "http://localhost:8000",
        description="Base URL for the augmentation API endpoint",
    )
    redis_url: str = Field(
        "redis://redis:6379",
        description="Redis connection URL for retrieving uploaded images",
    )
    default_steps: int = Field(30, description="Fallback number of diffusion steps")
    default_seed: int = Field(42, description="Fallback seed value")
    timeout: float = Field(300.0, description="HTTP timeout in seconds")
    api_key: str | None = Field(
        default=None,
        description="Optional API key. Falls back to NVIDIA_API_KEY environment variable if unset.",
    )


class ImageAugmentationInput(BaseModel):
    """Input model for the image augmentation function."""

    prompt: str = Field(
        ..., description="Text prompt describing the desired augmentation"
    )
    imageRef: dict = Field(
        ..., description="Image reference object with imageId and sessionId"
    )
    steps: int | None = Field(None, description="Number of diffusion steps (5-100)")
    seed: int | None = Field(None, description="Random seed (0 for random)")
    cfg_scale: float | None = Field(None, description="Guidance scale (1.0-9.0)")


@register_function(config_type=ImageAugmentationFunctionConfig)
async def image_augmentation_function(
    config: ImageAugmentationFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    # Initialize HTTP client headers for API calls
    headers = {}
    api_key = config.api_key or os.getenv("NVIDIA_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # Initialize Redis client
    redis_client = redis.from_url(
        config.redis_url,
        decode_responses=False,  # We need binary data for images
    )

    async def augment_image_simple(
        prompt: str,
        imageRef: dict,
        steps: int | None = None,
        seed: int | None = None,
        cfg_scale: float | None = None,
    ) -> str:
        """
        Simple image augmentation function for UI display.

        Args:
            prompt: Text prompt describing the desired augmentation
            imageRef: Image reference object with imageId and sessionId
            steps: Optional number of diffusion steps
            seed: Optional random seed
            cfg_scale: Optional guidance scale

        Returns:
            Markdown-formatted augmented image ready for display
        """
        try:
            # Validate inputs
            if not prompt or not prompt.strip():
                return "Error: No augmentation prompt provided."

            if not imageRef or not isinstance(imageRef, dict):
                return "Error: Invalid or missing image reference."

            image_id = imageRef.get("imageId")
            session_id = imageRef.get("sessionId")

            if not image_id or not session_id:
                return (
                    f"I understand you want to: **{prompt}**\n\n"
                    "However, I couldn't find a valid image reference. "
                    "Please make sure the image was uploaded successfully."
                )

            logger.info(
                "Fetching image %s from session %s via Redis", image_id, session_id
            )

            # Construct Redis key (same pattern as frontend)
            # Frontend uses: sessionKey(['image', sessionId, imageId])
            # which joins with ':' => 'image:{sessionId}:{imageId}'
            redis_key = f"image:{session_id}:{image_id}"

            # Fetch image data from Redis
            try:
                image_data_json = redis_client.execute_command("JSON.GET", redis_key)

                if not image_data_json:
                    logger.error(
                        "Image %s not found in Redis (key: %s)",
                        image_id,
                        redis_key,
                    )
                    return (
                        f"I understand you want to: **{prompt}**\n\n"
                        "However, I couldn't retrieve the image. "
                        "The image may have expired or the session may be invalid. "
                        "Please try uploading the image again."
                    )

                # Parse the JSON data
                image_record = json.loads(image_data_json)

                # Extract base64 data and mime type
                image_base64 = image_record.get("data")
                mime_type = (
                    imageRef.get("mimeType")
                    or image_record.get("mimeType")
                    or "image/png"
                )

                if not image_base64:
                    logger.error("Image data is empty for image %s", image_id)
                    return "Error: Retrieved image data is empty."

                # Construct data URL
                image_data_url = f"data:{mime_type};base64,{image_base64}"

                logger.info(
                    "Successfully retrieved image from Redis (size: %d bytes)",
                    len(image_base64),
                )

            except redis.RedisError as e:
                logger.error("Redis error fetching image %s: %s", image_id, e)
                return (
                    f"I understand you want to: **{prompt}**\n\n"
                    "However, there was an error accessing the image storage. "
                    "Please try again."
                )
            except (json.JSONDecodeError, KeyError) as e:
                logger.error("Error parsing image data from Redis: %s", e)
                return "Error: Failed to parse image data from storage."

            # Build augmentation request
            request_data = {
                "prompt": prompt,
                "image": image_data_url,
                "seed": seed if seed is not None else config.default_seed,
                "steps": steps if steps is not None else config.default_steps,
            }

            if cfg_scale is not None:
                request_data["cfg_scale"] = cfg_scale

            # Make the API request with separate client
            async with httpx.AsyncClient(timeout=config.timeout) as api_client:
                response = await api_client.post(
                    f"{config.api_endpoint}/v1/infer",
                    json=request_data,
                    headers=headers,
                )

            if response.status_code != 200:
                logger.error(
                    "Augmentation API error: %s - %s",
                    response.status_code,
                    response.text,
                )
                return (
                    f"Error: Image augmentation failed with status {response.status_code}. "
                    f"Details: {response.text}"
                )

            # Parse the response
            try:
                response_data = ImageResponse.model_validate(response.json())
                artifact = response_data.artifacts[0]

                # Return markdown directly (same pattern as image_generation)
                markdown_image = (
                    f"![Augmented image](data:image/png;base64,{artifact.base64})"
                )

                logger.info("Successfully augmented image, returning markdown")
                return str(markdown_image)

            except Exception as parse_error:
                logger.error("Failed to parse augmentation response: %s", parse_error)
                return "Error: Failed to parse augmentation response."

        except httpx.HTTPStatusError as e:
            logger.error(
                "HTTP error during augmentation: %s - %s",
                e.response.status_code,
                e.response.text,
            )
            return f"Error augmenting image: HTTP {e.response.status_code}"
        except Exception as e:
            logger.error("Error augmenting image: %s", str(e), exc_info=True)
            return f"Error augmenting image: {str(e)}"

    try:
        # Register the function with proper description
        logger.info("Registering function augment_image_simple")
        function_info = FunctionInfo.from_fn(
            augment_image_simple,
            description=(
                "Augments or modifies an uploaded image based on text instructions. "
                "Use when a user uploads an image and requests edits, additions, or transformations. "
                "Requires prompt (text description of desired changes) and imageRef (object with imageId and sessionId). "
                "Returns augmented image as markdown."
            ),
        )
        yield function_info
    finally:
        logger.info("Cleaning up image_augmentation workflow.")
