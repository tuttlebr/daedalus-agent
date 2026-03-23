import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Literal

import httpx
import redis
from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Supported aspect ratios with their corresponding dimensions for OpenRouter
ASPECT_RATIO_DIMENSIONS: dict[str, tuple[int, int]] = {
    "1:1": (1024, 1024),
    "2:3": (832, 1248),
    "3:2": (1248, 832),
    "3:4": (864, 1184),
    "4:3": (1184, 864),
    "4:5": (896, 1152),
    "5:4": (1152, 896),
    "9:16": (768, 1344),
    "16:9": (1344, 768),
    "21:9": (1536, 672),
}

# Valid aspect ratio literals for type checking
AspectRatioType = Literal[
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
]

DEFAULT_ASPECT_RATIO: AspectRatioType = "4:3"


# SD 3.5 API Models based on the OpenAPI schema
class TextPrompt(BaseModel):
    """Text prompt for image generation."""

    text: str = Field(..., description="The prompt itself")
    weight: float = Field(
        1.0, description="The weight of the prompt; only 1.0 is supported"
    )


class ImageRequest(BaseModel):
    """Request model for image generation."""

    prompt: str = Field(..., description="The text prompt for generation")
    cfg_scale: float | None = Field(
        3.5,
        description=("How strictly the diffusion process adheres to the prompt"),
        ge=1.0,
        le=9.0,
    )
    disable_safety_checker: bool | None = Field(
        False, description="Disable safety checks on the generated images"
    )
    height: int | None = Field(
        1024,
        description="The height of the image to generate, in pixels",
    )
    width: int | None = Field(
        1024,
        description="The width of the image to generate, in pixels",
    )
    image: str | None = Field(
        None, description="Base64 encoded image for depth/canny mode"
    )
    mode: Literal["base"] | None = Field("base", description="The NIM inference mode")
    preprocess_image: bool | None = Field(
        True, description="Apply preprocessor to input image"
    )
    samples: int | None = Field(
        1, description="Number of images to generate. Only 1 is supported", ge=1, le=1
    )
    seed: int | None = Field(
        0, description="Seed for generation. 0 for random seed", ge=0, lt=4294967296
    )
    steps: int | None = Field(
        50, description="Number of diffusion steps to run", ge=5, le=100
    )
    text_prompts: list[TextPrompt] | None = Field(
        None, description="Deprecated: Array of text prompts"
    )


class Artifact(BaseModel):
    """Generated image artifact."""

    base64: str = Field(
        ..., description="Base64-encoded string of the generated image (PNG)"
    )
    finishReason: Literal["SUCCESS", "ERROR", "CONTENT_FILTERED"] = Field(
        ..., description="The result of the generation process"
    )
    seed: int = Field(..., description="The seed used during generation")


class ImageResponse(BaseModel):
    """Response model for image generation."""

    artifacts: list[Artifact] = Field(..., min_length=1, max_length=1)


# OpenAI API Models
class OpenAIImageData(BaseModel):
    """OpenAI image data response."""

    b64_json: str = Field(..., description="Base64-encoded image data")


class OpenAIImageResponse(BaseModel):
    """OpenAI image generation response."""

    created: int = Field(
        ..., description="Unix timestamp of when the image was created"
    )
    data: list[OpenAIImageData] = Field(..., min_length=1)


class ImageGenerationFunctionConfig(FunctionBaseConfig, name="image_generation"):
    """
    Configuration for image generation function.
    Supports both NIM (Stable Diffusion 3.5) and OpenAI APIs.
    """

    api_type: Literal["nim", "openai", "openrouter", "custom"] = Field(
        "custom",
        description=(
            "API type to use: 'custom' for direct HTTP POST (e.g., NVIDIA API Catalog), "
            "'nim' for NIM /v1/infer, 'openai' for OpenAI SDK, "
            "or 'openrouter' for OpenRouter multimodal"
        ),
    )
    openrouter_model: str = Field(
        "google/gemini-2.5-flash-image-preview",
        description="OpenRouter model to use for image generation (openrouter type only)",
    )
    api_endpoint: str = Field(
        "http://localhost:8000",
        description="Base URL for the API endpoint (used for NIM)",
    )
    api_key: str | None = Field(None, description="API key for authentication")
    timeout: float = Field(120.0, description="Request timeout in seconds")
    default_width: int = Field(1024, description="Default image width in pixels")
    default_height: int = Field(1024, description="Default image height in pixels")
    default_steps: int = Field(
        50, description="Default number of diffusion steps (NIM only)"
    )
    openai_model: str = Field(
        "gpt-image-1", description="OpenAI model to use (openai type only)"
    )
    prompt_rewrite: dict | None = Field(
        default=None,
        description=(
            "Optional prompt rewrite configuration. Set to a mapping with "
            "values: { 'llm': '<llm_name>', 'system_prompt': '<prompt>', "
            "'max_tokens': <int>, 'temperature': <float> }."
        ),
    )
    redis_url: str = Field(
        "redis://redis:6379",
        description="Redis connection URL for storing generated images",
    )


class ImageGenerationInput(BaseModel):
    """Input model for the image generation function."""

    prompt: str = Field(..., description="The text prompt for image generation")
    width: int | None = Field(
        None, description="Image width (768-1344, supported values only)"
    )
    height: int | None = Field(
        None, description="Image height (768-1344, supported values only)"
    )
    steps: int | None = Field(None, description="Number of diffusion steps (5-100)")
    seed: int | None = Field(None, description="Random seed (0 for random)")
    cfg_scale: float | None = Field(None, description="Guidance scale (1.0-9.0)")
    disable_safety_checker: bool | None = Field(
        None, description="Disable safety checks"
    )


# Removed ImageGenerationOutput - now returning plain strings for UI display


@register_function(config_type=ImageGenerationFunctionConfig)
async def image_generation_function(
    config: ImageGenerationFunctionConfig, builder: Builder
):  # noqa: ARG001
    # Prepare headers for HTTP client
    headers = {}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    elif os.getenv("NVIDIA_API_KEY"):
        headers["Authorization"] = f"Bearer {os.getenv('NVIDIA_API_KEY')}"
    else:
        raise ValueError("API key is required")

    # Initialize Redis client for image persistence
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
        Store generated image in Redis for persistence.

        Args:
            b64_data: Base64-encoded image data
            mime_type: MIME type of the image (e.g., 'image/png')
            prompt: The prompt used to generate the image

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
            "source": "image_generation",
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
            logger.info("Stored generated image in Redis with key: %s", redis_key)
        except redis.RedisError as e:
            logger.error("Failed to store image in Redis: %s", e)

        return image_id

    async def rewrite_prompt_if_needed(
        original_prompt: str, client: httpx.AsyncClient
    ) -> str:
        if not config.prompt_rewrite:
            return original_prompt

        llm_name = config.prompt_rewrite.get("llm")
        if not llm_name:
            logger.warning("Prompt rewrite requested but no LLM provided")
            return original_prompt

        llm_kwargs: dict = {}
        if "max_tokens" in config.prompt_rewrite:
            llm_kwargs["max_tokens"] = config.prompt_rewrite["max_tokens"]
        if "temperature" in config.prompt_rewrite:
            llm_kwargs["temperature"] = config.prompt_rewrite["temperature"]

        system_prompt = config.prompt_rewrite.get(
            "system_prompt",
            (
                "You are an expert creative assistant. Improve the given prompt "
                "for high quality image generation while keeping the user's intent intact."
            ),
        )

        wrapper_type_value = config.prompt_rewrite.get("wrapper_type")
        if isinstance(wrapper_type_value, LLMFrameworkEnum):
            llm_wrapper = wrapper_type_value
        else:
            try:
                llm_wrapper = (
                    LLMFrameworkEnum(wrapper_type_value)
                    if wrapper_type_value is not None
                    else LLMFrameworkEnum.LANGCHAIN
                )
            except ValueError:
                logger.warning(
                    "Invalid wrapper_type '%s' for prompt rewrite; defaulting to LANGCHAIN",
                    wrapper_type_value,
                )
                llm_wrapper = LLMFrameworkEnum.LANGCHAIN

        try:
            llm_callable = await builder.get_llm(llm_name, wrapper_type=llm_wrapper)

            if llm_wrapper == LLMFrameworkEnum.LANGCHAIN:
                from langchain_core.messages import HumanMessage, SystemMessage

                langchain_llm = (
                    llm_callable.bind(**llm_kwargs) if llm_kwargs else llm_callable
                )

                messages_sequence = []
                if system_prompt:
                    messages_sequence.append(SystemMessage(content=system_prompt))
                messages_sequence.append(
                    HumanMessage(
                        content=f"Rewrite the following prompt into a succint text-to-image generation prompt. Remaining true to the user's request and intent but with greater detail and creativity.\n\nOriginal prompt: {original_prompt}"
                    )
                )

                rewritten = await langchain_llm.ainvoke(messages_sequence)
            else:
                rewritten = await llm_callable.invoke(
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {
                            "role": "user",
                            "content": f"Rewrite the following prompt into a succint text-to-image generation prompt. Remaining true to the user's request and intent but with greater detail and creativity.\n\nOriginal prompt: {original_prompt}",
                        },
                    ],
                    **llm_kwargs,
                )
            logger.info("System prompt: %s", system_prompt)
            logger.info(
                "Prompt rewrite successful using LLM '%s': %s", llm_name, rewritten
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Prompt rewrite failed using LLM '%s': %s", llm_name, exc)
            return original_prompt

        # Handle different response types
        # Try to extract content attribute (for LangChain AIMessage objects)
        if hasattr(rewritten, "content"):
            content = rewritten.content
            # Handle string content
            if isinstance(content, str) and content.strip():
                return content.strip()
            # Handle list content (multimodal responses with text blocks)
            if isinstance(content, list) and content:
                for block in content:
                    if isinstance(block, str) and block.strip():
                        return block.strip()
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text", "")
                        if isinstance(text, str) and text.strip():
                            return text.strip()
        # Handle dict responses
        if isinstance(rewritten, dict):
            content = rewritten.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
        # Handle plain string responses
        if isinstance(rewritten, str) and rewritten.strip():
            return rewritten.strip()

        logger.warning(
            "Prompt rewrite returned unexpected result type=%s; using original",
            type(rewritten),
        )
        return original_prompt

    # Using only simple string-based function for UI display

    async def generate_image_openai(prompt: str) -> str:
        """
        Generate image using OpenAI API.

        Args:
            prompt: Text prompt for image generation

        Returns:
            Markdown-formatted image ready for display
        """
        try:
            # Get API key
            api_key = config.api_key or os.getenv("OPENAI_API_KEY")
            if not api_key:
                return "Error: OpenAI API key is required"

            # Create OpenAI client - only set base_url if it's not the default NIM endpoint
            client_kwargs = {"api_key": api_key, "timeout": config.timeout}
            if config.api_endpoint and config.api_endpoint != "http://localhost:8000":
                client_kwargs["base_url"] = config.api_endpoint
            client = AsyncOpenAI(**client_kwargs)

            # Rewrite prompt if needed (using httpx client for compatibility)
            async with httpx.AsyncClient(timeout=config.timeout) as http_client:
                effective_prompt = await rewrite_prompt_if_needed(prompt, http_client)

            logger.info(
                "Generating image with OpenAI using prompt: %s...",
                effective_prompt[:50],
            )

            # Generate size string
            size = f"{config.default_width}x{config.default_height}"

            # Call OpenAI API with response_format to get base64 data
            response = await client.images.generate(
                model=config.openai_model,
                prompt=effective_prompt,
                n=1,
                size=size,
                quality="high",
                response_format="b64_json",
            )

            # Extract base64 data
            b64_data = response.data[0].b64_json

            # Store in Redis for persistence
            image_id = await store_image_in_redis(
                b64_data, "image/png", effective_prompt
            )
            logger.info("Stored OpenAI generated image with ID: %s", image_id)

            # Return markdown with a short URL reference instead of inline base64.
            # The frontend serves images via /api/generated-image/{id} from the
            # same Redis store.  This avoids sending megabytes of base64 through
            # the LLM / streaming pipeline.
            markdown_image = f"![Generated image](/api/generated-image/{image_id})"
            logger.info(
                "Returning markdown image reference: %s",
                markdown_image,
            )

            return str(markdown_image)

        except Exception as e:
            logger.error("Error generating image with OpenAI: %s", str(e))
            return f"Error generating image: {str(e)}"

    async def generate_image_nim(prompt: str) -> str:
        """
        Generate image using NIM (Stable Diffusion 3.5) API.

        Args:
            prompt: Text prompt for image generation

        Returns:
            Markdown-formatted image ready for display
        """
        # Create HTTP client inside the function to avoid closed client issues
        async with httpx.AsyncClient(
            base_url=config.api_endpoint, headers=headers, timeout=config.timeout
        ) as client:
            try:
                effective_prompt = await rewrite_prompt_if_needed(prompt, client)

                # Build the request directly
                request_data = ImageRequest(
                    prompt=effective_prompt,
                    width=config.default_width,
                    height=config.default_height,
                    steps=config.default_steps,
                    seed=0,
                    cfg_scale=3.5,
                    disable_safety_checker=True,
                )

                logger.info(
                    "Generating image with NIM using prompt: %s...",
                    effective_prompt[:50],
                )

                # Make the API request
                response = await client.post(
                    "/v1/infer", json=request_data.model_dump(exclude_none=True)
                )
                response.raise_for_status()

                # Parse the response
                response_data = ImageResponse.model_validate(response.json())
                artifact = response_data.artifacts[0]

                # Store in Redis for persistence
                image_id = await store_image_in_redis(
                    artifact.base64, "image/png", effective_prompt
                )
                logger.info("Stored NIM generated image with ID: %s", image_id)

                # Return markdown with a short URL reference
                markdown_image = f"![Generated image](/api/generated-image/{image_id})"
                logger.info(
                    "Returning markdown image reference: %s",
                    markdown_image,
                )

                return str(markdown_image)

            except httpx.HTTPStatusError as e:
                logger.error(
                    "HTTP error: %s - %s", e.response.status_code, e.response.text
                )
                return f"Error generating image: HTTP {e.response.status_code}"
            except Exception as e:
                logger.error("Error generating image: %s", str(e))
                return f"Error generating image: {str(e)}"

    async def generate_image_custom(prompt: str) -> str:
        """
        Generate image via direct HTTP POST to a custom endpoint.

        Works with the NVIDIA API Catalog (e.g., flux.2-klein-4b) and any
        endpoint that accepts a JSON payload with prompt, width, height,
        steps, and seed fields. Posts directly to config.api_endpoint with
        no path suffix.

        Args:
            prompt: Text prompt for image generation

        Returns:
            Markdown-formatted image ready for display
        """
        try:
            async with httpx.AsyncClient(timeout=config.timeout) as http_client:
                effective_prompt = await rewrite_prompt_if_needed(prompt, http_client)

            logger.info(
                "Generating image with custom endpoint using prompt: %s...",
                effective_prompt[:50],
            )

            payload: dict = {
                "prompt": effective_prompt,
                "width": config.default_width,
                "height": config.default_height,
                "steps": config.default_steps,
                "seed": 0,
            }

            api_key = config.api_key or os.getenv("NVIDIA_API_KEY")
            request_headers = {
                "Accept": "application/json",
            }
            if api_key:
                request_headers["Authorization"] = f"Bearer {api_key}"

            async with httpx.AsyncClient(timeout=config.timeout) as client:
                response = await client.post(
                    config.api_endpoint,
                    headers=request_headers,
                    json=payload,
                )
                response.raise_for_status()

            # Parse the response (same artifacts format as NIM)
            response_data = ImageResponse.model_validate(response.json())
            artifact = response_data.artifacts[0]

            image_id = await store_image_in_redis(
                artifact.base64, "image/png", effective_prompt
            )
            logger.info("Stored custom generated image with ID: %s", image_id)

            markdown_image = f"![Generated image](/api/generated-image/{image_id})"
            logger.info("Returning markdown image reference: %s", markdown_image)
            return str(markdown_image)

        except httpx.HTTPStatusError as e:
            logger.error("HTTP error: %s - %s", e.response.status_code, e.response.text)
            return f"Error generating image: HTTP {e.response.status_code}"
        except Exception as e:
            logger.error("Error generating image: %s", str(e))
            return f"Error generating image: {str(e)}"

    async def generate_image_openrouter(
        prompt: str,
        aspect_ratio: str | None = None,
    ) -> str:
        """
        Generate image using OpenRouter API.

        Args:
            prompt: Text prompt for image generation
            aspect_ratio: Aspect ratio for the generated image. Options:
                - "1:1" (1024x1024) - Square format
                - "2:3" (832x1248) - Portrait
                - "3:2" (1248x832) - Landscape
                - "3:4" (864x1184) - Portrait
                - "4:3" (1184x864) - Landscape (default)
                - "4:5" (896x1152) - Portrait
                - "5:4" (1152x896) - Landscape
                - "9:16" (768x1344) - Tall portrait (phone/story)
                - "16:9" (1344x768) - Widescreen landscape
                - "21:9" (1536x672) - Ultra-wide cinematic

        Returns:
            Markdown-formatted image ready for display
        """
        try:
            # Get API key
            api_key = config.api_key or os.getenv("OPENROUTER_API_KEY")
            if not api_key:
                return "Error: OpenRouter API key is required"

            # Validate and set aspect ratio
            effective_aspect_ratio = (
                aspect_ratio
                if aspect_ratio in ASPECT_RATIO_DIMENSIONS
                else DEFAULT_ASPECT_RATIO
            )
            if aspect_ratio and aspect_ratio not in ASPECT_RATIO_DIMENSIONS:
                logger.warning(
                    "Invalid aspect ratio '%s', using default '%s'",
                    aspect_ratio,
                    DEFAULT_ASPECT_RATIO,
                )

            # Rewrite prompt if needed
            async with httpx.AsyncClient(timeout=config.timeout) as http_client:
                effective_prompt = await rewrite_prompt_if_needed(prompt, http_client)

            logger.info(
                "Generating image with OpenRouter using prompt: %s... (aspect_ratio: %s)",
                effective_prompt[:50],
                effective_aspect_ratio,
            )

            # Prepare request
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
                        "content": effective_prompt,
                    }
                ],
                "modalities": ["image"],
                "provider": {
                    "data_collection": "deny",
                    "sort": "latency",
                },
                "image_config": {
                    "aspect_ratio": effective_aspect_ratio,
                },
            }

            # Make the API request
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                response = await client.post(url, headers=request_headers, json=payload)
                response.raise_for_status()
                result = response.json()

            # Extract image from response
            if result.get("choices"):
                message = result["choices"][0].get("message", {})
                if message.get("images"):
                    # Get the first image
                    image_data = message["images"][0]
                    image_url = image_data.get("image_url", {}).get("url", "")

                    if image_url:
                        image_id = None
                        # Extract base64 data from data URL for Redis storage
                        # Format: data:image/png;base64,<data>
                        if image_url.startswith("data:"):
                            parts = image_url.split(",", 1)
                            if len(parts) == 2:
                                mime_part = parts[0]  # data:image/png;base64
                                b64_data = parts[1]
                                # Extract mime type
                                mime_type = "image/png"
                                if ":" in mime_part and ";" in mime_part:
                                    mime_type = mime_part.split(":")[1].split(";")[0]
                                # Store in Redis for persistence
                                image_id = await store_image_in_redis(
                                    b64_data, mime_type, effective_prompt
                                )
                                logger.info(
                                    "Stored OpenRouter generated image with ID: %s",
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
                                        b64_data, ct, effective_prompt
                                    )
                                    logger.info(
                                        "Downloaded and stored OpenRouter image with ID: %s",
                                        image_id,
                                    )
                            except Exception as dl_exc:
                                logger.error("Failed to download image URL: %s", dl_exc)

                        if image_id:
                            # Return markdown with a short URL reference
                            markdown_image = (
                                f"![Generated image](/api/generated-image/{image_id})"
                            )
                            logger.info(
                                "Returning markdown image reference: %s",
                                markdown_image,
                            )
                            return str(markdown_image)

            return "Error: No image generated in response"

        except httpx.HTTPStatusError as e:
            logger.error("HTTP error: %s - %s", e.response.status_code, e.response.text)
            return f"Error generating image: HTTP {e.response.status_code}"
        except Exception as e:
            logger.error("Error generating image with OpenRouter: %s", str(e))
            return f"Error generating image: {str(e)}"

    async def generate_image_simple(
        prompt: str,
        aspect_ratio: str | None = None,
    ) -> str:
        """
        Simple image generation function for UI display.
        Routes to appropriate backend based on api_type configuration.

        Args:
            prompt: Text prompt for image generation
            aspect_ratio: Aspect ratio for the generated image (OpenRouter only).
                Options: "1:1", "2:3", "3:2", "3:4", "4:3" (default), "4:5", "5:4", "9:16", "16:9", "21:9"

        Returns:
            Markdown-formatted image ready for display
        """
        if config.api_type == "openai":
            return await generate_image_openai(prompt)
        if config.api_type == "openrouter":
            return await generate_image_openrouter(prompt, aspect_ratio)
        if config.api_type == "custom":
            return await generate_image_custom(prompt)
        return await generate_image_nim(prompt)

    try:
        # Register only the simple function
        logger.info("Registering function generate_image_simple")

        # Create description based on API type
        if config.api_type == "openai":
            description = (
                "Generate images using OpenAI's image generation API. Please provide a creative interpretation "
                "of the user's generation request so the image is as close as possible to the user's request "
                "but also achieves a high quality image."
            )
        elif config.api_type == "openrouter":
            description = (
                "Generate images using OpenRouter's image generation API. Please provide a creative interpretation "
                "of the user's generation request so the image is as close as possible to the user's request "
                "but also achieves a high quality image. "
                "Select an appropriate aspect_ratio based on the content: "
                "'1:1' for square/profile images, "
                "'4:3' (default) or '3:2' for standard landscape, "
                "'3:4' or '2:3' for portrait, "
                "'16:9' for widescreen/cinematic landscape, "
                "'9:16' for vertical/phone/story format, "
                "'21:9' for ultra-wide cinematic shots, "
                "'4:5' or '5:4' for social media formats."
            )
        elif config.api_type == "custom":
            description = (
                "Generate images via a custom API endpoint. Please provide a creative interpretation "
                "of the user's generation request so the image is as close as possible to the user's request "
                "but also achieves a high quality image."
            )
        else:
            description = (
                "Generate images using Stable Diffusion 3.5 Large model. Please provide a creative interpretation "
                "of the user's generation request so the image is as close as possible to the user's request "
                "but also achieves a high quality image."
            )

        function_info = FunctionInfo.from_fn(
            generate_image_simple,
            description=description,
        )
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up image_generation workflow.")
