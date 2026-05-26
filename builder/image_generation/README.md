# Image Generation Function

This builder package registers a text-to-image function for Daedalus that
calls OpenAI's `/v1/images/generations` endpoint via `client.images.generate()`.

## What It Does

- Defaults to the `gpt-image-2` model
- Calls OpenAI's images API directly (no chat-completions wrapper)
- Optionally rewrites the user's prompt through another LLM before generation, using a structured schema (scene → subject → details → constraints)
- Stores each generated image in Redis through the shared `nat_helpers` storage helper
- Returns markdown that points at `/api/generated-image/{image_id}`, which the frontend renders inline. When `n > 1`, returns one markdown ref per line.

## Configuration

Default config lives in [`src/image_generation/configs/config.yml`](src/image_generation/configs/config.yml).

```yaml
workflow:
  _type: image_generation
  api_endpoint: null   # Optional: override OpenAI base URL
  api_key: null
  timeout: 60.0
  model: "gpt-image-2"
  quality: low         # "low", "medium", "high", or "auto"
  size: null           # see field description below
  n: 1                 # 1-10
  prompt_rewrite: null
  # moderation: low    # "auto" (default) or "low"
  # output_format: jpeg # "png" (default), "jpeg", or "webp"
  # output_compression: 80 # 0-100 for jpeg / webp
  # background: opaque  # "auto" or "opaque"; gpt-image-2 does not support "transparent"
  # user: null          # end-user identifier forwarded to OpenAI
```

Important fields:

| Field                 | Purpose                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `api_endpoint`        | OpenAI base URL override (leave null for default)                                                                                    |
| `api_key`             | Falls back to `OPENAI_API_KEY` if unset                                                                                              |
| `model`               | Image-generation model name                                                                                                          |
| `quality`             | `"low"` (fast drafts), `"medium"`, `"high"` (detail-heavy scenes, dense text), or `"auto"`                                           |
| `size`                | Common values: `"1024x1024"`, `"1536x1024"`, `"1024x1536"`, `"2048x2048"`, `"3840x2160"`, or `"auto"`. Any size satisfying the gpt-image-2 constraints (edges multiple of 16, max edge ≤ 3840, aspect ratio ≤ 3:1, total pixels 655,360–8,294,400) is accepted. |
| `n`                   | Number of variations per call (1–10)                                                                                                 |
| `moderation`          | Optional `"auto"` (default) or `"low"` content-moderation strictness                                                                  |
| `output_format`       | `"png"` (default), `"jpeg"`, or `"webp"` — jpeg is faster than png                                                                   |
| `output_compression`  | Compression 0–100 for jpeg or webp outputs (ignored for png)                                                                          |
| `background`          | `"auto"` or `"opaque"`. gpt-image-2 does not support `"transparent"`                                                                  |
| `user`                | Optional end-user identifier forwarded to OpenAI for abuse monitoring                                                                |
| `prompt_rewrite`      | Optional LLM-based prompt enhancement                                                                                                |

## Function Signature

The registered function is:

```python
generate_image(prompt: str) -> str
```

Example:

```python
result = await generate_image(
    "A cinematic painting of a lighthouse in a storm, warm light in the windows"
)
```

Typical return value:

```markdown
![Generated image](/api/generated-image/abc123...)
```

When `n > 1`, multiple markdown refs are joined with newlines.

## Daedalus Integration

1. The backend calls `generate_image`.
2. OpenAI's images API returns one or more base64 PNGs in `response.data`.
3. Each image is stored in Redis through the shared helper.
4. The frontend renders the returned `/api/generated-image/{id}` reference(s) in the conversation.

## Prompt Rewrite

If `prompt_rewrite` is configured, the function rewrites the user's prompt through a separate LLM before calling the image API. The default system prompt encodes OpenAI's recommended schema (scene → subject → details → constraints), with photography-specific guidance for photorealism and quoted-literal handling for in-image text.

## Notes

- The function returns an image result, not a textual description.
- Use [`../image_augmentation/`](../image_augmentation/) when an existing image must be edited and [`../image_comprehension/`](../image_comprehension/) for read-only analysis.

## Error Handling

The function returns user-visible error text when:

- no API key is available
- the images API call fails
- the model returns no image data
- Redis storage fails

## Requirements

- An OpenAI API key with images-API access
- `OPENAI_API_KEY` env var or explicit `api_key`
- Redis reachable at `redis_url`
