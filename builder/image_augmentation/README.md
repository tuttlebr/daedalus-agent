# Image Augmentation Function

This builder package registers an image-editing function for Daedalus that calls OpenAI's `/v1/images/edits` endpoint via `client.images.edit()`. It takes one or more uploaded image references plus a prompt, sends them to OpenAI, stores the edited result in Redis, and returns a frontend-renderable markdown image reference.

## Current Behavior

- Accepts a single `imageRef` object or a list of image references
- Fetches source images from Redis using the stored `imageId` and `sessionId`, then decodes the base64 payload to bytes for the OpenAI SDK
- Defaults to the `gpt-image-1.5` model
- Stores each edited output in Redis
- Returns markdown like `![Augmented image](/api/generated-image/{id})`. When `n > 1`, returns one markdown ref per line.

## Configuration

Default config lives in [`src/image_augmentation/configs/config.yml`](src/image_augmentation/configs/config.yml).

```yaml
workflow:
  _type: image_augmentation
  api_endpoint: null
  redis_url: "redis://daedalus-redis.daedalus.svc.cluster.local:6379"
  api_key: null
  timeout: 300.0
  model: "gpt-image-1.5"
  quality: null         # "low" or "high"
  input_fidelity: null  # "high" for identity-preserving edits
  size: null            # "1024x1024" / "1024x1536" / "1536x1024" / "auto"
  n: null               # 1-10
```

Important fields:

| Field | Purpose |
|-------|---------|
| `api_endpoint` | OpenAI base URL override (leave null for default) |
| `api_key` | Falls back to `OPENAI_API_KEY` if unset |
| `redis_url` | Source and destination image storage |
| `model` | Image-editing model name |
| `quality` | `"low"` (latency) or `"high"` (detail-heavy edits) |
| `input_fidelity` | `"high"` to preserve subject identity, geometry, layout (try-on, sketch-to-render, targeted swaps) |
| `size` | Output dimensions in pixels (or `"auto"`) |
| `n` | Number of variations per call |

## Function Signature

The registered function is effectively:

```python
augment_image(prompt: str, imageRef: str | dict | list[dict] | None = None) -> str
```

The `imageRef` payload matches the attachment references produced by the frontend, for example:

```json
{
  "imageId": "5c15684f928f4a36e60d5337e3c530b5",
  "sessionId": "db2a8b6a-1caf-4b81-b747-80b3a2db2add",
  "mimeType": "image/png"
}
```

## Prompting Conventions

The tool description and docstring teach the calling LLM these conventions, derived from OpenAI's gpt-image-1.5 prompting guide:

- **Separate "what changes" from "what stays."** State the change first, then a preserve list ("keep the face, pose, clothing, camera angle, and lighting exactly the same"). Repeat the preserve list each turn to prevent drift.
- **Index multi-image inputs in the prompt** when passing a list (e.g. `"Image 1: subject. Image 2: style reference. Apply Image 2's palette to Image 1."`).
- **Use `input_fidelity: "high"`** for identity-critical edits (try-on, sketch-to-render, targeted object swaps).

## Daedalus Integration

1. A user uploads an image in the frontend.
2. The frontend stores the image in Redis and includes an `imageRef` in the chat payload.
3. The backend calls `augment_image` with the prompt plus that image reference.
4. The function retrieves the source image(s), decodes the base64 to bytes, calls OpenAI's images.edit, stores the result(s), and returns one or more generated-image URLs.
5. The frontend renders the resulting image(s) inline in the conversation.

## Notes

- Multi-image editing is supported by passing a list of image references.
- The function returns an image result, not a textual description.
- This package is meant for edits or transformations of existing user-provided images. Use `image_generation` for brand-new images.

## Error Handling

The function returns user-visible error text when:

- no prompt is provided
- the image reference is missing or malformed
- Redis lookup fails
- base64 decoding fails
- no API key is available
- the images API call fails or returns no image
