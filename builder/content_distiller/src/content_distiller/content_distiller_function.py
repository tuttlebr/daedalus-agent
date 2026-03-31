"""Secondary LLM content processing for NeMo Agent Toolkit.

Registers three tools with NAT:

  distill_content     Summarize or focus long content using a secondary
                      LLM call. Reduces noise from web scrapes, RSS feeds,
                      retriever results, and other verbose sources.

  extract_structured  Extract structured key-value data from unstructured
                      text using a secondary LLM call with a user-defined
                      schema description.

  synthesize          Combine multiple content fragments into a coherent
                      synthesis, resolving contradictions and identifying
                      gaps.

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

    Supports per-task LLM routing: lightweight tasks (distill, extract)
    can use a fast/cheap model while synthesis uses a stronger one.
    """

    fast_llm_name: str = Field(
        default="distill_llm",
        description=(
            "LLM for lightweight tasks: distill_content and extract_structured. "
            "Should be a fast, cost-effective model (e.g. Haiku-class). "
            "Falls back to llm_name if the named LLM is not configured."
        ),
    )
    llm_name: str = Field(
        default="tool_calling_llm",
        description=(
            "LLM for complex tasks: synthesize (conflict resolution, gap analysis). "
            "Also used as fallback when fast_llm_name is unavailable."
        ),
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
    temperature: float = Field(
        default=0.1,
        ge=0.0,
        le=1.0,
        description="Temperature for secondary LLM calls. Low values for factual extraction.",
    )
    wrapper_type: str = Field(
        default="LANGCHAIN",
        description="LLM wrapper type: LANGCHAIN or OPENAI.",
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

    llm_kwargs = {
        "max_tokens": config.max_output_tokens,
        "temperature": config.temperature,
    }

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
            "You are a content distillation specialist. Your job is to extract "
            "the most important information from the provided content and present "
            "it clearly and concisely. Preserve specific facts, numbers, names, "
            "and dates. Do not add information not present in the source. "
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
    # Tool 2 -- extract_structured
    # ------------------------------------------------------------------
    async def extract_structured(
        content: str,
        schema_description: str,
        output_as_json: bool = True,
    ) -> str:
        """Extract structured data from unstructured text using a secondary LLM.

        Use this to pull specific fields, entities, or data points from
        raw content into a structured format. Useful for processing search
        results, articles, documents, or any text where you need specific
        pieces of information.

        Args:
            content: The raw content to extract from.
            schema_description: Natural-language description of what to
                extract. Be specific about the fields you want.
                Examples:
                - "Extract: company name, founding year, CEO, headquarters, products"
                - "Extract all dates mentioned with their associated events"
                - "Extract: pros (list), cons (list), overall_recommendation"
                - "For each person mentioned: name, role, key quote"
            output_as_json: If true (default), output as JSON. If false,
                output as a readable formatted list.

        Returns:
            Structured extraction results.
        """
        effective_content, truncated = _truncate_content(
            content, config.max_input_chars
        )

        format_instruction = (
            "Return the result as valid JSON. Use null for fields where "
            "information is not available in the source. Use arrays for "
            "repeated structures."
            if output_as_json
            else "Return the result as a clearly formatted readable list "
            "with field labels."
        )

        system_prompt = (
            "You are a precision data extraction specialist. Extract exactly "
            "the requested fields from the provided content. Only include "
            "information that is explicitly stated or directly inferable "
            "from the source. Use null or 'not found' for missing fields. "
            "Never fabricate data."
        )

        user_prompt = (
            f"Schema to extract: {schema_description}\n\n"
            f"{format_instruction}\n\n"
            f"Content to extract from:\n\n{effective_content}"
        )

        result = await _call_llm(
            builder,
            config,
            system_prompt,
            user_prompt,
            llm_name=config.fast_llm_name,
        )

        if truncated:
            result += "\n\n[Note: Source content was truncated before extraction.]"

        return result

    # ------------------------------------------------------------------
    # Tool 3 -- synthesize
    # ------------------------------------------------------------------
    async def synthesize(
        fragments: str,
        synthesis_goal: str,
        resolve_conflicts: bool = True,
    ) -> str:
        """Synthesize multiple content fragments into a coherent whole.

        Use this after gathering information from multiple tools (search
        results, multiple RSS feeds, retriever chunks, web scrapes) to
        combine them into a unified analysis. Identifies agreements,
        contradictions, and gaps across sources.

        Args:
            fragments: The content fragments to synthesize. Separate
                distinct sources with "---" on its own line, or use
                labeled sections like "SOURCE 1:", "SOURCE 2:", etc.
            synthesis_goal: What the synthesis should achieve. Examples:
                - "Compare these perspectives on AI regulation"
                - "Build a timeline of events from these sources"
                - "Identify consensus and disagreements about the product launch"
                - "Create a unified summary of NVIDIA's Q4 earnings from these reports"
            resolve_conflicts: If true (default), explicitly identify and
                attempt to resolve contradictions between sources. If false,
                present all perspectives without judgment.

        Returns:
            Synthesized content combining all fragments.
        """
        effective_content, truncated = _truncate_content(
            fragments, config.max_input_chars
        )

        conflict_instruction = (
            "When sources contradict each other, explicitly note the "
            "contradiction and assess which source is more likely correct "
            "based on specificity, recency, and authority. Flag unresolvable "
            "conflicts clearly."
            if resolve_conflicts
            else "Present all perspectives without attempting to resolve "
            "contradictions. Let the reader decide."
        )

        system_prompt = (
            "You are a research synthesis specialist. Your job is to combine "
            "information from multiple sources into a coherent, well-structured "
            "analysis. Preserve attribution when sources disagree. Identify "
            "gaps where important questions remain unanswered. "
            "Do not use em dashes. Write naturally and concisely."
        )

        user_prompt = (
            f"Synthesis goal: {synthesis_goal}\n\n"
            f"{conflict_instruction}\n\n"
            f"Sources to synthesize:\n\n{effective_content}"
        )

        result = await _call_llm(builder, config, system_prompt, user_prompt)

        if truncated:
            result += "\n\n[Note: Source content was truncated before synthesis.]"

        return result

    # ------------------------------------------------------------------
    # Register all three tools with NAT
    # ------------------------------------------------------------------
    try:
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

        yield FunctionInfo.from_fn(
            extract_structured,
            description=(
                "Extract structured data from unstructured text using a secondary "
                "LLM. Pull specific fields, entities, or data points from raw "
                "content into JSON or formatted output. Describe the schema you "
                "want in natural language."
            ),
        )

        yield FunctionInfo.from_fn(
            synthesize,
            description=(
                "Synthesize multiple content fragments from different sources "
                "into a coherent analysis. Use after gathering information from "
                "multiple tools (search, RSS, retrievers, web scrapes) to combine "
                "them into a unified result. Identifies agreements, contradictions, "
                "and information gaps across sources."
            ),
        )

    except GeneratorExit:
        logger.warning("content_distiller function exited early!")
    finally:
        logger.info("Cleaning up content_distiller function.")
