"""Unit tests for image_generation config and image_utils shared helpers."""

from image_generation.image_generation_function import ImageGenerationFunctionConfig

# ---------------------------------------------------------------------------
# ImageGenerationFunctionConfig
# ---------------------------------------------------------------------------


class TestImageGenerationFunctionConfig:
    def test_defaults(self):
        config = ImageGenerationFunctionConfig()
        assert config.api_endpoint is None
        assert config.api_key is None
        assert config.timeout == 120.0
        assert config.model == "gpt-image-1"
        assert config.prompt_rewrite is None
        assert config.redis_url == "redis://redis:6379"
        assert config.image_config is None

    def test_custom_endpoint(self):
        config = ImageGenerationFunctionConfig(
            api_endpoint="https://my-provider.example.com/v1"
        )
        assert config.api_endpoint == "https://my-provider.example.com/v1"

    def test_custom_model(self):
        config = ImageGenerationFunctionConfig(model="google/gemini-2.5-flash-image")
        assert config.model == "google/gemini-2.5-flash-image"

    def test_image_config(self):
        config = ImageGenerationFunctionConfig(
            image_config={"aspect_ratio": "16:9", "image_size": "2K"}
        )
        assert config.image_config["aspect_ratio"] == "16:9"
        assert config.image_config["image_size"] == "2K"

    def test_prompt_rewrite_config(self):
        config = ImageGenerationFunctionConfig(
            prompt_rewrite={
                "llm": "balanced_llm",
                "system_prompt": "Rewrite prompt for image gen",
                "max_tokens": 256,
                "temperature": 0.2,
            }
        )
        assert config.prompt_rewrite["llm"] == "balanced_llm"
        assert config.prompt_rewrite["max_tokens"] == 256
