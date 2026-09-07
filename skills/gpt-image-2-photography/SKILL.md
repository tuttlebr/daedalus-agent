---
name: gpt-image-2-photography
description: Create or edit requested photos, illustrations, logos, infographics, mockups, and visual assets using Daedalus's shared image brief and visual_media_tool. Image analysis alone does not need this skill.
---

# Image generation and editing

Translate the user's request into a precise visual brief, preserving their
medium, text, references, and explicit settings. This guidance is used both by
chat and by Create's prompt-preparation service; keep it self-contained.

## Application contract

In chat, call `visual_media_tool` with `operation=generate` or `edit`,
the original request in `prompt`, an `ImageBrief` in `brief`, and explicit
output choices in `options`. Use the registered schema. The application owns
provider selection, credentials, storage, and image references; do not call an
OpenAI SDK or use the shell as an alternate image backend.

Create prepares the same brief internally. When the user requests their prompt
exactly, use `guidance=exact`, preserve the literal prompt, and omit the brief.
Do not rewrite it or add a separate concept-selection step.

A brief accepts these fields:

| Fields                                    | Type and purpose                                               |
| ----------------------------------------- | -------------------------------------------------------------- |
| `scene`, `subject`, `medium`              | Strings describing what to depict                              |
| `composition`, `lighting`, `intended_use` | Strings describing framing, look, and use                      |
| `details`, `exact_text`                   | Lists of details and verbatim lettering                        |
| `changes`, `preserve`, `exclusions`       | Lists of requested changes, invariants, and exclusions         |
| `references`                              | One description per supplied image, in exact input order       |
| `options`                                 | Suggested output choices, subordinate to explicit user choices |

Supply only useful fields. References are descriptions, not image inputs or
proof that an image has been viewed. For edits, pass actual supplied
`imageRef` values or a supported `image_url`; keep the primary edit target
first. Preserve returned IDs and order. Do not invent references or substitute
a thumbnail for the full-resolution source.

## Prompt decisions

Name the requested medium. For photography, describe framing, light, textures,
and the desired level of retouching; use camera/lens cues for appearance rather
than claiming a physical simulation. For illustration, logos, or diagrams,
describe their own visual language instead of imposing photorealism.

Give concrete subject placement and negative space when layout matters. Put
exact lettering in `exact_text`, keeping spelling and punctuation intact.
Describe placement and typography separately. Add exclusions only when the user
requested them or they resolve a clear ambiguity; do not remove requested
logos/text or invent blanket stylistic restrictions.

For edits, specify what changes and what must remain. The latest request
overrides previous preservation rules: rebuild the preserve list when the
user changes composition, identity treatment, wording, or style. For multiple
inputs, explain each input's role and how they combine.

Use a clear initial brief and bounded corrections. Do not repeatedly generate
variations unless the requested deliverable or a visible defect warrants it.
Use [creative-ideation](../creative-ideation/SKILL.md) only when concept
exploration is actually requested.

## Output choices

Use the current tool's `ImageOptions` contract:

- `quality`: `auto`, `low`, `medium`, or `high`. Medium suits most
  assets; use low for requested speed and high for demanding edits/dense text.
- `size`: `auto` or `WIDTHxHEIGHT`. GPT Image 2 accepts edges divisible
  by 16, maximum edge 3840 inclusive, aspect ratio at most 3:1, and total
  pixels from 655,360 through 8,294,400. Examples: `1024x1024`,
  `1024x1536`, `1536x1024`, `3840x2160`.
- `n`: 1–8; default to one unless the user requests variants.
- `output_format`: `png`, `jpeg`, or `webp`.
- `background`: `auto`, `transparent`, or `opaque`. Transparency
  requires PNG/WebP. Preserve alpha through follow-up edits.
- `output_compression`: 0–100 for JPEG/WebP; omit for PNG.

Honor explicit output choices over recommendations. Do not pass `model` or
`input_fidelity` as per-call options. GPT Image 2 processes inputs at high
fidelity and the application omits that legacy field.

## Verification and delivery

Inspect the returned image when an image-viewing/analysis tool is available.
Check requested content, exact lettering, edit invariants, composition, and
transparency. Do not assert those checks passed from the prompt alone.

Return the exact generated-image Markdown reference from `visual_media_tool`
so the frontend can render it. An error or failed persistence is not a
delivered image. Do not fabricate `/api/generated-image/` URLs.

For analysis-only requests, use `operation=analyze` directly.
[Daily-summary](../daily-summary/SKILL.md) uses source-only images and never
invokes generation/editing; do not replace missing reporting images with art.

Prompt craft follows the
[OpenAI prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide).
The local shared brief and option validation govern Daedalus calls.
