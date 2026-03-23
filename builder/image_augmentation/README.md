# Image Augmentation Function for NeMo Agent Toolkit

This custom NVIDIA NeMo Agent toolkit function modifies existing images based on text prompts. It supports multiple backends: NVIDIA API Catalog (custom), NIM self-hosted endpoints, OpenAI, and OpenRouter.

## Features

- Image augmentation using text prompts
- Multiple API backends: `custom`, `nim`, `openai`, `openrouter`
- Automatic image retrieval from Redis session storage
- Configurable augmentation parameters (steps, seed, cfg_scale)
- Returns markdown-formatted images for seamless UI rendering
- Follows the same pattern as `image_generation_tool` for consistency

## Configuration

Update the configuration in `src/image_augmentation/configs/config.yml`:

```yaml
workflow:
  _type: image_augmentation
  api_type: custom  # custom, nim, openai, or openrouter
  api_endpoint: "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-kontext-dev"
  redis_url: "redis://redis:6379"
  api_key: null  # Falls back to NVIDIA_API_KEY env var
  timeout: 300.0
  default_steps: 30
  default_seed: 42
```

### API Types

| Type | Endpoint | Description |
|------|----------|-------------|
| `custom` | Full URL to model endpoint | Direct HTTP POST. Works with NVIDIA API Catalog and compatible endpoints. Sends `aspect_ratio: "match_input_image"` so no client-side resizing is needed. |
| `nim` | Base URL (appends `/v1/infer`) | NVIDIA NIM self-hosted Flux Kontext. Handles dimension validation and automatic resizing to valid pairs. |
| `openai` | Uses OpenAI SDK | OpenAI `images.edit` endpoint via the SDK. Requires `OPENAI_API_KEY`. |
| `openrouter` | OpenRouter API | OpenRouter multimodal chat completions. Supports up to 15 images. Requires `OPENROUTER_API_KEY`. |

### Backend YAML Configuration

In the NAT backend YAML (e.g., `backend/tool-calling-config.yaml`):

```yaml
image_augmentation_tool:
  _type: image_augmentation
  api_type: custom
  api_endpoint: https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-kontext-dev
  api_key: ${NVIDIA_API_KEY}
  redis_url: ${REDIS_URL}
```

## Usage

The function accepts an image reference (from uploaded images stored in Redis) and a text prompt describing the desired augmentations.

### Example Usage

When a user uploads an image and requests augmentation, the LLM extracts the imageRef from the user's message attachments and calls:

```python
result = await augment_image_simple(
    prompt="add sunglasses to the person",
    imageRef={
        "imageId": "5c15684f928f4a36e60d5337e3c530b5",
        "sessionId": "db2a8b6a-1caf-4b81-b747-80b3a2db2add",
        "mimeType": "image/png"
    },
    steps=30,  # optional
    seed=42    # optional
)
```

### Input Parameters

- `prompt`: Text describing the desired augmentations (required)
- `imageRef`: Dictionary with `imageId`, `sessionId`, and optional `mimeType` (required)
- `steps`: Number of diffusion steps (optional, default: 30)
- `seed`: Random seed for reproducibility (optional, default: 42)
- `cfg_scale`: Guidance scale for prompt adherence (optional, 1.0-9.0)

### Response Format

The function returns a markdown-formatted image reference:

```markdown
![Augmented image](/api/generated-image/{image_id})
```

This is automatically rendered as an image in the UI. The augmented image is stored in Redis with a 7-day TTL.

## Workflow

1. **User uploads image** -- Frontend stores image in Redis with imageId/sessionId
2. **User requests augmentation** -- "make the sky purple" with uploaded image
3. **LLM calls augment_image_simple** -- Passes prompt and imageRef parameters
4. **Function fetches image** -- Retrieves from Redis using redis-py client
5. **API augmentation** -- Sends image to configured endpoint
6. **Store result** -- Augmented image stored in Redis
7. **Returns markdown** -- `![Augmented image](/api/generated-image/{id})`
8. **UI renders image** -- Displays augmented result

## Installation

```bash
pip install -e .   # development
pip install .      # production
```

Dependencies: `httpx`, `redis` (redis-py), `Pillow`, `openai` (for OpenAI api_type).

## Error Handling

The function includes error handling for:
- Invalid or missing imageRef parameters
- Failed image retrieval from Redis storage
- HTTP connection errors to the augmentation API
- API response parsing errors
- Invalid image data or expired sessions

Errors are logged with detailed context and user-friendly error messages are returned.

## Image Format Support

Supported formats: JPEG/JPG, PNG, WebP, GIF. Images are automatically retrieved from Redis, converted to data URLs for API calls, and stored back as base64 in Redis.

## NIM Dimension Handling

When using `api_type: nim`, the function automatically resizes images to valid Flux Kontext dimension pairs (e.g., 1024x1024, 832x1248) based on aspect ratio similarity. The `custom` type avoids this by sending `aspect_ratio: "match_input_image"` to the API.
