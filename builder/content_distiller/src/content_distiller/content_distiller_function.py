"""Secondary LLM content processing for NeMo Agent Toolkit.

Registers one tool with NAT:

  distill_content     Summarize or focus long content using a secondary
                      LLM call. Reduces noise from web scrapes, RSS feeds,
                      retriever results, and other verbose sources.

Inspired by Claude Code's WebFetch two-stage fetch+summarize pattern
and the general principle that a dedicated processing step between raw
content retrieval and final response significantly improves output quality.
"""

import logging

from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)


class ContentDistillerConfig(FunctionBaseConfig, name="content_distiller"):
    """Configuration for the content_distiller function.

    Uses a fast/cheap model for distillation with a configurable fallback.
    """

    fast_llm_name: str = Field(
        default="distill_llm",
        description=(
            "LLM for distill_content. "
            "Should be a fast, cost-effective model (e.g. Haiku-class). "
            "Falls back to llm_name if the named LLM is not configured."
        ),
    )
    llm_name: str = Field(
        default="tool_calling_llm",
        description=("Fallback LLM used when fast_llm_name is unavailable."),
    )
    max_input_chars: int = Field(
        default=100000,
        ge=1000,
        le=500000,
        description="Maximum input content length in characters before truncation.",
    )
    max_output_tokens: int = Field(
        default=4096,
        ge=256,
        le=16384,
        description="Maximum tokens for the secondary LLM response.",
    )
    wrapper_type: str = Field(
        default="LANGCHAIN",
        description="LLM wrapper type: LANGCHAIN or OPENAI.",
    )
    enabled_operations: list[str] | None = Field(
        default=None,
        description=(
            "Optional allow-list of operations to register. The supported value "
            "is distill_content. When omitted, distill_content is registered."
        ),
    )


async def _call_llm(
    builder: Builder,
    config: ContentDistillerConfig,
    system_prompt: str,
    user_prompt: str,
    llm_name: str | None = None,
) -> str:
    """Make a secondary LLM call using the specified or configured LLM.

    Args:
        llm_name: Override which LLM to use. Falls back to config.llm_name
            if the requested LLM is not available.
    """
    use_langchain = config.wrapper_type.upper() == "LANGCHAIN"

    try:
        wrapper = LLMFrameworkEnum(config.wrapper_type)
    except (ValueError, TypeError):
        wrapper = LLMFrameworkEnum.LANGCHAIN

    llm_kwargs = {}

    target_llm = llm_name or config.llm_name
    try:
        try:
            llm_callable = await builder.get_llm(target_llm, wrapper_type=wrapper)
        except Exception:
            if target_llm != config.llm_name:
                logger.info(
                    "LLM '%s' unavailable, falling back to '%s'",
                    target_llm,
                    config.llm_name,
                )
                llm_callable = await builder.get_llm(
                    config.llm_name, wrapper_type=wrapper
                )
            else:
                raise

        if use_langchain:
            from langchain_core.messages import HumanMessage, SystemMessage

            langchain_llm = llm_callable.bind(**llm_kwargs)
            messages = [
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt),
            ]
            result = await langchain_llm.ainvoke(messages)
        else:
            result = await llm_callable.invoke(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                **llm_kwargs,
            )

        # Extract content from various response types
        if hasattr(result, "content"):
            content = result.content
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
        if isinstance(result, dict):
            content = result.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
        if isinstance(result, str) and result.strip():
            return result.strip()

        logger.warning("LLM returned unexpected type=%s", type(result))
        return str(result)

    except Exception as exc:
        logger.error("Secondary LLM call failed: %s", exc)
        return f"Error: Secondary LLM call failed: {exc}"


def _truncate_content(content: str, max_chars: int) -> tuple[str, bool]:
    """Truncate content if it exceeds max_chars. Returns (content, was_truncated)."""
    if len(content) <= max_chars:
        return content, False
    return content[:max_chars] + "\n\n[Content truncated]", True


@register_function(config_type=ContentDistillerConfig)
async def content_distiller_function(config: ContentDistillerConfig, builder: Builder):
    enabled = set(config.enabled_operations or [])

    def _enabled(operation: str) -> bool:
        return not enabled or operation in enabled

    # ------------------------------------------------------------------
    # Tool 1 -- distill_content
    # ------------------------------------------------------------------
    async def distill_content(
        content: str,
        focus: str = "",
        max_words: int = 500,
        output_format: str = "prose",
    ) -> str:
        """Distill long content into a focused summary using a secondary LLM.

        Use this to process verbose tool outputs before incorporating them
        into your response: web scrape results, RSS articles, retriever
        chunks, meeting transcripts, or any long text that needs to be
        condensed for the user.

        Args:
            content: The raw content to distill. Can be long -- it will be
                truncated if needed.
            focus: What to focus on in the summary. If empty, produces a
                general summary. Examples: "key technical decisions",
                "action items and deadlines", "arguments for and against",
                "facts relevant to semiconductor supply chain".
            max_words: Target maximum word count for the output (default 500).
            output_format: Output structure. Options:
                - "prose" (default): Flowing paragraphs
                - "bullets": Bullet-point list
                - "tldr": Ultra-brief 2-3 sentence summary

        Returns:
            The distilled content.
        """
        effective_content, truncated = _truncate_content(
            content, config.max_input_chars
        )

        focus_instruction = (
            f"Focus specifically on: {focus}"
            if focus
            else "Produce a general summary covering the most important points."
        )

        format_instructions = {
            "prose": "Write flowing prose paragraphs.",
            "bullets": "Use a concise bullet-point list. Each bullet should be a complete thought.",
            "tldr": "Write an ultra-brief summary in 2-3 sentences maximum.",
        }
        format_instruction = format_instructions.get(
            output_format, format_instructions["prose"]
        )

        system_prompt = (
            "Role: content distillation specialist. Goal: extract the most "
            "important source-backed information and present it clearly. "
            "Preserve specific facts, numbers, names, and dates. Do not add "
            "information not present in the source. Output should follow the "
            "requested format and stop when the target length is satisfied. "
            "Do not use em dashes. Keep language natural and direct."
        )

        user_prompt = (
            f"{focus_instruction}\n\n"
            f"{format_instruction}\n\n"
            f"Target length: approximately {max_words} words.\n\n"
            f"Content to distill:\n\n{effective_content}"
        )

        result = await _call_llm(
            builder,
            config,
            system_prompt,
            user_prompt,
            llm_name=config.fast_llm_name,
        )

        if truncated:
            result += "\n\n[Note: Source content was truncated before processing.]"

        return result

    # ------------------------------------------------------------------
    # Register the distillation tool with NAT
    # ------------------------------------------------------------------
    try:
        if _enabled("distill_content"):
            yield FunctionInfo.from_fn(
                distill_content,
                description=(
                    "Distill long content into a focused summary using a secondary "
                    "LLM. Use to process verbose tool outputs before incorporating "
                    "them into your response: web scrapes, RSS articles, retriever "
                    "chunks, transcripts, or any long text. Supports prose, bullet, "
                    "and tldr output formats with optional topic focus."
                ),
            )

    except GeneratorExit:
        logger.warning("content_distiller function exited early!")
    finally:
        logger.info("Cleaning up content_distiller function.")
