import logging
import os
from typing import Optional, List, Literal, Dict, Any

import httpx
from pydantic import Field, BaseModel, field_validator

from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)


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
    cfg_scale: Optional[float] = Field(
        3.5,
        description=("How strictly the diffusion process adheres to the prompt"),
        ge=1.0,
        le=9.0,
    )
    disable_safety_checker: Optional[bool] = Field(
        False, description="Disable safety checks on the generated images"
    )
    height: Optional[int] = Field(
        1024,
        description="The height of the image to generate, in pixels",
        ge=768,
        le=1344,
    )
    width: Optional[int] = Field(
        1024,
        description="The width of the image to generate, in pixels",
        ge=768,
        le=1344,
    )
    image: Optional[str] = Field(
        None, description="Base64 encoded image for depth/canny mode"
    )
    mode: Optional[Literal["base"]] = Field(
        "base", description="The NIM inference mode"
    )
    preprocess_image: Optional[bool] = Field(
        True, description="Apply preprocessor to input image"
    )
    samples: Optional[int] = Field(
        1, description="Number of images to generate. Only 1 is supported", ge=1, le=1
    )
    seed: Optional[int] = Field(
        0, description="Seed for generation. 0 for random seed", ge=0, lt=4294967296
    )
    steps: Optional[int] = Field(
        50, description="Number of diffusion steps to run", ge=5, le=100
    )
    text_prompts: Optional[List[TextPrompt]] = Field(
        None, description="Deprecated: Array of text prompts"
    )

    @field_validator("height", "width")
    @classmethod
    def validate_dimensions(cls, v):
        """Validate that dimensions are in supported values."""
        supported = [768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344]
        if v not in supported:
            raise ValueError(f"Dimension must be one of: {supported}")
        return v


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

    artifacts: List[Artifact] = Field(..., min_length=1, max_length=1)


class ImageGenerationFunctionConfig(FunctionBaseConfig, name="image_generation"):
    """
    Configuration for Stable Diffusion 3.5 image generation function.
    """

    api_endpoint: str = Field(
        "http://localhost:8000", description="Base URL for the SD 3.5 API endpoint"
    )
    api_key: Optional[str] = Field(
        None, description="API key for authentication (if required)"
    )
    timeout: float = Field(120.0, description="Request timeout in seconds")
    default_width: int = Field(1024, description="Default image width in pixels")
    default_height: int = Field(1024, description="Default image height in pixels")
    default_steps: int = Field(50, description="Default number of diffusion steps")
    prompt_rewrite: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Optional prompt rewrite configuration. Set to a mapping with "
            "values: { 'llm': '<llm_name>', 'system_prompt': '<prompt>', "
            "'max_tokens': <int>, 'temperature': <float> }."
        ),
    )


class ImageGenerationInput(BaseModel):
    """Input model for the image generation function."""

    prompt: str = Field(..., description="The text prompt for image generation")
    width: Optional[int] = Field(
        None, description="Image width (768-1344, supported values only)"
    )
    height: Optional[int] = Field(
        None, description="Image height (768-1344, supported values only)"
    )
    steps: Optional[int] = Field(None, description="Number of diffusion steps (5-100)")
    seed: Optional[int] = Field(None, description="Random seed (0 for random)")
    cfg_scale: Optional[float] = Field(None, description="Guidance scale (1.0-9.0)")
    disable_safety_checker: Optional[bool] = Field(
        None, description="Disable safety checks"
    )


# Removed ImageGenerationOutput - now returning plain strings for UI display


@register_function(config_type=ImageGenerationFunctionConfig)
async def image_generation_function(
    config: ImageGenerationFunctionConfig, builder: Builder
):  # noqa: ARG001
    # Initialize HTTP client
    headers = {}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    elif os.getenv("NVIDIA_API_KEY"):
        headers["Authorization"] = f"Bearer {os.getenv('NVIDIA_API_KEY')}"
    else:
        raise ValueError("API key is required")

    async with httpx.AsyncClient(
        base_url=config.api_endpoint, headers=headers, timeout=config.timeout
    ) as client:

        async def rewrite_prompt_if_needed(original_prompt: str) -> str:
            if not config.prompt_rewrite:
                return original_prompt

            llm_name = config.prompt_rewrite.get("llm")
            if not llm_name:
                logger.warning("Prompt rewrite requested but no LLM provided")
                return original_prompt

            llm_kwargs: Dict[str, Any] = {}
            if "max_tokens" in config.prompt_rewrite:
                llm_kwargs["max_tokens"] = config.prompt_rewrite["max_tokens"]
            if "temperature" in config.prompt_rewrite:
                llm_kwargs["temperature"] = config.prompt_rewrite["temperature"]

            system_prompt = config.prompt_rewrite.get(
                "system_prompt",
                (
                    (
                        "You are an expert creative assistant. Improve the given prompt "
                        "for high quality image generation while keeping the user's intent intact."
                    )
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

            if isinstance(rewritten, dict):
                content = rewritten.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
            if isinstance(rewritten, str) and rewritten.strip():
                return rewritten.strip()

            logger.warning(
                "Prompt rewrite returned unexpected result type=%s; using original",
                type(rewritten),
            )
            return original_prompt

        # Using only simple string-based function for UI display

        async def generate_image_simple(prompt: str) -> str:
            """
            Simple image generation function for UI display.

            Args:
                prompt: Text prompt for image generation

            Returns:
                Markdown-formatted image ready for display
            """
            try:
                effective_prompt = await rewrite_prompt_if_needed(prompt)

                # Build the request directly
                request_data = ImageRequest(
                    prompt=effective_prompt,
                    width=config.default_width,
                    height=config.default_height,
                    steps=config.default_steps,
                    seed=0,
                    cfg_scale=3.5,
                    disable_safety_checker=False,
                )

                logger.info(
                    "Generating image with prompt: %s...", effective_prompt[:50]
                )

                # Make the API request
                response = await client.post(
                    "/v1/infer", json=request_data.model_dump(exclude_none=True)
                )
                response.raise_for_status()

                # Parse the response
                response_data = ImageResponse.model_validate(response.json())
                artifact = response_data.artifacts[0]

                # Return markdown directly
                markdown_image = (
                    f"![Generated image](data:image/png;base64," f"{artifact.base64})"
                )
                logger.info(
                    "Returning markdown image (first 100 chars): %s...",
                    markdown_image[:100],
                )
                logger.info("Return type: %s", type(markdown_image))
                logger.info("Is string: %s", isinstance(markdown_image, str))

                # Ensure we're returning a plain string
                return str(markdown_image)

            except httpx.HTTPStatusError as e:
                logger.error(
                    "HTTP error: %s - %s", e.response.status_code, e.response.text
                )
                return f"Error generating image: HTTP {e.response.status_code}"
            except Exception as e:
                logger.error("Error generating image: %s", str(e))
                return f"Error generating image: {str(e)}"

        try:
            # Register only the simple function
            logger.info("Registering function generate_image_simple")
            function_info = FunctionInfo.from_fn(
                generate_image_simple,
                description=(
                    "Generate images using Stable Diffusion 3.5 Large model. Please provide a creative interpretation of the user's generation request so the image is as close as possible to the user's request but also achieves a high quality image."
                ),
            )
            yield function_info
        except GeneratorExit:
            logger.warning("Function exited early!")
        finally:
            logger.info("Cleaning up image_generation workflow.")
