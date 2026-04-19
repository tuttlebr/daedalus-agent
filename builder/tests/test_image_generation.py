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
        assert config.model == "gpt-image-1.5"
        assert config.prompt_rewrite is None
        assert config.redis_url == "redis://redis:6379"
        assert config.quality is None
        assert config.size is None
        assert config.n is None

    def test_custom_endpoint(self):
        config = ImageGenerationFunctionConfig(
            api_endpoint="https://my-provider.example.com/v1"
        )
        assert config.api_endpoint == "https://my-provider.example.com/v1"

    def test_custom_model(self):
        config = ImageGenerationFunctionConfig(model="gpt-image-1")
        assert config.model == "gpt-image-1"

    def test_quality(self):
        config = ImageGenerationFunctionConfig(quality="high")
        assert config.quality == "high"

    def test_size(self):
        config = ImageGenerationFunctionConfig(size="1536x1024")
        assert config.size == "1536x1024"

    def test_n(self):
        config = ImageGenerationFunctionConfig(n=4)
        assert config.n == 4

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
