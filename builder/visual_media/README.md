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
  edit_model: gpt-image-1.5
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
| `edit_model`          | Model used for `operation="edit"` (default `gpt-image-1.5`).                                                                                          |
| `comprehension_model` | VLM model used for `operation="analyze"`.                                                                                                             |
| `quality`             | `"low"`, `"medium"`, `"high"`, or `"auto"`.                                                                                                           |
| `size`                | e.g. `"1024x1024"`, `"1536x1024"`, `"3840x2160"`, or `"auto"`. Any gpt-image-2-compliant resolution (edges multiple of 16, aspect ≤ 3:1) is accepted. |
| `input_fidelity`      | `"low"` or `"high"`. Use `"high"` for identity-preserving edits (try-on, sketch-to-render, targeted swaps).                                           |
| `n`                   | 1–10 variations per call.                                                                                                                             |
| `moderation`          | `"auto"` (default) or `"low"`.                                                                                                                        |
| `output_format`       | `"png"` (default), `"jpeg"`, or `"webp"`.                                                                                                             |
| `output_compression`  | 0–100 for jpeg or webp outputs.                                                                                                                       |
| `background`          | `"auto"` or `"opaque"`. gpt-image-2 does not support `"transparent"`.                                                                                 |
| `user`                | Optional end-user identifier forwarded for abuse monitoring.                                                                                          |

## Function Signature

The registered function is:

```python
visual_media(
    operation: str,                # "generate", "edit", or "analyze"
    prompt: str = "",
    imageRef: str | dict | list[dict] | None = None,
    image_url: str | None = None,
    videoRef: str | dict | None = None,
    video_url: str | None = None,
    question: str = "",
    max_tokens: int | None = None,
    user_id: str = "",
) -> str
```

Examples:

```python
# Generate
await visual_media(operation="generate", prompt="A cinematic lighthouse in a storm",
                  user_id="alice")

# Edit
await visual_media(operation="edit", prompt="Change the sky to golden hour. Keep the subject identical.",
                  imageRef={"imageId": "...", "sessionId": "..."}, user_id="alice")

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
- `user_id` is missing for a user-scoped operation

## Requirements

- An OpenAI API key with images-API access (`OPENAI_API_KEY`)
- An OpenAI-compatible VLM endpoint for the analyze operation
- Redis reachable at `redis_url`
