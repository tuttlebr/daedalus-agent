"""Shared image brief, prompt preparation, and provider parameter contract.

Create uses one bounded text-model call. Chat supplies the same brief using
its existing agent turn. Neither path rewrites an explicitly exact prompt.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)
SKILL_NAME = "gpt-image-2-photography"
PREPARATION_TIMEOUT_SECONDS = 20


class ImageOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quality: Literal["auto", "low", "medium", "high"] | None = None
    size: str | None = None
    n: int | None = Field(None, ge=1, le=8)
    output_format: Literal["png", "jpeg", "webp"] | None = None
    output_compression: int | None = Field(None, ge=0, le=100)
    background: Literal["auto", "transparent", "opaque"] | None = None

    @field_validator("size")
    @classmethod
    def valid_size(cls, value: str | None) -> str | None:
        if value in (None, "auto"):
            return value
        if not re.fullmatch(r"\d+x\d+", value):
            raise ValueError("Size must be WIDTHxHEIGHT or auto")
        width, height = map(int, value.split("x"))
        if (
            min(width, height) <= 0
            or max(width, height) > 3840
            or width % 16
            or height % 16
            or max(width, height) > 3 * min(width, height)
            or not 655_360 <= width * height <= 8_294_400
        ):
            raise ValueError("Size does not meet GPT Image 2 constraints")
        return value


class ImageBrief(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=8000)

    scene: str = ""
    subject: str = ""
    medium: str = ""
    composition: str = ""
    lighting: str = ""
    details: list[str] = Field(default_factory=list, max_length=32)
    exact_text: list[str] = Field(default_factory=list, max_length=32)
    changes: list[str] = Field(default_factory=list, max_length=32)
    preserve: list[str] = Field(default_factory=list, max_length=32)
    exclusions: list[str] = Field(default_factory=list, max_length=32)
    intended_use: str = ""
    references: list[str] = Field(default_factory=list, max_length=16)
    options: ImageOptions = Field(default_factory=ImageOptions)


class ImageContext(BaseModel):
    originalPrompt: str
    prompt: str
    brief: ImageBrief
    params: dict[str, Any]
    inputImages: list[dict[str, Any]] = Field(default_factory=list)
    skillVersion: str | None = None
    guidance: Literal["assisted", "exact", "fallback"]
    warning: str | None = None
    preparationMs: int = 0


@lru_cache(maxsize=8)
def _read_skill(path: str, modified: int) -> tuple[str, str]:
    text = Path(path).read_text(encoding="utf-8")
    return text, hashlib.sha256(text.encode()).hexdigest()[:16]


def photography_guidance() -> tuple[str, str]:
    directory = Path(os.getenv("AGENT_SKILLS_DIRECTORY", "/skills"))
    path = directory / SKILL_NAME / "SKILL.md"
    # Source checkout fallback, never a browser-supplied path.
    if not path.exists() and directory == Path("/skills"):
        path = Path(__file__).resolve().parents[4] / "skills" / SKILL_NAME / "SKILL.md"
    return _read_skill(str(path), path.stat().st_mtime_ns)


def normalize_image_options(
    model: str, options: dict[str, Any], mode: str
) -> dict[str, Any]:
    result = {k: v for k, v in options.items() if v is not None}
    if model == "gpt-image-2":
        keys = ImageOptions.model_fields
        ImageOptions.model_validate({k: v for k, v in result.items() if k in keys})
        result.pop("input_fidelity", None)
    if mode == "generate":
        result.pop("input_fidelity", None)
    else:
        result.pop("moderation", None)
    if result.get("background") == "transparent" and result.get(
        "output_format"
    ) not in {"png", "webp"}:
        result["output_format"] = "png"
    if result.get("output_format", "png") == "png":
        result.pop("output_compression", None)
    return result


def render_image_brief(
    prompt: str, brief: ImageBrief, mode: str, reference_count: int
) -> str:
    segments = []
    for key, label in (
        ("scene", "Scene"),
        ("subject", "Subject"),
        ("medium", "Medium"),
        ("composition", "Composition"),
        ("lighting", "Lighting"),
        ("details", "Details"),
        ("changes", "Change only"),
        ("preserve", "Preserve unless the current request changes it"),
        ("exclusions", "Exclude"),
        ("intended_use", "Intended use"),
    ):
        value = getattr(brief, key)
        if value:
            segments.append(
                f"{label}: " + ("; ".join(value) if isinstance(value, list) else value)
            )
    if brief.exact_text:
        segments.append(
            "Render this text verbatim, with no additional text: "
            + json.dumps(brief.exact_text, ensure_ascii=False)
        )
    if brief.references and len(brief.references) != reference_count:
        raise ValueError("Reference descriptions must match the ordered input images")
    for index in range(reference_count):
        description = (
            brief.references[index]
            if brief.references
            else ("edit target" if index == 0 else "additional reference")
        )
        segments.append(f"Image {index + 1}: {description}")
    if mode == "edit":
        segments.append(
            "Apply the requested changes to the supplied image. Preserve everything else unless the current request says otherwise."
        )
    # Keep the user's literal request, including spelling and quoted text.
    segments.append(
        "Current user request (takes precedence over the guidance above):\n" + prompt
    )
    return "\n\n".join(segments)


async def _plan_brief(
    prompt: str,
    mode: str,
    refs: list[dict],
    preserve: str,
    parent: ImageContext | None,
    skill: str,
    options: dict[str, Any],
) -> ImageBrief:
    prefix = "TOOL_CALLING_LLM_MODEL"
    model = os.getenv("IMAGE_PROMPT_MODEL") or os.getenv(f"{prefix}_MODEL")
    key = os.getenv("IMAGE_PROMPT_API_KEY") or os.getenv(f"{prefix}_API_KEY")
    base_url = os.getenv("IMAGE_PROMPT_BASE_URL") or os.getenv(f"{prefix}_BASE_URL")
    if not model or not key or key.startswith("${"):
        raise ValueError("Image prompt model is not configured")
    instructions = (
        "Prepare an image brief as JSON matching the supplied schema. Follow the photography skill selectively. "
        "The current user request overrides prior context and skill defaults. Preserve quoted text exactly. "
        "Do not impose photography on illustrations, invent facts or unseen image contents, remove requested logos/text, "
        "or add extra outputs unless requested. Use medium quality by default, high for dense text or demanding edits, "
        "low when speed is requested. For edits, return the complete updated preserve list, dropping constraints the "
        "current request changes. Keep the input image order, one reference description per input. "
        "The references are metadata, not images you have seen. API rules: omit input_fidelity for gpt-image-2; "
        "max edge is 3840 inclusive; transparent output needs PNG/WebP. Return JSON only.\n\n"
        + skill
        + "\n\nSchema:\n"
        + json.dumps(ImageBrief.model_json_schema())
    )
    payload = {
        "request": prompt,
        "mode": mode,
        "references": refs,
        "preserve": preserve,
        "explicitOptions": options,
        "previous": parent.model_dump() if parent else None,
    }
    async with AsyncOpenAI(
        api_key=key,
        base_url=base_url,
        timeout=PREPARATION_TIMEOUT_SECONDS,
        max_retries=0,
    ) as client:
        async with asyncio.timeout(PREPARATION_TIMEOUT_SECONDS):
            response = await client.responses.create(
                model=model,
                instructions=instructions,
                input=json.dumps(payload, ensure_ascii=False),
                max_output_tokens=3000,
            )
    raw = response.output_text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    return ImageBrief.model_validate_json(raw)


async def prepare_image_request(
    *,
    prompt: str,
    model: str,
    mode: str,
    options: dict[str, Any],
    refs: list[dict] | None = None,
    brief: ImageBrief | None = None,
    preserve: str = "",
    guidance: str = "auto",
    parent: ImageContext | None = None,
    use_model: bool = False,
) -> ImageContext:
    started = time.monotonic()
    refs = refs or []
    options = {key: value for key, value in options.items() if value is not None}
    inherited = (
        {key: value for key, value in parent.params.items() if key != "n"}
        if parent
        else {"quality": "medium"}
    )
    # Reject explicit invalid settings before an optional model call.
    normalize_image_options(model, options, mode)
    if not prompt.strip():
        raise ValueError("Prompt is required")
    if guidance == "exact":
        return ImageContext(
            originalPrompt=prompt,
            prompt=prompt,
            brief=ImageBrief(),
            params=normalize_image_options(model, {**inherited, **options}, mode),
            inputImages=refs,
            guidance="exact",
        )
    warning = None
    version = None
    planned = False
    try:
        skill, version = photography_guidance()
        if brief is None and use_model:
            brief = await _plan_brief(
                prompt, mode, refs, preserve, parent, skill, options
            )
            # Treat invalid reference indexing like any other failed preparation.
            render_image_brief(prompt, brief, mode, len(refs))
            planned = True
    except Exception as exc:
        # Prompt assistance is optional; provider failures must not block creation.
        logger.warning("Image prompt assistance unavailable (%s)", type(exc).__name__)
        warning = "Prompt assistance unavailable; your original request was used."
        if use_model:
            brief = None
    if brief is None:
        brief = ImageBrief(
            medium=parent.brief.medium if parent else "",
            preserve=[preserve]
            if preserve
            else (parent.brief.preserve if parent else []),
        )
    elif preserve and not planned:
        brief = brief.model_copy(update={"preserve": [*brief.preserve, preserve]})
    if parent:
        # Omitted fields inherit; explicit empty strings/lists clear old rules.
        # References and changes belong to this edit, not to the parent's edit.
        brief = brief.model_copy(
            update={
                key: getattr(parent.brief, key)
                for key in ImageBrief.model_fields
                if key not in brief.model_fields_set
                and key not in {"options", "changes", "references"}
            }
        )
    params = normalize_image_options(
        model,
        {**inherited, **brief.options.model_dump(exclude_none=True), **options},
        mode,
    )
    if params.get("background") == "transparent":
        brief = brief.model_copy(
            update={
                "preserve": [
                    *brief.preserve,
                    "transparent background; no opaque backdrop or checkerboard",
                ]
            }
        )
    brief = brief.model_copy(update={"preserve": list(dict.fromkeys(brief.preserve))})
    return ImageContext(
        originalPrompt=prompt,
        prompt=render_image_brief(prompt, brief, mode, len(refs)),
        brief=brief,
        params=params,
        inputImages=refs,
        skillVersion=version,
        guidance="fallback" if warning else "assisted",
        warning=warning,
        preparationMs=round((time.monotonic() - started) * 1000),
    )
