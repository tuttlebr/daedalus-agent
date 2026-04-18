"""Unit tests for image_augmentation config."""

from image_augmentation.image_augmentation_function import (
    ImageAugmentationFunctionConfig,
)

# ---------------------------------------------------------------------------
# ImageAugmentationFunctionConfig
# ---------------------------------------------------------------------------


class TestImageAugmentationFunctionConfig:
    def test_defaults(self):
        config = ImageAugmentationFunctionConfig()
        assert config.api_endpoint is None
        assert config.redis_url == "redis://redis:6379"
        assert config.timeout == 300.0
        assert config.api_key is None
        assert config.model == "gpt-image-1"
        assert config.quality is None
        assert config.input_fidelity is None
        assert config.size is None
        assert config.n is None

    def test_custom_endpoint(self):
        config = ImageAugmentationFunctionConfig(
            api_endpoint="https://my-provider.example.com/v1"
        )
        assert config.api_endpoint == "https://my-provider.example.com/v1"

    def test_custom_model(self):
        config = ImageAugmentationFunctionConfig(model="gpt-image-1.5")
        assert config.model == "gpt-image-1.5"

    def test_custom_timeout(self):
        config = ImageAugmentationFunctionConfig(timeout=60.0)
        assert config.timeout == 60.0

    def test_quality_and_input_fidelity(self):
        config = ImageAugmentationFunctionConfig(
            quality="low",
            input_fidelity="high",
        )
        assert config.quality == "low"
        assert config.input_fidelity == "high"

    def test_size(self):
        config = ImageAugmentationFunctionConfig(size="1024x1536")
        assert config.size == "1024x1536"

    def test_n(self):
        config = ImageAugmentationFunctionConfig(n=2)
        assert config.n == 2
