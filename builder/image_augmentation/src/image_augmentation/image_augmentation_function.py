import base64
import io
import json
import logging
import os
from typing import Literal

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from PIL import Image
from pydantic import BaseModel, Field

import redis

logger = logging.getLogger(__name__)

# Valid dimension pairs (width x height) for Flux Kontext API
VALID_DIMENSION_PAIRS = [
    (672, 1568),
    (688, 1504),
    (720, 1456),
    (752, 1392),
    (800, 1328),
    (832, 1248),
    (880, 1184),
    (944, 1104),
    (1024, 1024),
    (1104, 944),
    (1184, 880),
    (1248, 832),
    (1328, 800),
    (1392, 752),
    (1456, 720),
    (1504, 688),
    (1568, 672),
]


def find_closest_dimension_pair(width: int, height: int) -> tuple[int, int]:
    """
    Find the closest valid dimension pair based on aspect ratio.

    Matches based on aspect ratio similarity and total area.
    """
    target_aspect = width / height
    target_area = width * height

    def score(dim_pair: tuple[int, int]) -> float:
        w, h = dim_pair
        aspect = w / h
        area = w * h

        # Weight aspect ratio more heavily than area
        aspect_diff = abs(aspect - target_aspect)
        area_diff = abs(area - target_area) / target_area

        return aspect_diff * 2.0 + area_diff

    return min(VALID_DIMENSION_PAIRS, key=score)


def resize_image_to_valid_dimensions(
    image_data: bytes, mime_type: str
) -> tuple[str, int, int]:
    """
    Resize image to valid dimensions for Flux Kontext API.

    Args:
        image_data: Raw image bytes
        mime_type: MIME type of the image (e.g., 'image/png')

    Returns:
        Tuple of (base64_encoded_string, width, height)
    """
    try:
        # Load image from bytes
        img = Image.open(io.BytesIO(image_data))
        original_width, original_height = img.size

        # Find closest valid dimension pair
        target_width, target_height = find_closest_dimension_pair(
            original_width, original_height
        )

        # Check if resizing is needed
        if original_width == target_width and original_height == target_height:
            logger.info("Image already has valid dimensions, no resizing needed")
            b64 = base64.b64encode(image_data).decode("utf-8")
            return b64, original_width, original_height

        logger.info(
            "Resizing image from %sx%s to %sx%s",
            original_width,
            original_height,
            target_width,
            target_height,
        )

        # Calculate scaling to maintain aspect ratio
        scale = min(target_width / original_width, target_height / original_height)
        scaled_width = int(original_width * scale)
        scaled_height = int(original_height * scale)

        # Create new image with target dimensions
        new_img = Image.new("RGB", (target_width, target_height), color=(0, 0, 0))

        # Resize original image
        resized = img.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)

        # Center the resized image
        offset_x = (target_width - scaled_width) // 2
        offset_y = (target_height - scaled_height) // 2
        new_img.paste(resized, (offset_x, offset_y))

        # Convert to bytes - always save as JPEG to match API output
        output = io.BytesIO()
        # Convert to RGB if needed (JPEG doesn't support transparency)
        if new_img.mode in ("RGBA", "LA", "P"):
            rgb_img = Image.new("RGB", new_img.size, (255, 255, 255))
            rgb_img.paste(
                new_img, mask=new_img.split()[-1] if new_img.mode == "RGBA" else None
            )
            new_img = rgb_img
        new_img.save(output, format="JPEG", quality=95)
        output.seek(0)

        # Return base64 encoded
        b64_result = base64.b64encode(output.read()).decode("utf-8")
        return b64_result, target_width, target_height

    except Exception as e:
        logger.error("Error resizing image: %s", e)
        # Fall back to returning original image
        return base64.b64encode(image_data).decode("utf-8"), 0, 0


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
        description=("Optional API key. Falls back to NVIDIA_API_KEY env var."),
    )


class ImageAugmentationInput(BaseModel):
    """Input model for the image augmentation function."""

    prompt: str = Field(
        ..., description="Text prompt describing the desired augmentation"
    )
    imageRef: dict = Field(
        ..., description="Image reference with imageId and sessionId"
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
                logger.error(
                    "Invalid imageRef received. Type: %s, Value: %s",
                    type(imageRef),
                    imageRef,
                )
                return (
                    "Error: Invalid or missing image reference. "
                    "Expected a dictionary with imageId, sessionId, and optionally mimeType. "
                    f"Received: {type(imageRef).__name__} = {repr(imageRef)}"
                )

            image_id = imageRef.get("imageId")
            session_id = imageRef.get("sessionId")
            user_id = imageRef.get("userId")  # Extract userId if present

            if not image_id:
                return (
                    f"I understand you want to: **{prompt}**\n\n"
                    "However, I couldn't find a valid image reference. "
                    "Please make sure the image was uploaded successfully."
                )

            logger.info(
                "augment_image_simple called with prompt='%s', imageRef=%s",
                prompt,
                imageRef,
            )
            logger.info(
                "Fetching image %s from session %s (user: %s) via Redis",
                image_id,
                session_id,
                user_id or "anonymous",
            )

            # Construct Redis key based on whether user is authenticated
            # Frontend stores images differently for authenticated vs anonymous users:
            # - Authenticated: user:{userId}:image:{imageId}
            # - Anonymous: image:{sessionId}:{imageId}
            redis_keys = []

            # If we have a userId, try the user-specific key first
            if user_id:
                redis_keys.append(f"user:{user_id}:image:{image_id}")

            # Also try the session-based key as fallback
            if session_id:
                redis_keys.append(f"image:{session_id}:{image_id}")

            # Try to fetch image data from Redis using multiple possible keys
            image_data_json = None

            for redis_key in redis_keys:
                try:
                    logger.info("Trying Redis key: %s", redis_key)
                    image_data_json = redis_client.execute_command(
                        "JSON.GET", redis_key
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
                    f"I understand you want to: **{prompt}**\n\n"
                    "However, I couldn't retrieve the image. "
                    "The image may have expired or the session may be "
                    "invalid. Please try uploading the image again."
                )

            try:
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

                logger.info(
                    "Successfully retrieved image from Redis (size: %d bytes)",
                    len(image_base64),
                )

                # Decode base64 to bytes for resizing
                image_bytes = base64.b64decode(image_base64)

                # Resize image to valid dimensions
                resized_base64, width, height = resize_image_to_valid_dimensions(
                    image_bytes, mime_type
                )

                if width > 0 and height > 0:
                    logger.info("Image resized to %sx%s", width, height)

                # Construct data URL with resized image
                image_data_url = f"data:{mime_type};base64,{resized_base64}"

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
                "disable_safety_checker": True,
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
                status = response.status_code
                details = response.text
                return (
                    f"Error: Image augmentation failed with status {status}. "
                    f"Details: {details}"
                )

            # Parse the response
            try:
                response_data = ImageResponse.model_validate(response.json())
                artifact = response_data.artifacts[0]

                # Return markdown directly (same pattern as generation)
                # Note: Flux Kontext API returns JPEG per the OpenAPI spec
                b64_data = artifact.base64
                markdown_image = (
                    f"![Augmented image](data:image/jpeg;base64,{b64_data})"
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
            status_code = e.response.status_code
            return f"Error augmenting image: HTTP {status_code}"
        except Exception as e:
            logger.error("Error augmenting image: %s", str(e), exc_info=True)
            return f"Error augmenting image: {str(e)}"

    try:
        # Register the function with proper description
        logger.info("Registering function augment_image_simple")
        description = (
            "Augments or modifies an uploaded image based on text "
            "instructions. Use when a user uploads an image and requests "
            "edits, additions, or transformations. Requires prompt (text "
            "description of desired changes) and imageRef (object with "
            "imageId and sessionId). Returns augmented image as markdown."
        )
        function_info = FunctionInfo.from_fn(
            augment_image_simple,
            description=description,
        )
        yield function_info
    finally:
        logger.info("Cleaning up image_augmentation workflow.")
