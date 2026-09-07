# Visual Media Function

This builder package registers a single unified `visual_media` tool for Daedalus
that handles **image generation**, **image editing**, and **image/video
analysis** (VLM) through one entry point with an `operation` parameter.

## What It Does

- `operation="generate"` — text-to-image via OpenAI `/v1/images/generations`
- `operation="edit"` — image edit/augmentation via OpenAI `/v1/images/edits`
- `operation="analyze"` — read-only image or video Q&A via an OpenAI-compatible
  Vision Language Model

Generated images are persisted in Redis through the shared `nat_helpers`
storage helper and returned as markdown refs like
`![Generated image](/api/generated-image/{id})` that the frontend renders
inline. When `n > 1`, one markdown ref per line is returned.

## Configuration

Default config lives in [`src/visual_media/configs/config.yml`](src/visual_media/configs/config.yml).

```yaml
workflow:
  _type: visual_media
  redis_url: redis://redis:6379
  generation_api_endpoint: null
  generation_api_key: null
  generation_model: gpt-image-2
  edit_api_endpoint: null
  edit_api_key: null
  edit_model: gpt-image-2
  comprehension_api_endpoint: http://localhost:8000
  comprehension_api_key: null
  comprehension_model: nvidia/NVIDIA-Nemotron-Nano-12B-v2
  quality: low
  n: 1
```

Important fields:

| Field                 | Purpose                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation_api_*`    | Endpoint + key for text-to-image. Falls back to `image_api_*` then `OPENAI_API_KEY`.                                                                  |
| `edit_api_*`          | Endpoint + key for image editing. Falls back to `image_api_*` then `OPENAI_API_KEY`.                                                                  |
| `comprehension_api_*` | Endpoint + key for the VLM. Falls back to `NVIDIA_API_KEY`.                                                                                           |
| `generation_model`    | Model used for `operation="generate"` (default `gpt-image-2`).                                                                                        |
| `edit_model`          | Model used for `operation="edit"` (default `gpt-image-2`).                                                                                            |
| `comprehension_model` | VLM model used for `operation="analyze"`.                                                                                                             |
| `quality`             | `"low"`, `"medium"`, `"high"`, or `"auto"`.                                                                                                           |
| `size`                | e.g. `"1024x1024"`, `"1536x1024"`, `"3840x2160"`, or `"auto"`. Any gpt-image-2-compliant resolution (edges multiple of 16, aspect ≤ 3:1) is accepted. |
| `input_fidelity`      | `"low"` or `"high"`. Legacy models only; omitted for GPT Image 2, which always processes inputs at high fidelity.                                     |
| `n`                   | 1–8 variations per call.                                                                                                                              |
| `moderation`          | `"auto"` (default) or `"low"`; generation only.                                                                                                       |
| `output_format`       | `"png"` (default), `"jpeg"`, or `"webp"`.                                                                                                             |
| `output_compression`  | 0–100 for jpeg or webp outputs.                                                                                                                       |
| `background`          | `"auto"`, `"transparent"`, or `"opaque"`. Transparent GPT Image 2 output uses PNG (default) or WebP; JPEG is normalized to PNG.                       |
| `user`                | Optional end-user identifier forwarded for abuse monitoring.                                                                                          |

## Function Signature

The registered function is:

```python
visual_media(
    operation: str,                # "generate", "edit", or "analyze"
    prompt: str = "",             # original user request
    brief: ImageBrief | None = None,
    options: ImageOptions | None = None,
    guidance: str = "auto",        # "auto" or "exact"
    imageRef: str | dict | list[dict] | None = None,
    image_url: str | None = None,
    videoRef: str | dict | None = None,
    video_url: str | None = None,
    question: str = "",
    background: str | None = None,  # "auto", "transparent", or "opaque"
) -> str
```

The backend derives media ownership from trusted NAT request metadata. A
legacy direct caller may still supply `user_id`, but it is only an equality
assertion and is intentionally absent from the LLM-facing schema.

Examples:

```python
# Generate
await visual_media(operation="generate", prompt="A cinematic lighthouse in a storm")

# Generate a reusable asset with a real alpha channel
await visual_media(operation="generate", prompt="An isolated product bottle, no backdrop",
                  background="transparent")

# Edit
await visual_media(operation="edit", prompt="Change the sky to golden hour. Keep the subject identical.",
                  imageRef={"imageId": "...", "sessionId": "..."})

# Analyze
await visual_media(operation="analyze", question="What is shown here?",
                  image_url="https://example.com/cat.jpg")
```

## Error Handling

Returns an `Error: ...` prefixed string when:

- no API key is available for the requested operation
- the upstream API call fails (HTTP or network error)
- the model returns no image
- Redis storage fails
- a required field is missing for the chosen operation
- trusted request identity is missing or a legacy identity assertion mismatches it

## Requirements

- An OpenAI API key with images-API access (`OPENAI_API_KEY`)
- An OpenAI-compatible VLM endpoint for the analyze operation
- Redis reachable at `redis_url`

## Image guidance across Create and chat

For explicit generation or editing, chat loads
`skills/gpt-image-2-photography/SKILL.md` through `agent_skills_tool` and supplies
an `ImageBrief` to `visual_media_tool`. The brief covers scene, subject, medium,
composition, lighting, details, exact lettering, requested changes, preservation
rules, exclusions, intended use, and ordered reference descriptions. Per-call
`options` accept quality, size, count, format, compression, and background.
The backend renders and validates the brief without a second chat-model call.
Analysis and source-only daily summaries do not trigger image creation.

Create's existing background jobs prepare the same brief using one Responses
API call to the configured text model. `IMAGE_PROMPT_MODEL`,
`IMAGE_PROMPT_API_KEY`, and `IMAGE_PROMPT_BASE_URL` optionally override the
existing `TOOL_CALLING_LLM_MODEL_MODEL`, `TOOL_CALLING_LLM_MODEL_API_KEY`, and
`TOOL_CALLING_LLM_MODEL_BASE_URL`. No new configuration is required when those
existing text-model settings are present. Preparation has a 20-second deadline
and no retries. Missing configuration, an unavailable skill, invalid model
output, or a preparation failure falls back to the original request and records
a visible warning. `AGENT_SKILLS_DIRECTORY` optionally overrides `/skills`.

Create's **Use my prompt exactly** option bypasses skill loading and rewriting;
**Prompt used** shows the actual submitted prompt. Explicit output settings take
precedence over recommendations. The shared capability check drops unsupported
GPT Image 2 input fidelity, validates dimensions, and preserves alpha through
PNG/WebP output. Invalid explicit settings are rejected before preparation.

Generated images store `imageContext` alongside their bytes: original and final
prompts, the brief, effective parameters, ordered parent references, skill hash,
and assistance status. Completed JSON/SSE responses carry that context into job
status and history. Follow-up edits inherit the selected primary image's output
settings; a complete new brief replaces obsolete preservation/text constraints.
The latest user request takes precedence. Chat edits use full-resolution edit
sources, never the smaller vision-analysis derivative.

**Send to chat** stages the selected output and context in the composer. It does
not submit a message. Reusing an output in Create makes it Image 1 and removes
any mask paired with the previous target.
