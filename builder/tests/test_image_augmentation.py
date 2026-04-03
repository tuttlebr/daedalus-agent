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
        assert config.image_config is None

    def test_custom_endpoint(self):
        config = ImageAugmentationFunctionConfig(
            api_endpoint="https://my-provider.example.com/v1"
        )
        assert config.api_endpoint == "https://my-provider.example.com/v1"

    def test_custom_model(self):
        config = ImageAugmentationFunctionConfig(model="google/gemini-2.5-flash-image")
        assert config.model == "google/gemini-2.5-flash-image"

    def test_image_config(self):
        config = ImageAugmentationFunctionConfig(
            image_config={"aspect_ratio": "4:3", "image_size": "1K"}
        )
        assert config.image_config["aspect_ratio"] == "4:3"
        assert config.image_config["image_size"] == "1K"

    def test_custom_timeout(self):
        config = ImageAugmentationFunctionConfig(timeout=60.0)
        assert config.timeout == 60.0
