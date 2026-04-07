# Image Augmentation Function

This builder package registers an image-editing function for Daedalus. It takes one or more uploaded image references plus a prompt, sends them to an OpenAI-compatible image endpoint, stores the edited result in Redis, and returns a frontend-renderable markdown image reference.

## Current Behavior

- Accepts a single `imageRef` object or a list of image references
- Fetches source images from Redis using the stored `imageId` and `sessionId`
- Uses an OpenAI-compatible endpoint, defaulting to `https://ai.api.nvidia.com/v1`
- Uses `gpt-image-1` by default
- Stores the edited output in Redis
- Returns markdown like `![Augmented image](/api/generated-image/{id})`

## Configuration

Default config lives in [`src/image_augmentation/configs/config.yml`](src/image_augmentation/configs/config.yml).

```yaml
workflow:
  _type: image_augmentation
  api_endpoint: "https://ai.api.nvidia.com/v1"
  redis_url: "redis://daedalus-redis.daedalus.svc.cluster.local:6379"
  api_key: null
  timeout: 300.0
  model: "gpt-image-1"
  image_config: null
```

Important fields:

| Field | Purpose |
|-------|---------|
| `api_endpoint` | OpenAI-compatible base URL |
| `api_key` | Falls back to `OPENAI_API_KEY` if unset |
| `redis_url` | Source and destination image storage |
| `model` | Image-editing model name |
| `image_config` | Optional API image settings such as aspect ratio or image size |

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

## Daedalus Integration

1. A user uploads an image in the frontend.
2. The frontend stores the image in Redis and includes an `imageRef` in the chat payload.
3. The backend calls `augment_image` with the prompt plus that image reference.
4. The function retrieves the source image(s), calls the image model, stores the result, and returns a generated-image URL.
5. The frontend renders the resulting image inline in the conversation.

## Notes

- Multi-image editing is supported by passing a list of image references.
- The function returns an image result, not a textual description.
- This package is meant for edits or transformations of existing user-provided images. Use `image_generation` for brand-new images.

## Error Handling

The function returns user-visible error text when:

- no prompt is provided
- the image reference is missing or malformed
- Redis lookup fails
- no API key is available
- the image model fails or returns no image
