"""Unit tests for image_comprehension config."""

from image_comprehension.image_comprehension_function import (
    ImageComprehensionFunctionConfig,
)

# ---------------------------------------------------------------------------
# ImageComprehensionFunctionConfig
# ---------------------------------------------------------------------------


class TestImageComprehensionFunctionConfig:
    def test_defaults(self):
        config = ImageComprehensionFunctionConfig()
        assert config.api_endpoint == "http://localhost:8000"
        assert config.redis_url == "redis://redis:6379"
        assert config.timeout == 120.0
        assert config.max_tokens == 1024
        assert config.api_key is None

    def test_custom_model(self):
        config = ImageComprehensionFunctionConfig(model="nvidia/custom-vlm")
        assert config.model == "nvidia/custom-vlm"

    def test_custom_timeout(self):
        config = ImageComprehensionFunctionConfig(timeout=60.0)
        assert config.timeout == 60.0

    def test_api_key_set(self):
        config = ImageComprehensionFunctionConfig(api_key="test-api-key")
        assert config.api_key == "test-api-key"

    def test_custom_max_tokens(self):
        config = ImageComprehensionFunctionConfig(max_tokens=4096)
        assert config.max_tokens == 4096
