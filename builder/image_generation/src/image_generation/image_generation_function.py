import logging
import os

import redis
from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.image_utils import extract_images_from_response, store_image_in_redis
from openai import AsyncOpenAI
from pydantic import Field

logger = logging.getLogger(__name__)


class ImageGenerationFunctionConfig(FunctionBaseConfig, name="image_generation"):
    """Configuration for image generation via OpenAI-compatible chat completions."""

    api_endpoint: str | None = Field(
        None,
        description="Base URL for OpenAI-compatible endpoint. If unset, uses OpenAI default.",
    )
    api_key: str | None = Field(
        None,
        description="API key for authentication. Falls back to OPENAI_API_KEY env var.",
    )
    timeout: float = Field(120.0, description="Request timeout in seconds")
    model: str = Field("gpt-image-1", description="Model to use for image generation")
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
    image_config: dict | None = Field(
        default=None,
        description=(
            "Optional image configuration passed to the API. "
            "Supports keys like 'aspect_ratio' (e.g. '16:9') and "
            "'image_size' (e.g. '1K', '2K', '4K')."
        ),
    )


@register_function(config_type=ImageGenerationFunctionConfig)
async def image_generation_function(
    config: ImageGenerationFunctionConfig, builder: Builder
):
    api_key = config.api_key or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError(
            "API key is required (set api_key in config or OPENAI_API_KEY env var)"
        )

    redis_client = redis.from_url(config.redis_url, decode_responses=False)

    client_kwargs = {"api_key": api_key, "timeout": config.timeout}
    if config.api_endpoint:
        client_kwargs["base_url"] = config.api_endpoint
    client = AsyncOpenAI(**client_kwargs)

    async def rewrite_prompt_if_needed(original_prompt: str) -> str:
        """Optionally rewrite the prompt using a configured LLM."""
        if not config.prompt_rewrite:
            return original_prompt

        llm_name = config.prompt_rewrite.get("llm")
        if not llm_name:
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
                llm_wrapper = LLMFrameworkEnum.LANGCHAIN

        try:
            llm_callable = await builder.get_llm(llm_name, wrapper_type=llm_wrapper)
            user_content = (
                "Rewrite the following prompt into a succint text-to-image generation prompt. "
                "Remaining true to the user's request and intent but with greater detail and creativity.\n\n"
                f"Original prompt: {original_prompt}"
            )

            if llm_wrapper == LLMFrameworkEnum.LANGCHAIN:
                from langchain_core.messages import HumanMessage, SystemMessage

                langchain_llm = (
                    llm_callable.bind(**llm_kwargs) if llm_kwargs else llm_callable
                )
                messages_sequence = []
                if system_prompt:
                    messages_sequence.append(SystemMessage(content=system_prompt))
                messages_sequence.append(HumanMessage(content=user_content))
                rewritten = await langchain_llm.ainvoke(messages_sequence)
            else:
                rewritten = await llm_callable.invoke(
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_content},
                    ],
                    **llm_kwargs,
                )
        except Exception:
            logger.error(
                "Prompt rewrite failed using LLM '%s'", llm_name, exc_info=True
            )
            return original_prompt

        # Extract text from various response types
        if hasattr(rewritten, "content"):
            content = rewritten.content
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list) and content:
                for block in content:
                    if isinstance(block, str) and block.strip():
                        return block.strip()
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text", "")
                        if isinstance(text, str) and text.strip():
                            return text.strip()
        if isinstance(rewritten, dict):
            content = rewritten.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
        if isinstance(rewritten, str) and rewritten.strip():
            return rewritten.strip()

        return original_prompt

    async def generate_image(prompt: str) -> str:
        """
        Generate an image from a text prompt.

        Args:
            prompt: Text prompt for image generation

        Returns:
            Markdown-formatted image ready for display
        """
        try:
            effective_prompt = await rewrite_prompt_if_needed(prompt)

            extra_body: dict = {"modalities": ["image", "text"]}
            if config.image_config:
                extra_body["image_config"] = config.image_config

            logger.info("Generating image with prompt: %s...", effective_prompt[:80])

            response = await client.chat.completions.create(
                model=config.model,
                messages=[{"role": "user", "content": effective_prompt}],
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
                effective_prompt,
                source="image_generation",
            )

            return f"![Generated image](/api/generated-image/{image_id})"

        except Exception as e:
            logger.error("Error generating image: %s", str(e))
            return f"Error generating image: {str(e)}"

    try:
        logger.info("Registering function generate_image")

        description = (
            "Generate a brand-new image from a text prompt using OpenAI's image generation API. "
            "Creates an original image from scratch — no source image needed. Provide a creative, "
            "detailed interpretation of the user's request to produce a high-quality result."
        )

        function_info = FunctionInfo.from_fn(generate_image, description=description)
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up image_generation workflow.")
