import asyncio
import base64
import io
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Literal

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from openai import AsyncOpenAI
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

        # Create new image with target dimensions, preserving alpha if present
        has_alpha = img.mode in ("RGBA", "LA", "PA")
        if has_alpha:
            new_img = Image.new(
                "RGBA", (target_width, target_height), color=(0, 0, 0, 0)
            )
        else:
            new_img = Image.new("RGB", (target_width, target_height), color=(0, 0, 0))

        # Resize original image
        resized = img.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)

        # Center the resized image
        offset_x = (target_width - scaled_width) // 2
        offset_y = (target_height - scaled_height) // 2

        # Handle pasting with or without alpha
        if has_alpha and resized.mode == "RGBA":
            new_img.paste(resized, (offset_x, offset_y), mask=resized.split()[-1])
        else:
            new_img.paste(resized, (offset_x, offset_y))

        # Convert to bytes - save as PNG for lossless quality
        output = io.BytesIO()
        new_img.save(output, format="PNG", optimize=True)
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

    base64: str = Field(..., description="Base64-encoded string of the generated image")
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
    """
    Configuration for image augmentation function.
    Supports NIM (Flux Kontext), OpenAI, and OpenRouter APIs.
    """

    api_type: Literal["nim", "openai", "openrouter"] = Field(
        "nim",
        description="API type to use: 'nim' for NIM/Flux Kontext, 'openai' for OpenAI, or 'openrouter' for OpenRouter",
    )
    api_endpoint: str = Field(
        "http://localhost:8000",
        description="Base URL for the API endpoint (used for NIM)",
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
        description="Optional API key. Falls back to NVIDIA_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY env var based on api_type.",
    )
    openai_model: str = Field(
        "gpt-image-1",
        description="OpenAI model to use for image editing (openai type only)",
    )
    openrouter_model: str = Field(
        "openai/gpt-5-image-mini",
        description="OpenRouter model to use for image augmentation (openrouter type only)",
    )


class ImageAugmentationInput(BaseModel):
    """Input model for the image augmentation function."""

    prompt: str = Field(
        ..., description="Text prompt describing the desired augmentation"
    )
    imageRef: dict | list[dict] | None = Field(
        None,
        description="Image reference with imageId and sessionId (single image for NIM/OpenAI, or list of up to 15 images for OpenRouter)",
    )
    imageRefs: list[dict] | None = Field(
        None, description="List of image references (up to 15 for OpenRouter)"
    )
    steps: int | None = Field(None, description="Number of diffusion steps (5-100)")
    seed: int | None = Field(None, description="Random seed (0 for random)")
    cfg_scale: float | None = Field(None, description="Guidance scale (1.0-9.0)")

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
        # Pre-process imageRef and imageRefs to handle JSON strings
        if "imageRef" in data:
            data["imageRef"] = self._parse_json_string(data["imageRef"])
        if "imageRefs" in data:
            if isinstance(data["imageRefs"], str):
                data["imageRefs"] = self._parse_json_string(data["imageRefs"])
            elif isinstance(data["imageRefs"], list):
                data["imageRefs"] = [
                    self._parse_json_string(ref) for ref in data["imageRefs"]
                ]
        super().__init__(**data)


@register_function(config_type=ImageAugmentationFunctionConfig)
async def image_augmentation_function(
    config: ImageAugmentationFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    # Initialize HTTP client headers for API calls
    headers = {}
    if config.api_type == "nim":
        api_key = config.api_key or os.getenv("NVIDIA_API_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

    # Initialize Redis client
    redis_client = redis.from_url(
        config.redis_url,
        decode_responses=False,  # We need binary data for images
    )

    async def store_image_in_redis(
        b64_data: str,
        mime_type: str,
        prompt: str,
    ) -> str:
        """
        Store augmented image in Redis for persistence.

        Args:
            b64_data: Base64-encoded image data
            mime_type: MIME type of the image
            prompt: The prompt used for augmentation

        Returns:
            The generated image ID
        """
        image_id = str(uuid.uuid4())
        redis_key = f"generated:image:{image_id}"

        image_record = {
            "data": b64_data,
            "mimeType": mime_type,
            "prompt": prompt,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "source": "image_augmentation",
        }

        try:
            await asyncio.to_thread(
                redis_client.execute_command,
                "JSON.SET",
                redis_key,
                "$",
                json.dumps(image_record),
            )
            # Set expiry to 7 days (604800 seconds)
            await asyncio.to_thread(redis_client.expire, redis_key, 604800)
            logger.info("Stored augmented image in Redis with key: %s", redis_key)
        except redis.RedisError as e:
            logger.error("Failed to store image in Redis: %s", e)

        return image_id

    async def fetch_image_from_redis(
        imageRef: dict,
    ) -> tuple[str, str] | tuple[None, str]:
        """
        Fetch image data from Redis.

        Args:
            imageRef: Image reference with imageId, sessionId, and optionally userId

        Returns:
            Tuple of (base64_data, error_message) - base64_data is None if error
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

        # Try to fetch image data from Redis (wrapped in to_thread since redis is synchronous)
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

    async def _nim_api_call(
        request_data: dict,
    ) -> httpx.Response:
        """Send a request to the NIM Flux Kontext API."""
        async with httpx.AsyncClient(timeout=config.timeout) as api_client:
            return await api_client.post(
                f"{config.api_endpoint}/v1/infer",
                json=request_data,
                headers=headers,
            )

    async def _nim_parse_response(response: httpx.Response, prompt: str) -> str:
        """Parse a successful NIM API response into markdown."""
        response_data = ImageResponse.model_validate(response.json())
        artifact = response_data.artifacts[0]

        jpeg_bytes = base64.b64decode(artifact.base64)
        img = Image.open(io.BytesIO(jpeg_bytes))
        png_output = io.BytesIO()
        img.save(png_output, format="PNG", optimize=True)
        png_output.seek(0)
        png_base64 = base64.b64encode(png_output.read()).decode("utf-8")

        image_id = await store_image_in_redis(png_base64, "image/png", prompt)
        logger.info("Stored NIM augmented image with ID: %s", image_id)

        markdown_image = f"![Augmented image](/api/generated-image/{image_id})"
        logger.info("Returning augmented image reference: %s", markdown_image)
        return str(markdown_image)

    async def augment_image_nim(
        prompt: str,
        imageRef: dict,
        steps: int | None = None,
        seed: int | None = None,
        cfg_scale: float | None = None,
    ) -> str:
        """
        Augment image using NIM (Flux Kontext) API.

        Tries the original image dimensions first, then falls back to
        resizing to valid Flux Kontext dimensions on API failure.

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
            if not prompt or not prompt.strip():
                return "Error: No augmentation prompt provided."

            # Fetch image from Redis
            result = await fetch_image_from_redis(imageRef)
            if result[0] is None:
                return result[1]  # Return error message

            image_base64, mime_type = result
            image_bytes = base64.b64decode(image_base64)

            # Build base request parameters
            base_params: dict = {
                "prompt": prompt,
                "disable_safety_checker": True,
                "seed": seed if seed is not None else config.default_seed,
                "steps": steps if steps is not None else config.default_steps,
            }
            if cfg_scale is not None:
                base_params["cfg_scale"] = cfg_scale

            # --- Attempt 1: use original image dimensions ---
            original_data_url = f"data:{mime_type};base64,{image_base64}"
            request_data = {**base_params, "image": original_data_url}

            logger.info("Attempting NIM API call with original image dimensions")
            response = await _nim_api_call(request_data)

            if response.status_code == 200:
                return await _nim_parse_response(response, prompt)

            # --- Attempt 2: resize to valid dimensions and retry ---
            logger.warning(
                "NIM API rejected original dimensions (status %s), "
                "retrying with resized image: %s",
                response.status_code,
                response.text[:200],
            )

            resized_base64, width, height = resize_image_to_valid_dimensions(
                image_bytes, mime_type
            )
            if width > 0 and height > 0:
                logger.info("Image resized to %sx%s for retry", width, height)

            resized_data_url = f"data:image/png;base64,{resized_base64}"
            request_data = {**base_params, "image": resized_data_url}

            response = await _nim_api_call(request_data)

            if response.status_code != 200:
                logger.error(
                    "Augmentation API error after resize: %s - %s",
                    response.status_code,
                    response.text,
                )
                return f"Error: Image augmentation failed with status {response.status_code}."

            return await _nim_parse_response(response, prompt)

        except httpx.HTTPStatusError as e:
            logger.error("HTTP error during augmentation: %s", e.response.status_code)
            return f"Error augmenting image: HTTP {e.response.status_code}"
        except Exception as e:
            logger.error("Error augmenting image: %s", str(e), exc_info=True)
            return f"Error augmenting image: {str(e)}"

    async def augment_image_openai(
        prompt: str,
        imageRef: dict,
        steps: int | None = None,
        seed: int | None = None,
        cfg_scale: float | None = None,
    ) -> str:
        """
        Augment image using OpenAI API.

        Args:
            prompt: Text prompt describing the desired augmentation
            imageRef: Image reference object with imageId and sessionId
            steps: Unused (for API compatibility)
            seed: Unused (for API compatibility)
            cfg_scale: Unused (for API compatibility)

        Returns:
            Markdown-formatted augmented image ready for display
        """
        # Suppress unused argument warnings
        _ = steps, seed, cfg_scale

        try:
            if not prompt or not prompt.strip():
                return "Error: No augmentation prompt provided."

            # Get API key
            api_key = config.api_key or os.getenv("OPENAI_API_KEY")
            if not api_key:
                return "Error: OpenAI API key is required"

            # Fetch image from Redis
            result = await fetch_image_from_redis(imageRef)
            if result[0] is None:
                return result[1]

            image_base64, mime_type = result

            # Create OpenAI client
            client = AsyncOpenAI(api_key=api_key, timeout=config.timeout)

            logger.info(
                "Augmenting image with OpenAI using prompt: %s...",
                prompt[:50],
            )

            # Use the images.edit endpoint with the image
            # OpenAI's gpt-image-1 supports editing via the images.edit endpoint
            # We need to pass the image as a file-like object
            image_bytes = base64.b64decode(image_base64)

            # Prepare image for OpenAI API - create file tuple
            image_file = io.BytesIO(image_bytes)
            image_file.name = "image.png"

            # Use images.edit for augmentation
            response = await client.images.edit(
                model=config.openai_model,
                image=image_file,
                prompt=prompt,
                n=1,
                size="1024x1024",
            )

            # Extract base64 data
            b64_data = response.data[0].b64_json

            # Store in Redis for persistence
            image_id = await store_image_in_redis(b64_data, "image/png", prompt)
            logger.info("Stored OpenAI augmented image with ID: %s", image_id)

            # Return markdown with URL reference
            markdown_image = f"![Augmented image](/api/generated-image/{image_id})"
            logger.info("Returning augmented image reference: %s", markdown_image)
            return str(markdown_image)

        except Exception as e:
            logger.error("Error augmenting image with OpenAI: %s", str(e))
            return f"Error augmenting image: {str(e)}"

    async def augment_image_openrouter(
        prompt: str,
        imageRef: dict | list[dict] | None = None,
        steps: int | None = None,
        seed: int | None = None,
        cfg_scale: float | None = None,
    ) -> str:
        """
        Augment image using OpenRouter API.
        Supports up to 15 images for multi-image augmentation.

        Args:
            prompt: Text prompt describing the desired augmentation
            imageRef: Single image reference or list of up to 15 image references
            steps: Unused (for API compatibility)
            seed: Unused (for API compatibility)
            cfg_scale: Unused (for API compatibility)

        Returns:
            Markdown-formatted augmented image ready for display
        """
        # Suppress unused argument warnings
        _ = steps, seed, cfg_scale

        try:
            if not prompt or not prompt.strip():
                return "Error: No augmentation prompt provided."

            # Get API key
            api_key = config.api_key or os.getenv("OPENROUTER_API_KEY")
            if not api_key:
                return "Error: OpenRouter API key is required"

            # Handle both single image and multiple images
            image_refs = []
            if imageRef:
                if isinstance(imageRef, list):
                    image_refs = imageRef[:15]  # Limit to 15 images
                else:
                    image_refs = [imageRef]

            if not image_refs:
                return "Error: No image references provided."

            if len(image_refs) > 15:
                logger.warning("More than 15 images provided, limiting to first 15")
                image_refs = image_refs[:15]

            logger.info(
                "Augmenting %d image(s) with OpenRouter using prompt: %s...",
                len(image_refs),
                prompt[:50],
            )

            # Fetch all images from Redis
            content_parts = []
            for idx, img_ref in enumerate(image_refs):
                result = await fetch_image_from_redis(img_ref)
                if result[0] is None:
                    logger.error("Failed to fetch image %d: %s", idx + 1, result[1])
                    return f"Error: Failed to fetch image {idx + 1}: {result[1]}"

                image_base64, mime_type = result
                image_data_url = f"data:{mime_type};base64,{image_base64}"
                content_parts.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": image_data_url},
                    }
                )

            # Add text prompt at the end
            content_parts.append(
                {
                    "type": "text",
                    "text": f"{prompt}",
                }
            )

            # Prepare request with images in the message content
            url = "https://openrouter.ai/api/v1/chat/completions"
            request_headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }

            payload = {
                "model": config.openrouter_model,
                "messages": [
                    {
                        "role": "user",
                        "content": content_parts,
                    }
                ],
            }

            # Make the API request
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                response = await client.post(url, headers=request_headers, json=payload)
                response.raise_for_status()
                result = response.json()

            # Extract response - can be either text or image
            if result.get("choices"):
                message = result["choices"][0].get("message", {})

                # Check if there's an image in the response
                if message.get("images"):
                    image_data = message["images"][0]
                    image_url = image_data.get("image_url", {}).get("url", "")

                    if image_url:
                        image_id = None
                        # Extract base64 data from data URL for Redis storage
                        if image_url.startswith("data:"):
                            parts = image_url.split(",", 1)
                            if len(parts) == 2:
                                mime_part = parts[0]
                                b64_data = parts[1]
                                output_mime = "image/png"
                                if ":" in mime_part and ";" in mime_part:
                                    output_mime = mime_part.split(":")[1].split(";")[0]
                                image_id = await store_image_in_redis(
                                    b64_data, output_mime, prompt
                                )
                                logger.info(
                                    "Stored OpenRouter augmented image with ID: %s",
                                    image_id,
                                )
                        else:
                            # Non-data URL (e.g. hosted image) - download and store
                            try:
                                async with httpx.AsyncClient(
                                    timeout=config.timeout
                                ) as dl_client:
                                    img_resp = await dl_client.get(image_url)
                                    img_resp.raise_for_status()
                                    import base64 as _b64

                                    b64_data = _b64.b64encode(img_resp.content).decode()
                                    ct = img_resp.headers.get(
                                        "content-type", "image/png"
                                    )
                                    image_id = await store_image_in_redis(
                                        b64_data, ct, prompt
                                    )
                                    logger.info(
                                        "Downloaded and stored OpenRouter augmented image with ID: %s",
                                        image_id,
                                    )
                            except Exception as dl_exc:
                                logger.error("Failed to download image URL: %s", dl_exc)

                        if image_id:
                            markdown_image = (
                                f"![Augmented image](/api/generated-image/{image_id})"
                            )
                            logger.info(
                                "Returning augmented image reference: %s",
                                markdown_image,
                            )
                            return str(markdown_image)

                # Check for text content (fallback or alternative response)
                if message.get("content"):
                    logger.info(
                        "OpenRouter returned text response: %s",
                        message["content"][:100],
                    )
                    return message["content"]

            return "Error: No image or text generated in response"

        except httpx.HTTPStatusError as e:
            logger.error("HTTP error: %s - %s", e.response.status_code, e.response.text)
            return f"Error augmenting image: HTTP {e.response.status_code}"
        except Exception as e:
            logger.error("Error augmenting image with OpenRouter: %s", str(e))
            return f"Error augmenting image: {str(e)}"

    async def augment_image_simple(
        prompt: str,
        imageRef: dict | list[dict] | None = None,
        imageRefs: list[dict] | None = None,
        steps: int | None = None,
        seed: int | None = None,
        cfg_scale: float | None = None,
    ) -> str:
        """
        Simple image augmentation function for UI display.
        Routes to appropriate backend based on api_type configuration.

        Args:
            prompt: Text prompt describing the desired augmentation
            imageRef: Single image reference or list of image references (for backward compatibility)
            imageRefs: List of image references (preferred for multiple images)
            steps: Optional number of diffusion steps
            seed: Optional random seed
            cfg_scale: Optional guidance scale

        Returns:
            Markdown-formatted augmented image ready for display
        """
        # Normalize input: prefer imageRefs if provided, otherwise use imageRef
        images = imageRefs if imageRefs else imageRef

        # For OpenRouter, support multiple images
        if config.api_type == "openrouter":
            return await augment_image_openrouter(
                prompt, images, steps, seed, cfg_scale
            )

        # For OpenAI and NIM, only support single image
        if config.api_type == "openai":
            single_image = images[0] if isinstance(images, list) else images
            if single_image is None:
                return "Error: No image reference provided."
            return await augment_image_openai(
                prompt, single_image, steps, seed, cfg_scale
            )

        # Default to NIM
        single_image = images[0] if isinstance(images, list) else images
        if single_image is None:
            return "Error: No image reference provided."
        return await augment_image_nim(prompt, single_image, steps, seed, cfg_scale)

    try:
        # Register the function with proper description
        logger.info("Registering function augment_image_simple")

        # Create description based on API type
        if config.api_type == "openai":
            description = (
                "Augments or modifies an uploaded image using OpenAI's image editing API. "
                "Use when a user uploads an image and requests edits, additions, or transformations. "
                "Requires prompt (text description of desired changes) and imageRef (object with "
                "imageId and sessionId). Returns augmented image as markdown."
            )
        elif config.api_type == "openrouter":
            description = (
                "Augments or modifies one or more uploaded images using OpenRouter's multimodal API. "
                "Supports up to 15 images for multi-image augmentation. "
                "Use when a user uploads image(s) and requests edits, additions, or transformations. "
                "Requires prompt (text description of desired changes) and either imageRef (single image or list) "
                "or imageRefs (list of images with imageId and sessionId). Returns augmented image as markdown."
            )
        else:
            description = (
                "Augments or modifies an uploaded image using Flux Kontext model. "
                "Use when a user uploads an image and requests edits, additions, or transformations. "
                "Requires prompt (text description of desired changes) and imageRef (object with "
                "imageId and sessionId). Returns augmented image as markdown."
            )

        function_info = FunctionInfo.from_fn(
            augment_image_simple,
            description=description,
        )
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up image_augmentation workflow.")
