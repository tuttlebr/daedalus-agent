# Image Generation Function for NeMo Agent Toolkit

This custom NeMo Agent Toolkit function integrates with the Stable Diffusion 3.5 Large model API to generate images from text prompts.

## Features

- Text-to-image generation using Stable Diffusion 3.5
- Configurable image dimensions (768-1344 pixels)
- Adjustable generation parameters (steps, guidance scale, seed)
- Safety checker toggle
- Base64-encoded JPEG output

## Configuration

Update the configuration in `src/image_generation/configs/config.yml`:

```yaml
workflow:
  _type: image_generation
  api_endpoint: "http://localhost:8000"  # Your SD 3.5 API endpoint
  api_key: null  # Set if your API requires authentication
  timeout: 60.0
  default_width: 1024
  default_height: 1024
  default_steps: 50
```

## Usage

The function accepts a text prompt and returns a markdown-formatted image that displays directly in the UI.

### Example Usage

```python
# Generate an image with a prompt
result = await generate_image("A futuristic city skyline at sunset with flying cars")
```

### Response Format

The function returns a markdown-formatted image string:

```markdown
![Generated image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeA...)
```

This will be automatically rendered as an image in the UI.

### Configuration Parameters

The following parameters are configured in `config.yml`:

- `default_width`: Default image width (1024)
- `default_height`: Default image height (1024)
- `default_steps`: Default number of diffusion steps (50)

## Supported Image Dimensions

The following dimensions are supported (width x height):
- 768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344

Both width and height must be from this list of supported values.

## Installation

Make sure to install the required dependencies:

```bash
# For editable install (development)
pip install -e .

# If you encounter issues with editable install, try:
pip install --upgrade pip setuptools wheel
pip install -e .

# For regular install (production)
pip install .
```

This will install the function along with its dependencies including `httpx` for HTTP requests.

## API Endpoint

This function is designed to work with NVIDIA Visual Generative AI NIM for Stable Diffusion 3.5. Make sure your API endpoint is running and accessible at the configured URL.

## Error Handling

The function includes comprehensive error handling for:
- HTTP connection errors
- API response errors
- Invalid dimensions
- Content filtering

Errors are logged and appropriate error messages are returned to help with debugging.
