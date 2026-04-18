import logging
import os

import redis
from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.image_utils import store_image_in_redis
from nat_helpers.openai_images import generate_images
from openai import AsyncOpenAI
from pydantic import Field

logger = logging.getLogger(__name__)


class ImageGenerationFunctionConfig(FunctionBaseConfig, name="image_generation"):
    """Configuration for image generation via OpenAI's /v1/images/generations API."""

    api_endpoint: str | None = Field(
        None,
        description="Base URL for the OpenAI API. If unset, uses the SDK default.",
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
    quality: str | None = Field(
        default=None,
        description=(
            "Optional rendering quality ('low' or 'high'). Prefer 'low' for "
            "latency-sensitive flows and 'high' for detail-heavy scenes (dense "
            "text, intricate materials). Passed to images.generate as `quality`."
        ),
    )
    size: str | None = Field(
        default=None,
        description=(
            "Optional image size in pixels, e.g. '1024x1024', '1024x1536', "
            "'1536x1024', or 'auto'. Passed to images.generate as `size`."
        ),
    )
    n: int | None = Field(
        default=None,
        description=(
            "Optional number of variations to generate (1–10). When >1, each "
            "image is stored separately and all markdown refs are returned."
        ),
    )


@register_function(config_type=ImageGenerationFunctionConfig)
async def image_generation_function(
    config: ImageGenerationFunctionConfig, builder: Builder
):
    configured_key = (config.api_key or "").strip()
    if configured_key.startswith("${") and configured_key.endswith("}"):
        logger.warning(
            "image_generation api_key looks like an unexpanded placeholder (%s); "
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
                "You are an expert visual prompt engineer. Rewrite the user's "
                "request into a single, well-structured image-generation prompt "
                "while preserving their intent and required elements.\n"
                "\n"
                "Structure the prompt in this order:\n"
                "  1. Scene / background (setting, environment, mood)\n"
                "  2. Subject (main focal point, pose, action)\n"
                "  3. Key visual details (materials, textures, lighting, palette)\n"
                "  4. Constraints (what to include or exclude)\n"
                "\n"
                "Guidance:\n"
                "- For photorealism, use photography terms (lens, aperture, "
                "film stock, lighting) rather than generic 'high quality' words.\n"
                "- For non-photo output, name the medium (watercolor, 3D render, "
                "line art) and any relevant style cues.\n"
                "- Put any literal text the image must render in quotes or ALL "
                "CAPS, and specify font style, color, and placement.\n"
                "- State exclusions explicitly ('no watermark, no extra text').\n"
                "- Keep the prompt concise and well-formed; do not invent new "
                "subjects the user did not ask for.\n"
                "- Output only the rewritten prompt, with no preamble."
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
            Markdown-formatted image ready for display. When `n` > 1 the
            returned string contains one markdown ref per line.
        """
        try:
            effective_prompt = await rewrite_prompt_if_needed(prompt)

            results = await generate_images(
                client,
                model=config.model,
                prompt=effective_prompt,
                quality=config.quality,
                size=config.size,
                n=config.n,
            )

            refs = []
            for result in results:
                image_id = await store_image_in_redis(
                    redis_client,
                    result.b64_json,
                    result.mime_type,
                    effective_prompt,
                    source="image_generation",
                )
                refs.append(f"![Generated image](/api/generated-image/{image_id})")

            if not refs:
                return "Error: No image was returned by the model."

            return "\n".join(refs)

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
