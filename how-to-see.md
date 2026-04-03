# Multimodal Media Guide

This document covers how to work with visual media through the OpenRouter API: analyzing images, understanding video content, and generating new images from text prompts. All capabilities are accessed through the `/api/v1/chat/completions` endpoint.

---

## Image Comprehension

Send images to multimodal models for analysis via the multi-part `messages` parameter. The `image_url` field accepts either a public URL or a base64-encoded data URL. Multiple images can be included as separate entries in the content array (limits vary by provider and model).

Due to how content is parsed, send the text prompt first, then the images. If images must come first, place them in the system prompt.

**Delivery methods:**

* **URLs** -- More efficient for publicly accessible images since they skip local encoding
* **Base64** -- Required for local files or images that aren't publicly accessible

### Using Image URLs

<Template
  data={{
  API_KEY_REF,
  MODEL: 'google/gemini-3-flash-preview'
}}>
  <CodeGroup>
    ```typescript title="TypeScript SDK"
    import { OpenRouter } from '@openrouter/sdk';

    const openRouter = new OpenRouter({
      apiKey: '{{API_KEY_REF}}',
    });

    const result = await openRouter.chat.send({
      model: '{{MODEL}}',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: "What's in this image?",
            },
            {
              type: 'image_url',
              imageUrl: {
                url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg',
              },
            },
          ],
        },
      ],
      stream: false,
    });

    console.log(result);
    ```

    ```python
    import requests
    import json

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY_REF}",
        "Content-Type": "application/json"
    }

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "What's in this image?"
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
                    }
                }
            ]
        }
    ]

    payload = {
        "model": "{{MODEL}}",
        "messages": messages
    }

    response = requests.post(url, headers=headers, json=payload)
    print(response.json())
    ```

    ```typescript title="TypeScript (fetch)"
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY_REF}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: '{{MODEL}}',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: "What's in this image?",
              },
              {
                type: 'image_url',
                image_url: {
                  url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg',
                },
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    console.log(data);
    ```
  </CodeGroup>
</Template>

### Using Base64 Encoded Images

For locally stored images, encode them as base64 data URLs:

<Template
  data={{
  API_KEY_REF,
  MODEL: 'google/gemini-3-flash-preview'
}}>
  <CodeGroup>
    ```typescript title="TypeScript SDK"
    import { OpenRouter } from '@openrouter/sdk';
    import * as fs from 'fs';

    const openRouter = new OpenRouter({
      apiKey: '{{API_KEY_REF}}',
    });

    async function encodeImageToBase64(imagePath: string): Promise<string> {
      const imageBuffer = await fs.promises.readFile(imagePath);
      const base64Image = imageBuffer.toString('base64');
      return `data:image/jpeg;base64,${base64Image}`;
    }

    // Read and encode the image
    const imagePath = 'path/to/your/image.jpg';
    const base64Image = await encodeImageToBase64(imagePath);

    const result = await openRouter.chat.send({
      model: '{{MODEL}}',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: "What's in this image?",
            },
            {
              type: 'image_url',
              imageUrl: {
                url: base64Image,
              },
            },
          ],
        },
      ],
      stream: false,
    });

    console.log(result);
    ```

    ```python
    import requests
    import json
    import base64
    from pathlib import Path

    def encode_image_to_base64(image_path):
        with open(image_path, "rb") as image_file:
            return base64.b64encode(image_file.read()).decode('utf-8')

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY_REF}",
        "Content-Type": "application/json"
    }

    # Read and encode the image
    image_path = "path/to/your/image.jpg"
    base64_image = encode_image_to_base64(image_path)
    data_url = f"data:image/jpeg;base64,{base64_image}"

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "What's in this image?"
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": data_url
                    }
                }
            ]
        }
    ]

    payload = {
        "model": "{{MODEL}}",
        "messages": messages
    }

    response = requests.post(url, headers=headers, json=payload)
    print(response.json())
    ```

    ```typescript title="TypeScript (fetch)"
    async function encodeImageToBase64(imagePath: string): Promise<string> {
      const imageBuffer = await fs.promises.readFile(imagePath);
      const base64Image = imageBuffer.toString('base64');
      return `data:image/jpeg;base64,${base64Image}`;
    }

    // Read and encode the image
    const imagePath = 'path/to/your/image.jpg';
    const base64Image = await encodeImageToBase64(imagePath);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY_REF}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: '{{MODEL}}',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: "What's in this image?",
              },
              {
                type: 'image_url',
                image_url: {
                  url: base64Image,
                },
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    console.log(data);
    ```
  </CodeGroup>
</Template>

### Supported Image Formats

* `image/png`
* `image/jpeg`
* `image/webp`
* `image/gif`

---

## Video Comprehension

Send video files to compatible models for analysis via the `video_url` content type. Like images, the `url` field accepts either a public URL or a base64-encoded data URL. Only models with video processing capabilities will handle these requests -- filter by video input modality on the [Models page](/models?fmt=cards&input_modalities=video) to find them.

<Info>
  **Important:** Video URL support varies by provider. OpenRouter only sends video URLs to providers that explicitly support them. For example, Google Gemini on AI Studio only supports YouTube links (not Vertex AI).
</Info>

<Warning>
  **API Only:** Video inputs are currently only supported via the API. Video uploads are not available in the OpenRouter chatroom interface at this time.
</Warning>

**Delivery methods:**

* **URLs** -- Efficient for publicly accessible videos since they skip local encoding
* **Base64 Data URLs** -- Required for local files or private videos

### Using Video URLs

For Google Gemini on AI Studio, only YouTube links are supported:

<Template
  data={{
  API_KEY_REF,
  MODEL: 'google/gemini-2.5-flash'
}}>
  <CodeGroup>
    ```typescript title="TypeScript SDK"
    import { OpenRouter } from '@openrouter/sdk';

    const openRouter = new OpenRouter({
      apiKey: '{{API_KEY_REF}}',
    });

    const result = await openRouter.chat.send({
      model: "{{MODEL}}",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please describe what's happening in this video.",
            },
            {
              type: "video_url",
              videoUrl: {
                url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              },
            },
          ],
        },
      ],
      stream: false,
    });

    console.log(result);
    ```

    ```python
    import requests
    import json

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY_REF}",
        "Content-Type": "application/json"
    }

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Please describe what's happening in this video."
                },
                {
                    "type": "video_url",
                    "video_url": {
                        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                    }
                }
            ]
        }
    ]

    payload = {
        "model": "{{MODEL}}",
        "messages": messages
    }

    response = requests.post(url, headers=headers, json=payload)
    print(response.json())
    ```

    ```typescript title="TypeScript (fetch)"
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY_REF}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "{{MODEL}}",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please describe what's happening in this video.",
              },
              {
                type: "video_url",
                video_url: {
                  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                },
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    console.log(data);
    ```
  </CodeGroup>
</Template>

### Using Base64 Encoded Videos

For locally stored videos, encode them as base64 data URLs:

<Template
  data={{
  API_KEY_REF,
  MODEL: 'google/gemini-2.5-flash'
}}>
  <CodeGroup>
    ```typescript title="TypeScript SDK"
    import { OpenRouter } from '@openrouter/sdk';
    import * as fs from 'fs';

    const openRouter = new OpenRouter({
      apiKey: '{{API_KEY_REF}}',
    });

    async function encodeVideoToBase64(videoPath: string): Promise<string> {
      const videoBuffer = await fs.promises.readFile(videoPath);
      const base64Video = videoBuffer.toString('base64');
      return `data:video/mp4;base64,${base64Video}`;
    }

    // Read and encode the video
    const videoPath = 'path/to/your/video.mp4';
    const base64Video = await encodeVideoToBase64(videoPath);

    const result = await openRouter.chat.send({
      model: '{{MODEL}}',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: "What's in this video?",
            },
            {
              type: 'video_url',
              videoUrl: {
                url: base64Video,
              },
            },
          ],
        },
      ],
      stream: false,
    });

    console.log(result);
    ```

    ```python
    import requests
    import json
    import base64
    from pathlib import Path

    def encode_video_to_base64(video_path):
        with open(video_path, "rb") as video_file:
            return base64.b64encode(video_file.read()).decode('utf-8')

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY_REF}",
        "Content-Type": "application/json"
    }

    # Read and encode the video
    video_path = "path/to/your/video.mp4"
    base64_video = encode_video_to_base64(video_path)
    data_url = f"data:video/mp4;base64,{base64_video}"

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "What's in this video?"
                },
                {
                    "type": "video_url",
                    "video_url": {
                        "url": data_url
                    }
                }
            ]
        }
    ]

    payload = {
        "model": "{{MODEL}}",
        "messages": messages
    }

    response = requests.post(url, headers=headers, json=payload)
    print(response.json())
    ```

    ```typescript title="TypeScript (fetch)"
    import * as fs from 'fs';

    async function encodeVideoToBase64(videoPath: string): Promise<string> {
      const videoBuffer = await fs.promises.readFile(videoPath);
      const base64Video = videoBuffer.toString('base64');
      return `data:video/mp4;base64,${base64Video}`;
    }

    // Read and encode the video
    const videoPath = 'path/to/your/video.mp4';
    const base64Video = await encodeVideoToBase64(videoPath);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY_REF}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: '{{MODEL}}',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: "What's in this video?",
              },
              {
                type: 'video_url',
                video_url: {
                  url: base64Video,
                },
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    console.log(data);
    ```
  </CodeGroup>
</Template>

### Supported Video Formats

* `video/mp4`
* `video/mpeg`
* `video/mov`
* `video/webm`

### Common Use Cases

* **Video Summarization** -- Generate text summaries of video content
* **Object and Activity Recognition** -- Identify objects, people, and actions
* **Scene Understanding** -- Describe settings, environments, and contexts
* **Sports Analysis** -- Analyze gameplay, movements, and tactics
* **Surveillance** -- Monitor and analyze security footage
* **Educational Content** -- Analyze instructional videos and provide insights

### Provider-Specific Notes

Video URL support varies significantly by provider:

* **Google Gemini (AI Studio)** -- Only supports YouTube links (e.g., `https://www.youtube.com/watch?v=...`)
* **Google Gemini (Vertex AI)** -- Does not support video URLs; use base64-encoded data URLs instead
* **Other providers** -- Check model-specific documentation for video URL support

### Best Practices

**File size** -- Video files can be large, affecting both upload time and processing costs:

* Compress videos when possible to reduce file size without significant quality loss
* Trim videos to include only relevant segments
* Lower resolutions (e.g., 720p vs 4K) reduce file size while remaining usable for most analysis tasks
* Lower frame rates reduce file size for videos where high temporal resolution isn't critical

**Duration** -- Different models may have different limits on video length:

* Check model-specific documentation for maximum video length
* For long videos, consider splitting into shorter segments
* Focus on key moments rather than sending entire long-form content

**Quality vs. size trade-offs:**

* **High quality** (1080p+, high bitrate) -- Best for detailed visual analysis, object detection, text recognition
* **Medium quality** (720p, moderate bitrate) -- Suitable for most general analysis tasks
* **Lower quality** (480p, lower bitrate) -- Acceptable for basic scene understanding and action recognition

### Video Troubleshooting

**Video not processing?**

* Verify the model supports video input (check `input_modalities` includes `"video"`)
* If using a video URL, confirm the provider supports video URLs (see Provider-Specific Notes above)
* For Gemini on AI Studio, ensure you're using a YouTube link, not a direct video file URL
* If the video URL isn't working, try a base64-encoded data URL instead
* Check that the video format is supported
* Verify the video file isn't corrupted

**Large file errors?**

* Compress the video to reduce file size
* Reduce video resolution or frame rate
* Trim the video to a shorter duration
* Check model-specific file size limits
* Consider using a video URL (if supported by the provider) instead of base64 encoding for large files

**Poor analysis results?**

* Ensure video quality is sufficient for the task
* Provide clear, specific prompts about what to analyze
* Consider if the video duration is appropriate for the model
* Check if the video content is clearly visible and well-lit

---

## Image Generation

Generate images from text prompts using models that have `"image"` in their `output_modalities`. Specify the appropriate modalities in your request to trigger image output.

### Discovering Image Generation Models

#### Via the API

Use the `output_modalities` query parameter on the [Models API](/docs/api-reference/models/get-models):

```bash
# List only image generation models
curl "https://openrouter.ai/api/v1/models?output_modalities=image"

# List models that support both text and image output
curl "https://openrouter.ai/api/v1/models?output_modalities=text,image"
```

See [Models - Query Parameters](/docs/guides/overview/models#query-parameters) for the full list of supported modality values.

#### On the Models Page

Visit the [Models page](/models) and filter by output modalities. Look for models that list `"image"` in their output modalities.

#### In the Chatroom

In the [Chatroom](/chat), click the **Image** button to automatically filter and select models with image generation capabilities. If no image-capable model is active, you'll be prompted to add one.

### Basic Image Generation

Set the `modalities` parameter based on the model's capabilities:

* **Models that output both text and images** (e.g., Gemini) -- Use `modalities: ["image", "text"]`
* **Models that only output images** (e.g., Sourceful, Flux) -- Use `modalities: ["image"]`

<Template
  data={{
  API_KEY_REF,
  MODEL: 'google/gemini-2.5-flash-image'
}}>
  <CodeGroup>
    ```typescript title="TypeScript SDK"
    import { OpenRouter } from '@openrouter/sdk';

    const openRouter = new OpenRouter({
      apiKey: '{{API_KEY_REF}}',
    });

    const result = await openRouter.chat.send({
      model: '{{MODEL}}',
      messages: [
        {
          role: 'user',
          content: 'Generate a beautiful sunset over mountains',
        },
      ],
      modalities: ['image', 'text'],
      stream: false,
    });

    // The generated image will be in the assistant message
    if (result.choices) {
      const message = result.choices[0].message;
      if (message.images) {
        message.images.forEach((image, index) => {
          const imageUrl = image.imageUrl.url; // Base64 data URL
          console.log(`Generated image ${index + 1}: ${imageUrl.substring(0, 50)}...`);
        });
      }
    }
    ```

    ```python
    import requests
    import json

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY_REF}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "{{MODEL}}",
        "messages": [
            {
                "role": "user",
                "content": "Generate a beautiful sunset over mountains"
            }
        ],
        "modalities": ["image", "text"]
    }

    response = requests.post(url, headers=headers, json=payload)
    result = response.json()

    # The generated image will be in the assistant message
    if result.get("choices"):
        message = result["choices"][0]["message"]
        if message.get("images"):
            for image in message["images"]:
                image_url = image["image_url"]["url"]  # Base64 data URL
                print(f"Generated image: {image_url[:50]}...")
    ```

    ```typescript title="TypeScript (fetch)"
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY_REF}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: '{{MODEL}}',
        messages: [
          {
            role: 'user',
            content: 'Generate a beautiful sunset over mountains',
          },
        ],
        modalities: ['image', 'text'],
      }),
    });

    const result = await response.json();

    // The generated image will be in the assistant message
    if (result.choices) {
      const message = result.choices[0].message;
      if (message.images) {
        message.images.forEach((image, index) => {
          const imageUrl = image.image_url.url; // Base64 data URL
          console.log(`Generated image ${index + 1}: ${imageUrl.substring(0, 50)}...`);
        });
      }
    }
    ```
  </CodeGroup>
</Template>

### Configuration Options

Some image generation models support additional configuration through the `image_config` parameter.

#### Aspect Ratio

Set `image_config.aspect_ratio` to request specific aspect ratios.

**Standard aspect ratios:**

* `1:1` → 1024×1024 (default)
* `2:3` → 832×1248
* `3:2` → 1248×832
* `3:4` → 864×1184
* `4:3` → 1184×864
* `4:5` → 896×1152
* `5:4` → 1152×896
* `9:16` → 768×1344
* `16:9` → 1344×768
* `21:9` → 1536×672

**Extended aspect ratios** (supported by [`google/gemini-3.1-flash-image-preview`](/models/google/gemini-3.1-flash-image-preview) only):

* `1:4` → Tall, narrow format ideal for scrolling carousels and vertical UI elements
* `4:1` → Wide, short format for hero banners and horizontal layouts
* `1:8` → Extra-tall format for notification headers and narrow vertical spaces
* `8:1` → Extra-wide format for wide-format banners and panoramic layouts

#### Image Size

Set `image_config.image_size` to control resolution.

**Supported sizes:**

* `1K` → Standard resolution (default)
* `2K` → Higher resolution
* `4K` → Highest resolution
* `0.5K` → Lower resolution, optimized for efficiency (supported by [`google/gemini-3.1-flash-image-preview`](/models/google/gemini-3.1-flash-image-preview) only)

You can combine both `aspect_ratio` and `image_size` in the same request:

<Template
  data={{
  API_KEY_REF,
  MODEL: 'google/gemini-3-pro-image-preview'
}}>
  <CodeGroup>
    ```python
    import requests
    import json

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY_REF}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "{{MODEL}}",
        "messages": [
            {
                "role": "user",
                "content": "Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme"
            }
        ],
        "modalities": ["image", "text"],
        "image_config": {
            "aspect_ratio": "16:9",
            "image_size": "4K"
        }
    }

    response = requests.post(url, headers=headers, json=payload)
    result = response.json()

    if result.get("choices"):
        message = result["choices"][0]["message"]
        if message.get("images"):
            for image in message["images"]:
                image_url = image["image_url"]["url"]
                print(f"Generated image: {image_url[:50]}...")
    ```

    ```typescript
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY_REF}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: '{{MODEL}}',
        messages: [
          {
            role: 'user',
            content: 'Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme',
          },
        ],
        modalities: ['image', 'text'],
        image_config: {
          aspect_ratio: '16:9',
          image_size: '4K',
        },
      }),
    });

    const result = await response.json();

    if (result.choices) {
      const message = result.choices[0].message;
      if (message.images) {
        message.images.forEach((image, index) => {
          const imageUrl = image.image_url.url;
          console.log(`Generated image ${index + 1}: ${imageUrl.substring(0, 50)}...`);
        });
      }
    }
    ```
  </CodeGroup>
</Template>

#### Font Inputs (Sourceful only)

Use `image_config.font_inputs` to render custom text with specific fonts in generated images. This is only supported by Sourceful models (`sourceful/riverflow-v2-fast` and `sourceful/riverflow-v2-pro`).

Each font input is an object with:

* `font_url` (required): URL to the font file
* `text` (required): Text to render with the font

**Limits:** Maximum 2 font inputs per request. Additional cost: \$0.03 per font input.

**Example:**

```json
{
  "image_config": {
    "font_inputs": [
      {
        "font_url": "https://example.com/fonts/custom-font.ttf",
        "text": "Hello World"
      }
    ]
  }
}
```

**Tips for best results:**

* Include the text in your prompt along with details about font name, color, size, and position
* The `text` parameter should match exactly what's in your prompt -- avoid extra wording or quotation marks
* Use line breaks or double spaces to separate headlines and sub-headers when using the same font
* Works best with short, clear headlines and sub-headlines

#### Super Resolution References (Sourceful only)

Use `image_config.super_resolution_references` to enhance low-quality elements in your input image using high-quality reference images. Only supported by Sourceful models (`sourceful/riverflow-v2-fast` and `sourceful/riverflow-v2-pro`) during image-to-image generation (when input images are provided in `messages`).

**Limits:** Maximum 4 reference URLs per request. Additional cost: \$0.20 per reference.

**Example:**

```json
{
  "image_config": {
    "super_resolution_references": [
      "https://example.com/reference1.jpg",
      "https://example.com/reference2.jpg"
    ]
  }
}
```

**Tips for best results:**

* Supply an input image where the elements to enhance are present but low quality
* Use larger input images for better output quality (output matches input size)
* Use high-quality reference images that show what you want the enhanced elements to look like

### Streaming Image Generation

Image generation also works with streaming responses:

<Template
  data={{
  API_KEY_REF,
  MODEL: 'google/gemini-2.5-flash-image'
}}>
  <CodeGroup>
    ```python
    import requests
    import json

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY_REF}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "{{MODEL}}",
        "messages": [
            {
                "role": "user",
                "content": "Create an image of a futuristic city"
            }
        ],
        "modalities": ["image", "text"],
        "stream": True
    }

    response = requests.post(url, headers=headers, json=payload, stream=True)

    for line in response.iter_lines():
        if line:
            line = line.decode('utf-8')
            if line.startswith('data: '):
                data = line[6:]
                if data != '[DONE]':
                    try:
                        chunk = json.loads(data)
                        if chunk.get("choices"):
                            delta = chunk["choices"][0].get("delta", {})
                            if delta.get("images"):
                                for image in delta["images"]:
                                    print(f"Generated image: {image['image_url']['url'][:50]}...")
                    except json.JSONDecodeError:
                        continue
    ```

    ```typescript
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY_REF}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: '{{MODEL}}',
        messages: [
          {
            role: 'user',
            content: 'Create an image of a futuristic city',
          },
        ],
        modalities: ['image', 'text'],
        stream: true,
      }),
    });

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices) {
                const delta = parsed.choices[0].delta;
                if (delta?.images) {
                  delta.images.forEach((image, index) => {
                    console.log(`Generated image ${index + 1}: ${image.image_url.url.substring(0, 50)}...`);
                  });
                }
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    }
    ```
  </CodeGroup>
</Template>

### Response Format

When generating images, the assistant message includes an `images` field:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "I've generated a beautiful sunset image for you.",
        "images": [
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
            }
          }
        ]
      }
    }
  ]
}
```

* **Format**: Images are returned as base64-encoded data URLs
* **Types**: Typically PNG format (`data:image/png;base64,`)
* **Multiple Images**: Some models can generate multiple images in a single response
* **Size**: Image dimensions vary by model capabilities

### Compatible Models

Ensure the model has `"image"` in its `output_modalities`, then set the `modalities` parameter accordingly:

* `google/gemini-3.1-flash-image-preview` (supports extended aspect ratios and 0.5K resolution)
* `google/gemini-2.5-flash-image`
* `black-forest-labs/flux.2-pro`
* `black-forest-labs/flux.2-flex`
* `sourceful/riverflow-v2-standard-preview`
* Other models with image generation capabilities

### Best Practices

* **Clear Prompts** -- Provide detailed descriptions for better image quality
* **Model Selection** -- Choose models specifically designed for image generation
* **Error Handling** -- Check for the `images` field in responses before processing
* **Rate Limits** -- Image generation may have different rate limits than text generation
* **Storage** -- Consider how you'll handle and store the base64 image data

### Image Generation Troubleshooting

**No images in response?**

* Verify the model supports image generation (`output_modalities` includes `"image"`)
* Ensure you've set the `modalities` parameter correctly: `["image", "text"]` for models that output both, or `["image"]` for image-only models
* Check that your prompt is requesting image generation

**Model not found?**

* Use the [Models page](/models) to find available image generation models
* Filter by output modalities to see compatible models
