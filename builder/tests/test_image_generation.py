"""Unit tests for image_generation utility functions and data models."""

import pytest
from image_generation.image_generation_function import (
    ASPECT_RATIO_DIMENSIONS,
    DEFAULT_ASPECT_RATIO,
    Artifact,
    ImageGenerationFunctionConfig,
    ImageGenerationInput,
    ImageRequest,
    ImageResponse,
    OpenAIImageData,
    OpenAIImageResponse,
    TextPrompt,
)

# ---------------------------------------------------------------------------
# TextPrompt
# ---------------------------------------------------------------------------


class TestTextPrompt:
    def test_required_text(self):
        tp = TextPrompt(text="A futuristic cityscape")
        assert tp.text == "A futuristic cityscape"

    def test_default_weight(self):
        tp = TextPrompt(text="test")
        assert tp.weight == 1.0

    def test_custom_weight(self):
        tp = TextPrompt(text="test", weight=0.5)
        assert tp.weight == 0.5

    def test_missing_text_raises(self):
        with pytest.raises(Exception):
            TextPrompt()


# ---------------------------------------------------------------------------
# ImageRequest
# ---------------------------------------------------------------------------


class TestImageRequest:
    def test_valid_defaults(self):
        req = ImageRequest(prompt="A sunset")
        assert req.prompt == "A sunset"
        assert req.height == 1024
        assert req.width == 1024

    def test_valid_custom_dimensions(self):
        req = ImageRequest(prompt="Test", height=768, width=1024)
        assert req.height == 768
        assert req.width == 1024

    def test_invalid_height_raises(self):
        with pytest.raises(Exception):
            ImageRequest(prompt="Test", height=512)  # Not in supported list

    def test_invalid_width_raises(self):
        with pytest.raises(Exception):
            ImageRequest(prompt="Test", width=512)  # Not in supported list

    def test_model_dump(self):
        req = ImageRequest(prompt="Test")
        d = req.model_dump(exclude_none=True)
        assert "prompt" in d


# ---------------------------------------------------------------------------
# Artifact
# ---------------------------------------------------------------------------


class TestArtifact:
    def test_success_artifact(self):
        art = Artifact(base64="abc123==", finishReason="SUCCESS", seed=42)
        assert art.base64 == "abc123=="
        assert art.seed == 42

    def test_content_filtered(self):
        art = Artifact(base64="", finishReason="CONTENT_FILTERED", seed=0)
        assert art.finishReason == "CONTENT_FILTERED"

    def test_invalid_reason_raises(self):
        with pytest.raises(Exception):
            Artifact(base64="data", finishReason="UNKNOWN", seed=0)


# ---------------------------------------------------------------------------
# ImageResponse
# ---------------------------------------------------------------------------


class TestImageResponse:
    def test_single_artifact(self):
        art = Artifact(base64="data", finishReason="SUCCESS", seed=1)
        resp = ImageResponse(artifacts=[art])
        assert len(resp.artifacts) == 1

    def test_empty_artifacts_raises(self):
        with pytest.raises(Exception):
            ImageResponse(artifacts=[])

    def test_two_artifacts_raises(self):
        arts = [
            Artifact(base64="d1", finishReason="SUCCESS", seed=1),
            Artifact(base64="d2", finishReason="SUCCESS", seed=2),
        ]
        with pytest.raises(Exception):
            ImageResponse(artifacts=arts)


# ---------------------------------------------------------------------------
# OpenAIImageData / OpenAIImageResponse
# ---------------------------------------------------------------------------


class TestOpenAIImageData:
    def test_valid(self):
        data = OpenAIImageData(b64_json="base64encodeddata")
        assert data.b64_json == "base64encodeddata"


class TestOpenAIImageResponse:
    def test_valid(self):
        item = OpenAIImageData(b64_json="encoded")
        resp = OpenAIImageResponse(created=1700000000, data=[item])
        assert resp.created == 1700000000
        assert len(resp.data) == 1

    def test_empty_data_raises(self):
        with pytest.raises(Exception):
            OpenAIImageResponse(created=1700000000, data=[])


# ---------------------------------------------------------------------------
# ImageGenerationFunctionConfig
# ---------------------------------------------------------------------------


class TestImageGenerationFunctionConfig:
    def test_defaults(self):
        config = ImageGenerationFunctionConfig()
        assert config.api_type == "nim"
        assert config.default_width == 1024
        assert config.default_height == 1024
        assert config.default_steps == 50
        assert config.timeout == 120.0

    def test_openrouter_type(self):
        config = ImageGenerationFunctionConfig(api_type="openrouter")
        assert config.api_type == "openrouter"

    def test_openai_type(self):
        config = ImageGenerationFunctionConfig(api_type="openai")
        assert config.api_type == "openai"

    def test_invalid_type_raises(self):
        with pytest.raises(Exception):
            ImageGenerationFunctionConfig(api_type="unknown")

    def test_prompt_rewrite_none_by_default(self):
        config = ImageGenerationFunctionConfig()
        assert config.prompt_rewrite is None


# ---------------------------------------------------------------------------
# ImageGenerationInput
# ---------------------------------------------------------------------------


class TestImageGenerationInput:
    def test_required_prompt(self):
        inp = ImageGenerationInput(prompt="A mountain landscape")
        assert inp.prompt == "A mountain landscape"

    def test_optional_fields_none_by_default(self):
        inp = ImageGenerationInput(prompt="test")
        assert inp.width is None
        assert inp.height is None
        assert inp.steps is None
        assert inp.seed is None
        assert inp.cfg_scale is None
        assert inp.disable_safety_checker is None

    def test_custom_dimensions(self):
        inp = ImageGenerationInput(prompt="test", width=832, height=1248)
        assert inp.width == 832
        assert inp.height == 1248

    def test_missing_prompt_raises(self):
        with pytest.raises(Exception):
            ImageGenerationInput()


# ---------------------------------------------------------------------------
# ASPECT_RATIO_DIMENSIONS constant
# ---------------------------------------------------------------------------


class TestAspectRatioDimensions:
    def test_default_aspect_ratio_in_dict(self):
        assert DEFAULT_ASPECT_RATIO in ASPECT_RATIO_DIMENSIONS

    def test_all_values_are_tuples(self):
        for key, val in ASPECT_RATIO_DIMENSIONS.items():
            assert isinstance(val, tuple)
            assert len(val) == 2

    def test_square_1_1_present(self):
        assert "1:1" in ASPECT_RATIO_DIMENSIONS
        w, h = ASPECT_RATIO_DIMENSIONS["1:1"]
        assert w == h

    def test_widescreen_16_9_wider_than_tall(self):
        w, h = ASPECT_RATIO_DIMENSIONS["16:9"]
        assert w > h
