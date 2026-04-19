import base64
import json
import logging
import os

import redis
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.image_utils import fetch_image_from_redis, store_image_in_redis
from nat_helpers.openai_images import edit_images
from openai import AsyncOpenAI
from pydantic import Field

logger = logging.getLogger(__name__)


class ImageAugmentationFunctionConfig(
    FunctionBaseConfig,
    name="image_augmentation",
):
    """Configuration for image augmentation via OpenAI's /v1/images/edits API."""

    api_endpoint: str | None = Field(
        None,
        description="Base URL for the OpenAI API. If unset, uses the SDK default.",
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
        "gpt-image-1.5",
        description="Model to use for image augmentation",
    )
    quality: str | None = Field(
        default=None,
        description=(
            "Optional rendering quality ('low' or 'high'). Prefer 'low' for "
            "latency-sensitive edits and 'high' for detail-heavy edits (text, "
            "fine materials). Passed to images.edit as `quality`."
        ),
    )
    input_fidelity: str | None = Field(
        default=None,
        description=(
            "Optional identity-preservation strength ('low' or 'high'). Use "
            "'high' when the source subject's likeness, geometry, or layout "
            "must be preserved (virtual try-on, sketch-to-render, targeted "
            "object swaps). Passed to images.edit as `input_fidelity`."
        ),
    )
    size: str | None = Field(
        default=None,
        description=(
            "Optional output size in pixels, e.g. '1024x1024', '1024x1536', "
            "'1536x1024', or 'auto'. Passed to images.edit as `size`."
        ),
    )
    n: int | None = Field(
        default=None,
        description=(
            "Optional number of edited variations to produce (1–10). When "
            ">1, each variation is stored separately and all markdown refs "
            "are returned."
        ),
    )


@register_function(config_type=ImageAugmentationFunctionConfig)
async def image_augmentation_function(
    config: ImageAugmentationFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    configured_key = (config.api_key or "").strip()
    if configured_key.startswith("${") and configured_key.endswith("}"):
        logger.warning(
            "image_augmentation api_key looks like an unexpanded placeholder (%s); "
            "falling back to OPENAI_API_KEY env var",
            configured_key,
        )
        configured_key = ""
    api_key = configured_key or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError(
            "API key is required (set api_key in config or OPENAI_API_KEY env var)"
        )

    redis_client = redis.from_url(config.redis_url, decode_responses=False)

    client_kwargs = {"api_key": api_key, "timeout": config.timeout}
    if config.api_endpoint:
        client_kwargs["base_url"] = config.api_endpoint
    client = AsyncOpenAI(**client_kwargs)

    async def augment_image(
        prompt: str,
        imageRef: str | dict | list[dict] | None = None,
    ) -> str:
        """
        Augment or modify uploaded images based on a text prompt.

        Sends source image(s) alongside the prompt to OpenAI's
        /v1/images/edits endpoint, producing a new version of the image
        with the requested changes applied.

        Prompting conventions (follow these to get best results):
          - Separate "what to change" from "what to preserve" explicitly.
            For example: "Change the sky to golden hour. Keep the subject's
            face, pose, clothing, and the camera angle exactly the same."
          - When multiple images are provided, index them and describe each
            one's role, e.g. "Image 1: portrait. Image 2: style reference.
            Apply Image 2's palette and brushwork to Image 1."
          - Repeat the preserve list on each follow-up turn to prevent
            drift ("keep everything else the same").
          - For identity-critical edits, also set `input_fidelity: "high"`
            in the tool config.

        Args:
            prompt: Text prompt describing the desired augmentation
            imageRef: Single image reference or list of image references
                (each with imageId and sessionId)

        Returns:
            Markdown-formatted augmented image ready for display. When `n`
            > 1 the returned string contains one markdown ref per line.
        """
        try:
            if not prompt or not prompt.strip():
                return "Error: No augmentation prompt provided."

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

            source_files: list[tuple[str, bytes, str]] = []
            for idx, ref in enumerate(image_refs):
                result = await fetch_image_from_redis(redis_client, ref)
                if result[0] is None:
                    return f"Error fetching image {idx + 1}: {result[1]}"

                image_base64, mime_type = result
                try:
                    image_bytes = base64.b64decode(image_base64)
                except (ValueError, TypeError) as exc:
                    return f"Error decoding image {idx + 1}: {exc}"

                extension = "jpg" if "jpeg" in mime_type else mime_type.split("/")[-1]
                source_files.append(
                    (f"image_{idx}.{extension}", image_bytes, mime_type)
                )

            results = await edit_images(
                client,
                model=config.model,
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
                    source="image_augmentation",
                )
                refs.append(f"![Augmented image](/api/generated-image/{image_id})")

            if not refs:
                return "Error: No image was returned by the model."

            return "\n".join(refs)

        except Exception as e:
            logger.error("Error augmenting image: %s", str(e))
            return f"Error augmenting image: {str(e)}"

    try:
        logger.info("Registering function augment_image")

        description = (
            "Augments, edits, or modifies uploaded images. Produces a new "
            "version of the image with the requested changes applied. Returns "
            "an image, not text. Use when a user uploads image(s) and requests "
            "augmentation, enhancement, edits, or transformations.\n"
            "\n"
            "Arguments:\n"
            "  - prompt: describe ONLY what should change, then add a preserve "
            "list ('keep the face, pose, camera angle, and lighting the same'). "
            "Repeat the preserve list each turn to avoid drift.\n"
            "  - imageRef: a single object or a list of objects with imageId "
            "and sessionId. When passing multiple images, index them in the "
            "prompt (e.g. 'Image 1: subject. Image 2: style reference. Apply "
            "Image 2's style to Image 1.').\n"
            "\n"
            "Good prompts are specific about what stays constant and what "
            "changes. For identity-preserving edits (try-on, sketch-to-render, "
            "targeted swaps) request the subject's face, body, and pose be "
            "kept exactly the same."
        )

        function_info = FunctionInfo.from_fn(augment_image, description=description)
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up image_augmentation workflow.")
