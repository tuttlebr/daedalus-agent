# Image Comprehension Function

This builder package registers a read-only media analysis function for Daedalus. It accepts uploaded images or videos, sends them to an OpenAI-compatible Vision Language Model endpoint, and returns a text description or answer.

## Current Behavior

- Accepts images via `imageRef` (Redis-stored upload) or `image_url` (direct URL)
- Accepts videos via `videoRef` (Redis-stored upload) or `video_url` (direct URL)
- Fetches uploaded media from Redis using stored IDs and session context
- Uses an OpenAI-compatible chat completions endpoint, defaulting to `https://integrate.api.nvidia.com/v1`
- Uses `nvidia/NVIDIA-Nemotron-Nano-12B-v2` by default
- Returns a text response describing or answering questions about the media — never a modified image

## Configuration

Default config lives in [`src/image_comprehension/configs/config.yml`](src/image_comprehension/configs/config.yml).

```yaml
workflow:
  _type: image_comprehension
  api_endpoint: "https://integrate.api.nvidia.com/v1"
  redis_url: "redis://daedalus-redis.daedalus.svc.cluster.local:6379"
  api_key: null
  timeout: 120.0
  model: "nvidia/NVIDIA-Nemotron-Nano-12B-v2"
  max_tokens: 1024
```

Important fields:

| Field | Purpose |
|-------|---------|
| `api_endpoint` | OpenAI-compatible VLM base URL |
| `api_key` | Falls back to `NVIDIA_API_KEY` if unset |
| `redis_url` | Source for uploaded images and videos |
| `model` | Vision Language Model name |
| `timeout` | HTTP timeout in seconds |
| `max_tokens` | Maximum response length |

## Function Signature

The registered function is:

```python
comprehend_media(
    question: str,
    imageRef: str | dict | None = None,
    image_url: str | None = None,
    videoRef: str | dict | None = None,
    video_url: str | None = None,
    max_tokens: int | None = None,
) -> str
```

## Daedalus Integration

1. A user uploads an image or video in the frontend.
2. The frontend stores the media in Redis and includes a ref in the chat payload.
3. The backend calls `comprehend_media` with the user's question and the media reference.
4. The function retrieves the media from Redis, encodes it as base64, and sends it to the VLM.
5. The model's text response is returned to the conversation.

## Image vs Video Handling

- For images, the model is prompted with `/think` to enable reasoning.
- For videos, the model is prompted with `/no_think` for faster processing.
- Only one media item is analyzed per call. If both image and video references are provided, video takes priority.

## Notes

- This function is read-only analysis. It returns text, not modified media. Use `image_augmentation` for edits and `image_generation` for new images.
- The `imageRef` / `videoRef` payloads match the attachment references produced by the Daedalus frontend.

## Error Handling

The function returns user-visible error text when:

- no question is provided
- no media reference or URL is supplied
- Redis lookup fails
- no API key is available
- the VLM API call fails or returns an unexpected format

## Requirements

- An OpenAI-compatible VLM endpoint
- `NVIDIA_API_KEY` or explicit `api_key`
- Redis reachable at `redis_url`
