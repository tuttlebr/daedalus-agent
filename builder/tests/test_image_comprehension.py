"""Unit tests for image_comprehension utility functions and data models."""

import json

import pytest
from image_comprehension.image_comprehension_function import (
    ImageComprehensionFunctionConfig,
    ImageComprehensionInput,
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

    def test_custom_model(self):
        config = ImageComprehensionFunctionConfig(model="nvidia/custom-vlm")
        assert config.model == "nvidia/custom-vlm"

    def test_custom_timeout(self):
        config = ImageComprehensionFunctionConfig(timeout=60.0)
        assert config.timeout == 60.0

    def test_api_key_none_by_default(self):
        config = ImageComprehensionFunctionConfig()
        assert config.api_key is None

    def test_api_key_set(self):
        config = ImageComprehensionFunctionConfig(api_key="test-api-key")
        assert config.api_key == "test-api-key"


# ---------------------------------------------------------------------------
# ImageComprehensionInput
# ---------------------------------------------------------------------------


class TestImageComprehensionInput:
    def test_required_question(self):
        inp = ImageComprehensionInput(question="What is in this image?")
        assert inp.question == "What is in this image?"

    def test_optional_fields_none_by_default(self):
        inp = ImageComprehensionInput(question="Describe this.")
        assert inp.imageRef is None
        assert inp.image_url is None
        assert inp.videoRef is None
        assert inp.video_url is None
        assert inp.max_tokens is None

    def test_image_ref_dict(self):
        ref = {"imageId": "img123", "sessionId": "sess456"}
        inp = ImageComprehensionInput(question="Describe", imageRef=ref)
        assert inp.imageRef["imageId"] == "img123"

    def test_json_string_image_ref_parsed(self):
        ref = {"imageId": "img123", "sessionId": "sess456"}
        inp = ImageComprehensionInput(question="Describe", imageRef=json.dumps(ref))
        assert isinstance(inp.imageRef, dict)
        assert inp.imageRef["imageId"] == "img123"

    def test_json_string_video_ref_parsed(self):
        ref = {"videoId": "vid789", "sessionId": "sess456"}
        inp = ImageComprehensionInput(
            question="Describe video", videoRef=json.dumps(ref)
        )
        assert isinstance(inp.videoRef, dict)
        assert inp.videoRef["videoId"] == "vid789"

    def test_image_url_field(self):
        inp = ImageComprehensionInput(
            question="What text is here?",
            image_url="https://example.com/image.png",
        )
        assert inp.image_url == "https://example.com/image.png"

    def test_video_url_field(self):
        inp = ImageComprehensionInput(
            question="What happens?",
            video_url="https://example.com/video.mp4",
        )
        assert inp.video_url == "https://example.com/video.mp4"

    def test_max_tokens_set(self):
        inp = ImageComprehensionInput(question="Describe", max_tokens=2048)
        assert inp.max_tokens == 2048

    def test_missing_question_raises(self):
        with pytest.raises(Exception):
            ImageComprehensionInput()

    def test_invalid_json_image_ref_raises_validation_error(self):
        # _parse_json_string returns the raw string on bad JSON, but Pydantic
        # then validates imageRef: dict | None and rejects a plain string.
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            ImageComprehensionInput(question="test", imageRef="not valid json{")
