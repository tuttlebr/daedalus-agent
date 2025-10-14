# Image Augmentation Function for NeMo Agent Toolkit

This custom NeMo Agent Toolkit function integrates with NVIDIA's Flux Kontext API to modify existing images based on text prompts.

## Features

- Image augmentation using text prompts via NVIDIA NIM API
- Automatic image retrieval from Redis session storage
- Support for uploading images through the UI
- Configurable augmentation parameters (steps, seed, cfg_scale)
- Returns markdown-formatted images for seamless UI rendering
- Follows the same pattern as image_generation_tool for consistency

## Configuration

Update the configuration in `src/image_augmentation/configs/config.yml`:

```yaml
workflow:
  _type: image_augmentation
  api_endpoint: "https://fde8d464-c30b-4a51-ad04-ee3200156352.invocation.api.nvcf.nvidia.com"
  redis_url: "redis://redis:6379"  # Redis connection for image retrieval
  api_key: null  # Set if your API requires authentication or use NVIDIA_API_KEY env var
  timeout: 300.0
  default_steps: 30
  default_seed: 42
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

The function returns a markdown-formatted image string:

```markdown
![Augmented image](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD...)
```

This will be automatically rendered as an image in the UI.

## Workflow

The image augmentation workflow follows this pattern:

1. **User uploads image** → Frontend uploads image to Redis (with optional compression)
2. **Image stored in Redis** → Stored as JSON with imageId and sessionId as key
3. **User requests augmentation** → "make the sky purple" with uploaded image
4. **Frontend prepares message** → Includes imageRef data in message content
5. **Backend LLM receives message** → Extracts imageRef from message content
6. **LLM calls augment_image_simple** → Passes prompt and imageRef parameters
7. **Function fetches image** → Retrieves directly from Redis using Python redis-py client
8. **Function resizes image** → Automatically resizes to closest valid dimension pair using Pillow
9. **API augmentation** → Sends resized image to NVIDIA Flux Kontext endpoint
10. **Returns markdown** → `![Augmented image](data:image/png;base64,...)`
11. **UI renders image** → Displays augmented result

### Direct Redis Access

The function connects directly to Redis using the `redis-py` client library. This provides:
- **Better performance** - No HTTP overhead, direct Redis protocol
- **More reliable** - No HTTP timeouts or network issues between services
- **Simpler debugging** - Direct access to Redis keys for troubleshooting
- **Consistent data model** - Uses same Redis JSON structure as frontend

## Installation

Make sure to install the required dependencies:

```bash
# For editable install (development)
pip install -e .

# For regular install (production)
pip install .
```

This will install the function along with its dependencies including:
- `httpx` for NVIDIA API requests
- `redis` (redis-py) for direct Redis access
- `Pillow` for image processing and resizing

## API Endpoint

This function is designed to work with NVIDIA's Flux Kontext API that accepts:
- A base64-encoded input image (data URL format)
- A text prompt describing the desired changes
- Optional parameters: steps, seed, cfg_scale

The API returns the augmented image in base64 format wrapped in an artifacts array.

## Error Handling

The function includes comprehensive error handling for:
- Invalid or missing imageRef parameters
- Failed image retrieval from Redis storage
- HTTP connection errors to the augmentation API
- API response parsing errors
- Invalid image data or expired sessions

Errors are logged with detailed context and user-friendly error messages are returned.

## Image Format Support

The function supports common image formats:
- JPEG/JPG
- PNG
- WebP
- GIF

Images are automatically:
- Uploaded from the frontend and stored in Redis with references
- Retrieved by the augmentation function from Redis
- Resized to valid dimension pairs server-side using Pillow
- Converted to data URLs for API calls
- Returned as base64-encoded markdown images

## Supported Dimensions

The Flux Kontext API accepts images with these specific dimension pairs (width x height):
- 672×1568, 688×1504, 720×1456, 752×1392, 800×1328, 832×1248, 880×1184, 944×1104
- 1024×1024 (square)
- 1104×944, 1184×880, 1248×832, 1328×800, 1392×752, 1456×720, 1504×688, 1568×672

The augmentation function automatically resizes images to the closest valid dimension pair based on aspect ratio similarity before sending them to the API. This resizing happens server-side using Pillow for better quality and consistency.
