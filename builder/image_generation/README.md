# Image Generation Function

This builder package registers a text-to-image function for Daedalus using an OpenAI-compatible chat completions endpoint with image output support.

## Current Behavior

- Uses `gpt-image-1` by default
- Targets an OpenAI-compatible base URL, defaulting to `https://ai.api.nvidia.com/v1`
- Optionally rewrites prompts through another LLM before image generation
- Stores the generated image in Redis
- Returns markdown that points at `/api/generated-image/{image_id}`, which the frontend renders inline

The function does not return raw base64 to the UI in normal Daedalus usage.

## Configuration

Default config lives in [`src/image_generation/configs/config.yml`](src/image_generation/configs/config.yml).

```yaml
workflow:
  _type: image_generation
  api_endpoint: "https://ai.api.nvidia.com/v1"
  api_key: null
  timeout: 60.0
  model: "gpt-image-1"
  image_config: null
  prompt_rewrite: null
```

Important fields:

| Field | Purpose |
|-------|---------|
| `api_endpoint` | OpenAI-compatible base URL |
| `api_key` | Falls back to `OPENAI_API_KEY` if unset |
| `model` | Image-generation model name |
| `redis_url` | Where generated images are stored |
| `image_config` | Optional API image settings such as aspect ratio or image size |
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

## Daedalus Integration

1. The backend calls `generate_image`.
2. The configured image model returns image content.
3. The function extracts the first returned image.
4. The image is stored in Redis through shared helper utilities.
5. The frontend renders the returned `/api/generated-image/{id}` reference in the conversation.

## Prompt Rewrite

If `prompt_rewrite` is configured, the function can rewrite the user's prompt through a separate LLM before calling the image model. This is optional and is intended to improve visual specificity while preserving user intent.

## Requirements

- An OpenAI-compatible image-capable endpoint
- `OPENAI_API_KEY` or `api_key`
- Redis reachable at `redis_url`

## Error Handling

The function returns user-visible error text when:

- no API key is available
- the image API call fails
- the model returns no image
- Redis storage fails
