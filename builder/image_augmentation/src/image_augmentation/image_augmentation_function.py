import json
import logging
import os

import redis
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.image_utils import (
    extract_images_from_response,
    fetch_image_from_redis,
    store_image_in_redis,
)
from openai import AsyncOpenAI
from pydantic import Field

logger = logging.getLogger(__name__)


class ImageAugmentationFunctionConfig(
    FunctionBaseConfig,
    name="image_augmentation",
):
    """Configuration for image augmentation via OpenAI-compatible chat completions."""

    api_endpoint: str | None = Field(
        None,
        description="Base URL for OpenAI-compatible endpoint. If unset, uses OpenAI default.",
    )
    redis_url: str = Field(
        "redis://redis:6379",
        description="Redis connection URL for retrieving uploaded images",
    )
    timeout: float = Field(300.0, description="HTTP timeout in seconds")
    api_key: str | None = Field(
        default=None,
        description="Optional API key. Falls back to OPENAI_API_KEY env var.",
    )
    model: str = Field(
        "gpt-image-1",
        description="Model to use for image augmentation",
    )
    image_config: dict | None = Field(
        default=None,
        description=(
            "Optional image configuration passed to the API. "
            "Supports keys like 'aspect_ratio' (e.g. '16:9') and "
            "'image_size' (e.g. '1K', '2K', '4K')."
        ),
    )


@register_function(config_type=ImageAugmentationFunctionConfig)
async def image_augmentation_function(
    config: ImageAugmentationFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    redis_client = redis.from_url(config.redis_url, decode_responses=False)

    async def augment_image(
        prompt: str,
        imageRef: str | dict | list[dict] | None = None,
    ) -> str:
        """
        Augment or modify uploaded images based on a text prompt.

        Sends source image(s) alongside the prompt to an OpenAI-compatible
        chat completions endpoint with image output modality, producing a
        new version of the image with the requested changes applied.

        Args:
            prompt: Text prompt describing the desired augmentation
            imageRef: Single image reference or list of image references
                (each with imageId and sessionId)

        Returns:
            Markdown-formatted augmented image ready for display
        """
        try:
            if not prompt or not prompt.strip():
                return "Error: No augmentation prompt provided."

            # Normalize imageRef into a list of dicts
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
                return "Error: No image reference provided."

            if not image_refs:
                return "Error: No image reference provided."

            # Build content parts: text prompt first, then source image(s)
            content: list[dict] = [{"type": "text", "text": prompt}]

            for idx, ref in enumerate(image_refs):
                result = await fetch_image_from_redis(redis_client, ref)
                if result[0] is None:
                    return f"Error fetching image {idx + 1}: {result[1]}"

                image_base64, mime_type = result
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{image_base64}"},
                    }
                )

            api_key = config.api_key or os.getenv("OPENAI_API_KEY")
            if not api_key:
                return "Error: API key is required"

            client_kwargs = {"api_key": api_key, "timeout": config.timeout}
            if config.api_endpoint:
                client_kwargs["base_url"] = config.api_endpoint
            client = AsyncOpenAI(**client_kwargs)

            extra_body: dict = {"modalities": ["image", "text"]}
            if config.image_config:
                extra_body["image_config"] = config.image_config

            logger.info(
                "Augmenting %d image(s) with prompt: %s...",
                len(image_refs),
                prompt[:50],
            )

            response = await client.chat.completions.create(
                model=config.model,
                messages=[{"role": "user", "content": content}],
                extra_body=extra_body,
            )

            images = extract_images_from_response(response)
            if not images:
                return "Error: No image was returned by the model."

            b64_data, mime_type = images[0]
            image_id = await store_image_in_redis(
                redis_client,
                b64_data,
                mime_type,
                prompt,
                source="image_augmentation",
            )

            return f"![Augmented image](/api/generated-image/{image_id})"

        except Exception as e:
            logger.error("Error augmenting image: %s", str(e))
            return f"Error augmenting image: {str(e)}"

    try:
        logger.info("Registering function augment_image")

        description = (
            "Augments, edits, or modifies uploaded images. Produces a new version of the "
            "image with the requested changes applied. Returns an image, not text. "
            "Use when a user uploads image(s) and requests augmentation, enhancement, edits, "
            "or transformations. Requires prompt (text description of desired changes) and "
            "imageRef (single object or list of objects with imageId and sessionId)."
        )

        function_info = FunctionInfo.from_fn(augment_image, description=description)
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up image_augmentation workflow.")
