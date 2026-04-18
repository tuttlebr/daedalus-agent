"""Source citation verification for NeMo Agent Toolkit.

Registers three tools with NAT:

  verify_claim      Fetch a source URL and assess whether it actually
                    supports a specific claim.  Returns a structured
                    verdict (supported / partially_supported / unsupported /
                    source_unreachable) with evidence excerpts.

  verify_memory     Verify an existing memory entry's citations and logic.
                    Routes by memory type: findings get source-checked,
                    syntheses get logic-checked, reports are skipped.

  audit_memories    Batch-verify a set of memories (output of get_memory).
                    Returns a structured audit report with per-memory
                    verdicts and an aggregate summary.

Designed to combat hallucination compounding in autonomous agent cycles
where uncited or incorrectly cited claims accumulate in memory over time.

Reuses webscrape's URL fetching (markitdown + httpx) for lightweight
source retrieval without consuming a tool call, and follows the
content_distiller LLM call pattern for verification assessment.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass

import httpx
from nat.builder.builder import Builder, LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field
from webscrape.webscrape_function import (
    _is_valid_content,
    _scrape_with_httpx,
    _scrape_with_markitdown,
    _validate_url,
)

logger = logging.getLogger(__name__)

# Regex to extract markdown links: [text](url)
_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]*)\]\((https?://[^)]+)\)")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class FetchResult:
    """Result of fetching a source URL."""

    status: str  # ok, unreachable, forbidden, challenge_page, invalid_url, empty
    content: str | None = None
    status_code: int | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class SourceVerifierConfig(FunctionBaseConfig, name="source_verifier"):
    """Configuration for the source_verifier function."""

    fast_llm_name: str = Field(
        default="distill_llm",
        description=(
            "LLM for lightweight verification (single claim checks). "
            "Should be a fast, cost-effective model (e.g. Haiku-class). "
            "Falls back to llm_name if unavailable."
        ),
    )
    llm_name: str = Field(
        default="tool_calling_llm",
        description=(
            "LLM for complex verification (synthesis analysis). "
            "Also used as fallback when fast_llm_name is unavailable."
        ),
    )
    max_source_chars: int = Field(
        default=80000,
        ge=1000,
        le=500000,
        description="Maximum source content length in characters before truncation.",
    )
    max_output_tokens: int = Field(
        default=4096,
        ge=256,
        le=16384,
        description="Maximum tokens for the verification LLM response.",
    )
    temperature: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Temperature for verification LLM calls. 0.0 for maximum factual precision.",
    )
    wrapper_type: str = Field(
        default="LANGCHAIN",
        description="LLM wrapper type: LANGCHAIN or OPENAI.",
    )
    fetch_timeout: float = Field(
        default=30.0,
        ge=5.0,
        le=120.0,
        description="Timeout in seconds for URL fetching.",
    )
    max_fetch_tokens: int = Field(
        default=20000,
        ge=1000,
        le=64000,
        description="Maximum tokens of fetched source content to pass to the verification LLM.",
    )


# ---------------------------------------------------------------------------
# LLM helper (local copy from content_distiller pattern)
# ---------------------------------------------------------------------------
async def _call_llm(
    builder: Builder,
    config: SourceVerifierConfig,
    system_prompt: str,
    user_prompt: str,
    llm_name: str | None = None,
) -> str:
    """Make a secondary LLM call for verification assessment."""
    try:
        wrapper = LLMFrameworkEnum(config.wrapper_type)
    except (ValueError, TypeError):
        wrapper = LLMFrameworkEnum.LANGCHAIN

    use_langchain = wrapper == LLMFrameworkEnum.LANGCHAIN

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
        logger.error("Verification LLM call failed: %s", exc)
        return f"Error: Verification LLM call failed: {exc}"


# ---------------------------------------------------------------------------
# URL fetching helper
# ---------------------------------------------------------------------------
async def _fetch_source(url: str, config: SourceVerifierConfig) -> FetchResult:
    """Fetch a URL using webscrape strategies (markitdown -> httpx).

    Skips the Playwright browser fallback to stay lightweight.
    Returns a FetchResult with status and content.
    """
    # Validate URL
    try:
        normalized_url, _ = _validate_url(url, ["http", "https"])
    except ValueError as exc:
        return FetchResult(status="invalid_url", error=str(exc))

    truncation_msg = "\n\n[Source content truncated for verification]"

    # Strategy 1: MarkItDown (fastest, no JS)
    try:
        content = await asyncio.to_thread(
            _scrape_with_markitdown,
            normalized_url,
            max_tokens=config.max_fetch_tokens,
            truncation_msg=truncation_msg,
        )
        if _is_valid_content(content):
            return FetchResult(status="ok", content=content)
    except Exception as exc:
        logger.debug("markitdown failed for %s: %s", normalized_url, exc)

    # Strategy 2: httpx with browser-like headers
    try:
        content = await asyncio.wait_for(
            _scrape_with_httpx(
                normalized_url,
                max_tokens=config.max_fetch_tokens,
                truncation_msg=truncation_msg,
            ),
            timeout=config.fetch_timeout,
        )
        if content and _is_valid_content(content):
            return FetchResult(status="ok", content=content)
        if content is None:
            return FetchResult(status="unreachable", error="httpx returned no content")
        return FetchResult(
            status="challenge_page", error="Content appears to be a challenge page"
        )
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        if code == 403:
            return FetchResult(
                status="forbidden", status_code=403, error="HTTP 403 Forbidden"
            )
        if code == 404:
            return FetchResult(
                status="unreachable", status_code=404, error="HTTP 404 Not Found"
            )
        return FetchResult(status="unreachable", status_code=code, error=f"HTTP {code}")
    except TimeoutError:
        return FetchResult(
            status="unreachable", error=f"Fetch timed out after {config.fetch_timeout}s"
        )
    except Exception as exc:
        return FetchResult(status="unreachable", error=str(exc))


def _extract_markdown_links(text: str) -> list[dict]:
    """Extract all markdown links from text."""
    return [
        {"text": m.group(1), "url": m.group(2)}
        for m in _MARKDOWN_LINK_RE.finditer(text)
    ]


async def _check_link_reachable(url: str, timeout: float = 10.0) -> bool:
    """Check if a URL is reachable via HEAD request."""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            resp = await client.head(url)
            return resp.is_success
    except Exception:
        return False


def _parse_llm_json(raw: str) -> dict:
    """Extract and parse JSON from an LLM response that may include markdown fences."""
    text = raw.strip()
    if text.startswith("```"):
        # Strip markdown code fences
        lines = text.split("\n")
        lines = lines[1:]  # drop opening fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


# ---------------------------------------------------------------------------
# LLM prompts
# ---------------------------------------------------------------------------
_VERIFY_CLAIM_SYSTEM = """\
You are a source verification specialist. Your job is to determine whether a
given claim is supported by the provided source content.

Rules:
- Only mark a claim as "supported" if the source EXPLICITLY states or DIRECTLY
  implies the claim with specific evidence.
- Absence of contradiction is NOT support. The source must actively confirm.
- "partially_supported" means the source confirms some aspects but not others,
  or the source's numbers/details differ slightly from the claim.
- "unsupported" means the source does not contain evidence for the claim, or
  actively contradicts it.
- "insufficient_context" means the source content is too short, generic, or
  off-topic to make a determination.

Return your assessment as JSON (no markdown fences) with exactly these fields:
{
  "verdict": "supported" | "partially_supported" | "unsupported" | "insufficient_context",
  "confidence": <float 0.0-1.0>,
  "evidence": "<direct quote or close paraphrase from source, max 200 words, or null if none>",
  "reasoning": "<1-2 sentences explaining your assessment>",
  "claim_issues": ["<specific factual error or unsupported assertion>", ...]
}"""

_VERIFY_SYNTHESIS_SYSTEM = """\
You are a synthesis verification specialist. You are given a synthesis memory
that claims to connect findings across multiple domains or sources.

Assess whether:
1. The stated connections follow logically from the constituent claims.
2. The conclusions are warranted (not overgeneralized).
3. There are any logical leaps, unsupported generalizations, or spurious
   connections.

Return your assessment as JSON (no markdown fences) with exactly these fields:
{
  "verdict": "sound" | "partially_sound" | "unsound",
  "confidence": <float 0.0-1.0>,
  "reasoning": "<2-3 sentences explaining your assessment>",
  "logic_issues": ["<specific logical problem>", ...]
}"""


# ---------------------------------------------------------------------------
# Registered function
# ---------------------------------------------------------------------------
@register_function(config_type=SourceVerifierConfig)
async def source_verifier_function(config: SourceVerifierConfig, builder: Builder):
    # ------------------------------------------------------------------
    # Tool 1 -- verify_claim
    # ------------------------------------------------------------------
    async def verify_claim(
        claim: str,
        source_url: str,
        context: str = "",
    ) -> str:
        """Verify whether a source URL actually supports a specific claim.

        Fetches the URL, analyzes the content with an LLM, and returns a
        structured verdict. Call this BEFORE storing any finding in memory
        to prevent citation hallucination.

        Args:
            claim: The factual claim to verify. Should be a clear,
                specific statement (e.g., the BLUF from a finding).
            source_url: The URL that allegedly supports the claim.
            context: Optional context about how the claim will be used
                (e.g., "storing as a finding about GPU performance").

        Returns:
            JSON verdict with: verdict (supported/partially_supported/
            unsupported/source_unreachable), confidence score, evidence
            excerpt, reasoning, and any claim issues found.
        """
        if not claim or not claim.strip():
            return json.dumps(
                {
                    "verdict": "error",
                    "source_url": source_url,
                    "reasoning": "No claim provided to verify.",
                }
            )

        if not source_url or not source_url.strip():
            return json.dumps(
                {
                    "verdict": "source_unreachable",
                    "confidence": 0.0,
                    "source_url": "",
                    "source_reachable": False,
                    "fetch_status": "missing",
                    "evidence": None,
                    "reasoning": "No source URL provided. Cannot verify without a source.",
                    "claim_issues": ["No source_url supplied"],
                }
            )

        # Fetch the source
        fetch = await _fetch_source(source_url.strip(), config)

        if fetch.status != "ok":
            return json.dumps(
                {
                    "verdict": "source_unreachable",
                    "confidence": 0.0,
                    "source_url": source_url,
                    "source_reachable": False,
                    "fetch_status": fetch.status,
                    "evidence": None,
                    "reasoning": f"Could not fetch source: {fetch.error or fetch.status}.",
                    "claim_issues": [
                        f"source_url {fetch.status}: {fetch.error or 'no content'}"
                    ],
                }
            )

        # Truncate source content if needed
        content = fetch.content or ""
        if len(content) > config.max_source_chars:
            content = content[: config.max_source_chars] + "\n\n[Content truncated]"

        # Build verification prompt
        context_line = f"\nCONTEXT: {context}" if context else ""
        user_prompt = (
            f"CLAIM: {claim}\n"
            f"{context_line}\n"
            f"SOURCE URL: {source_url}\n\n"
            f"SOURCE CONTENT:\n{content}\n\n"
            f"Assess whether this source supports the claim. Be conservative."
        )

        raw = await _call_llm(
            builder,
            config,
            _VERIFY_CLAIM_SYSTEM,
            user_prompt,
            llm_name=config.fast_llm_name,
        )

        # Parse and enrich the LLM response
        parsed = _parse_llm_json(raw)
        if not parsed:
            # LLM didn't return valid JSON; wrap the raw response
            return json.dumps(
                {
                    "verdict": "error",
                    "source_url": source_url,
                    "source_reachable": True,
                    "reasoning": f"Verification LLM returned unparseable response: {raw[:500]}",
                    "claim_issues": ["verification_parse_error"],
                }
            )

        # Enrich with source metadata
        parsed["source_url"] = source_url
        parsed["source_reachable"] = True
        return json.dumps(parsed, indent=2)

    # ------------------------------------------------------------------
    # Tool 2 -- verify_memory
    # ------------------------------------------------------------------
    async def verify_memory(
        memory_text: str,
        metadata_json: str = "",
    ) -> str:
        """Verify an existing memory entry's citations and claims.

        Routes verification by memory type:
        - finding/project_update: verifies source_url supports the BLUF claim
        - synthesis: assesses whether stated connections are logically sound
        - cycle_report/dream: skipped (meta-observations, not factual claims)

        Also checks reachability of all inline markdown links.

        Args:
            memory_text: The full memory text (BLUF + context + source link).
            metadata_json: JSON string of the memory's metadata
                (key_value_pairs). Should include 'type' and 'source_url'.

        Returns:
            JSON verification report with status, issues, inline link
            checks, and a recommendation (retain/flag_for_review/remove).
        """
        # Parse metadata
        try:
            metadata = json.loads(metadata_json) if metadata_json else {}
        except (json.JSONDecodeError, TypeError):
            metadata = {}

        mem_type = metadata.get("type", "unknown")
        source_url = metadata.get("source_url", "")

        # Extract inline links from memory text
        inline_links = _extract_markdown_links(memory_text)

        # Skip non-factual memory types
        if mem_type in ("cycle_report", "dream"):
            return json.dumps(
                {
                    "memory_type": mem_type,
                    "verification_status": "skipped",
                    "source_url_status": "n/a",
                    "claim_verdict": None,
                    "inline_links": [],
                    "issues": [],
                    "recommendation": "retain",
                }
            )

        issues: list[str] = []

        # Check inline link reachability (concurrent)
        link_results = []
        if inline_links:
            reachable_checks = await asyncio.gather(
                *[_check_link_reachable(link["url"]) for link in inline_links],
                return_exceptions=True,
            )
            for link, reachable in zip(inline_links, reachable_checks):
                is_ok = reachable is True
                link_results.append({"url": link["url"], "reachable": is_ok})
                if not is_ok:
                    issues.append(f"Inline link unreachable: {link['url']}")

        # Handle synthesis type separately
        if mem_type == "synthesis":
            synthesis_prompt = (
                f"SYNTHESIS MEMORY:\n{memory_text}\n\n"
                f"METADATA: {json.dumps(metadata)}\n\n"
                f"Assess the logical soundness of this synthesis."
            )
            raw = await _call_llm(
                builder,
                config,
                _VERIFY_SYNTHESIS_SYSTEM,
                synthesis_prompt,
                llm_name=config.llm_name,
            )
            parsed = _parse_llm_json(raw)
            verdict_map = {
                "sound": "verified",
                "partially_sound": "partially_verified",
                "unsound": "failed",
            }
            synth_verdict = parsed.get("verdict", "")
            status = verdict_map.get(synth_verdict, "failed")
            if parsed.get("logic_issues"):
                issues.extend(parsed["logic_issues"])

            recommendation = "retain"
            if status == "failed":
                recommendation = "flag_for_review"
            elif issues:
                recommendation = "flag_for_review"

            return json.dumps(
                {
                    "memory_type": mem_type,
                    "verification_status": status,
                    "source_url_status": "n/a",
                    "claim_verdict": parsed,
                    "inline_links": link_results,
                    "issues": issues,
                    "recommendation": recommendation,
                },
                indent=2,
            )

        # For findings and project_updates: verify source_url
        if not source_url:
            # Try to extract URL from inline links as fallback
            if inline_links:
                source_url = inline_links[0]["url"]
            else:
                issues.append("No source_url in metadata and no inline links found")
                return json.dumps(
                    {
                        "memory_type": mem_type,
                        "verification_status": "failed",
                        "source_url_status": "missing",
                        "claim_verdict": None,
                        "inline_links": link_results,
                        "issues": issues,
                        "recommendation": "flag_for_review",
                    },
                    indent=2,
                )

        # Extract the BLUF claim (first sentence or up to first period)
        claim = memory_text.strip()
        if claim.startswith("BLUF:"):
            claim = claim[5:].strip()
        # Use up to the first two sentences as the claim
        sentences = claim.split(". ")
        if len(sentences) > 2:
            claim = ". ".join(sentences[:2]) + "."

        # Call verify_claim internally
        claim_result_raw = await verify_claim(
            claim=claim,
            source_url=source_url,
            context=f"Verifying a stored {mem_type} memory",
        )
        claim_result = json.loads(claim_result_raw)

        # Determine overall status
        verdict = claim_result.get("verdict", "")
        if verdict == "supported":
            status = "verified"
        elif verdict == "partially_supported":
            status = "partially_verified"
        elif verdict == "source_unreachable":
            status = "partially_verified"
            issues.append("Source URL is currently unreachable")
        else:
            status = "failed"

        if claim_result.get("claim_issues"):
            issues.extend(claim_result["claim_issues"])

        source_url_status = "reachable"
        if not claim_result.get("source_reachable", True):
            source_url_status = "unreachable"

        recommendation = "retain"
        if status == "failed":
            recommendation = "remove"
        elif status == "partially_verified" or issues:
            recommendation = "flag_for_review"

        return json.dumps(
            {
                "memory_type": mem_type,
                "verification_status": status,
                "source_url_status": source_url_status,
                "claim_verdict": claim_result,
                "inline_links": link_results,
                "issues": issues,
                "recommendation": recommendation,
            },
            indent=2,
        )

    # ------------------------------------------------------------------
    # Tool 3 -- audit_memories
    # ------------------------------------------------------------------
    async def audit_memories(
        memories_json: str,
        verify_sources: bool = True,
    ) -> str:
        """Batch-verify a set of memories for citation quality.

        Pass the output of get_memory as memories_json. Each memory should
        have 'text' and optionally 'metadata' fields. Checks each memory's
        sources and claims, returns a structured audit report.

        Usage: call get_memory(query=..., top_k=N) first, then pass the
        results here for verification.

        Args:
            memories_json: JSON string containing an array of memory objects.
                Each object should have at minimum a 'text' field and ideally
                a 'metadata' field with 'type' and 'source_url'. The format
                from get_memory is accepted directly.
            verify_sources: If true (default), fetch and verify source URLs.
                If false, only check link reachability and metadata
                completeness (faster but less thorough).

        Returns:
            JSON audit report with per-memory verdicts, aggregate counts,
            and a human-readable summary with recommendations.
        """
        try:
            memories = json.loads(memories_json) if memories_json else []
        except (json.JSONDecodeError, TypeError):
            return json.dumps(
                {
                    "error": "Invalid memories_json: could not parse as JSON array.",
                    "total_memories": 0,
                }
            )

        if not isinstance(memories, list):
            # Try to handle a single memory object
            if isinstance(memories, dict):
                memories = [memories]
            else:
                return json.dumps(
                    {
                        "error": "memories_json must be a JSON array of memory objects.",
                        "total_memories": 0,
                    }
                )

        if not memories:
            return json.dumps(
                {
                    "total_memories": 0,
                    "verified": 0,
                    "failed": 0,
                    "skipped": 0,
                    "unreachable": 0,
                    "results": [],
                    "summary": "No memories to audit.",
                }
            )

        results = []
        counts = {
            "verified": 0,
            "partially_verified": 0,
            "failed": 0,
            "skipped": 0,
            "unreachable": 0,
        }

        for mem in memories:
            if isinstance(mem, str):
                # Plain text memory with no metadata
                mem = {"text": mem}

            text = mem.get("text", mem.get("memory", ""))
            metadata = mem.get("metadata", mem.get("key_value_pairs", {}))
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except (json.JSONDecodeError, TypeError):
                    metadata = {}

            # Get the inner key_value_pairs if present
            if "key_value_pairs" in metadata:
                metadata = metadata["key_value_pairs"]

            if not text:
                results.append(
                    {
                        "memory_preview": "(empty)",
                        "type": metadata.get("type", "unknown"),
                        "verification_status": "skipped",
                        "issues": ["Empty memory text"],
                    }
                )
                counts["skipped"] += 1
                continue

            preview = text[:120] + "..." if len(text) > 120 else text

            if not verify_sources:
                # Lightweight check: metadata completeness + link reachability
                mem_type = metadata.get("type", "unknown")
                mem_issues = []
                if mem_type in ("finding", "project_update") and not metadata.get(
                    "source_url"
                ):
                    links = _extract_markdown_links(text)
                    if not links:
                        mem_issues.append("Missing source_url and no inline links")
                results.append(
                    {
                        "memory_preview": preview,
                        "type": mem_type,
                        "verification_status": "skipped"
                        if not mem_issues
                        else "flag_for_review",
                        "issues": mem_issues,
                    }
                )
                if mem_issues:
                    counts["failed"] += 1
                else:
                    counts["skipped"] += 1
                continue

            # Full verification
            result_raw = await verify_memory(
                memory_text=text,
                metadata_json=json.dumps(metadata),
            )
            result = json.loads(result_raw)
            status = result.get("verification_status", "failed")

            # Count unreachable as a separate category
            source_status = result.get("source_url_status", "")
            if source_status == "unreachable":
                counts["unreachable"] += 1
            elif status in counts:
                counts[status] += 1
            else:
                counts["failed"] += 1

            results.append(
                {
                    "memory_preview": preview,
                    "type": result.get("memory_type", "unknown"),
                    "verification_status": status,
                    "source_url": metadata.get("source_url", ""),
                    "issues": result.get("issues", []),
                    "recommendation": result.get("recommendation", ""),
                }
            )

        # Build summary
        total = len(memories)
        parts = []
        if counts["verified"]:
            parts.append(f"{counts['verified']} verified")
        if counts["partially_verified"]:
            parts.append(f"{counts['partially_verified']} partially verified")
        if counts["failed"]:
            parts.append(f"{counts['failed']} failed")
        if counts["unreachable"]:
            parts.append(f"{counts['unreachable']} unreachable")
        if counts["skipped"]:
            parts.append(f"{counts['skipped']} skipped")

        summary = f"{total} memories audited: {', '.join(parts)}."

        failed_items = [r for r in results if r.get("verification_status") == "failed"]
        if failed_items:
            summary += f" {len(failed_items)} memories should be reviewed or removed."

        return json.dumps(
            {
                "total_memories": total,
                "verified": counts["verified"],
                "partially_verified": counts["partially_verified"],
                "failed": counts["failed"],
                "unreachable": counts["unreachable"],
                "skipped": counts["skipped"],
                "results": results,
                "summary": summary,
            },
            indent=2,
        )

    # ------------------------------------------------------------------
    # Register all three tools with NAT
    # ------------------------------------------------------------------
    try:
        yield FunctionInfo.from_fn(
            verify_claim,
            description=(
                "Verify whether a source URL actually supports a claimed fact. "
                "Fetches the URL, uses LLM analysis to assess support. Returns "
                "structured verdict: supported/partially_supported/unsupported/"
                "source_unreachable with evidence excerpts and confidence score. "
                "Call this BEFORE storing any finding in memory to prevent "
                "citation hallucination. If verdict is 'unsupported' or "
                "'source_unreachable', do NOT store the memory."
            ),
        )

        yield FunctionInfo.from_fn(
            verify_memory,
            description=(
                "Verify an existing memory entry's citations and logical "
                "soundness. Pass the memory text and its metadata JSON. "
                "For findings: checks source_url reachability and verifies "
                "claims against the source. For syntheses: assesses whether "
                "connections are logically sound. Returns verification status, "
                "issues, and recommendation (retain/flag_for_review/remove)."
            ),
        )

        yield FunctionInfo.from_fn(
            audit_memories,
            description=(
                "Batch-verify a set of memories for citation quality. First "
                "call get_memory to retrieve memories, then pass the results "
                "here as memories_json. Returns a structured audit report with "
                "per-memory verdicts, aggregate counts (verified/failed/"
                "unreachable/skipped), and recommendations. Use during memory "
                "maintenance cycles to catch dead links and unsupported claims."
            ),
        )

    except GeneratorExit:
        logger.warning("source_verifier function exited early!")
    finally:
        logger.info("Cleaning up source_verifier function.")
