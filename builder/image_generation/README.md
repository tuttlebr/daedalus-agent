# Image Generation Function

This builder package registers a text-to-image function for Daedalus that calls OpenAI's `/v1/images/generations` endpoint via `client.images.generate()`.

## Current Behavior

- Defaults to the `gpt-image-1` model
- Calls OpenAI's images API directly (no chat-completions wrapper)
- Optionally rewrites the user's prompt through another LLM before generation, using a structured schema (scene → subject → details → constraints)
- Stores each generated image in Redis
- Returns markdown that points at `/api/generated-image/{image_id}`, which the frontend renders inline. When `n > 1`, returns one markdown ref per line.

## Configuration

Default config lives in [`src/image_generation/configs/config.yml`](src/image_generation/configs/config.yml).

```yaml
workflow:
  _type: image_generation
  api_endpoint: null   # Optional: override OpenAI base URL
  api_key: null
  timeout: 60.0
  model: "gpt-image-1"
  quality: null        # "low" or "high"
  size: null           # "1024x1024" / "1024x1536" / "1536x1024" / "auto"
  n: null              # 1-10
  prompt_rewrite: null
```

Important fields:

| Field | Purpose |
|-------|---------|
| `api_endpoint` | OpenAI base URL override (leave null for default) |
| `api_key` | Falls back to `OPENAI_API_KEY` if unset |
| `model` | Image-generation model name |
| `redis_url` | Where generated images are stored |
| `quality` | `"low"` (latency) or `"high"` (detail-heavy scenes, dense text) |
| `size` | Output dimensions in pixels (or `"auto"`) |
| `n` | Number of variations per call |
| `prompt_rewrite` | Optional LLM-based prompt enhancement |

## Usage Model

The registered function is `generate_image(prompt: str) -> str`.

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

## Requirements

- An OpenAI API key with images-API access
- `OPENAI_API_KEY` env var or explicit `api_key`
- Redis reachable at `redis_url`

## Error Handling

The function returns user-visible error text when:

- no API key is available
- the images API call fails
- the model returns no image data
- Redis storage fails
