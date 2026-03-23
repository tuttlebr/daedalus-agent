"""Unit tests for image_augmentation utility functions and data models."""

import pytest
from image_augmentation.image_augmentation_function import (
    VALID_DIMENSION_PAIRS,
    Artifact,
    ImageAugmentationFunctionConfig,
    ImageAugmentationInput,
    ImageResponse,
    find_closest_dimension_pair,
)

# ---------------------------------------------------------------------------
# find_closest_dimension_pair
# ---------------------------------------------------------------------------


class TestFindClosestDimensionPair:
    def test_exact_match_returned(self):
        # 1024x1024 is in the valid list
        w, h = find_closest_dimension_pair(1024, 1024)
        assert w == 1024
        assert h == 1024

    def test_returns_tuple_from_valid_list(self):
        w, h = find_closest_dimension_pair(800, 600)
        assert (w, h) in VALID_DIMENSION_PAIRS

    def test_square_prefers_square(self):
        w, h = find_closest_dimension_pair(1000, 1000)
        # Should return a close-to-square pair; 1024x1024 is in the list
        assert (w, h) in VALID_DIMENSION_PAIRS

    def test_portrait_orientation(self):
        w, h = find_closest_dimension_pair(720, 1440)
        # Should return a portrait (height > width) pair
        assert h > w

    def test_landscape_orientation(self):
        w, h = find_closest_dimension_pair(1440, 720)
        # Should return a landscape (width > height) pair
        assert w > h

    def test_always_returns_valid_pair(self):
        for test_w, test_h in [(512, 512), (100, 200), (2000, 1500)]:
            result = find_closest_dimension_pair(test_w, test_h)
            assert result in VALID_DIMENSION_PAIRS


# ---------------------------------------------------------------------------
# Artifact model
# ---------------------------------------------------------------------------


class TestArtifact:
    def test_valid_success_artifact(self):
        art = Artifact(base64="abc123", finishReason="SUCCESS", seed=42)
        assert art.base64 == "abc123"
        assert art.finishReason == "SUCCESS"
        assert art.seed == 42

    def test_content_filtered_reason(self):
        art = Artifact(base64="xyz", finishReason="CONTENT_FILTERED", seed=0)
        assert art.finishReason == "CONTENT_FILTERED"

    def test_error_reason(self):
        art = Artifact(base64="", finishReason="ERROR", seed=0)
        assert art.finishReason == "ERROR"

    def test_invalid_finish_reason_raises(self):
        with pytest.raises(Exception):
            Artifact(base64="abc", finishReason="INVALID", seed=0)


# ---------------------------------------------------------------------------
# ImageResponse model
# ---------------------------------------------------------------------------


class TestImageResponse:
    def test_valid_single_artifact(self):
        art = Artifact(base64="data", finishReason="SUCCESS", seed=1)
        resp = ImageResponse(artifacts=[art])
        assert len(resp.artifacts) == 1
        assert resp.artifacts[0].seed == 1

    def test_empty_artifacts_raises(self):
        with pytest.raises(Exception):
            ImageResponse(artifacts=[])

    def test_too_many_artifacts_raises(self):
        arts = [
            Artifact(base64=f"d{i}", finishReason="SUCCESS", seed=i) for i in range(2)
        ]
        with pytest.raises(Exception):
            ImageResponse(artifacts=arts)


# ---------------------------------------------------------------------------
# ImageAugmentationFunctionConfig
# ---------------------------------------------------------------------------


class TestImageAugmentationFunctionConfig:
    def test_default_api_type_nim(self):
        config = ImageAugmentationFunctionConfig()
        assert config.api_type == "nim"

    def test_openrouter_type(self):
        config = ImageAugmentationFunctionConfig(api_type="openrouter")
        assert config.api_type == "openrouter"

    def test_openai_type(self):
        config = ImageAugmentationFunctionConfig(api_type="openai")
        assert config.api_type == "openai"

    def test_invalid_api_type_raises(self):
        with pytest.raises(Exception):
            ImageAugmentationFunctionConfig(api_type="invalid")

    def test_defaults(self):
        config = ImageAugmentationFunctionConfig()
        assert config.default_steps == 30
        assert config.default_seed == 42
        assert config.timeout == 300.0

    def test_custom_values(self):
        config = ImageAugmentationFunctionConfig(
            api_type="nim",
            api_endpoint="http://my-api:8080",
            redis_url="redis://localhost:6379",
            default_steps=50,
        )
        assert config.default_steps == 50
        assert config.api_endpoint == "http://my-api:8080"


# ---------------------------------------------------------------------------
# ImageAugmentationInput
# ---------------------------------------------------------------------------


class TestImageAugmentationInput:
    def test_required_prompt(self):
        inp = ImageAugmentationInput(prompt="Add a sunset background")
        assert inp.prompt == "Add a sunset background"

    def test_optional_image_ref_none(self):
        inp = ImageAugmentationInput(prompt="test")
        assert inp.imageRef is None

    def test_dict_image_ref(self):
        ref = {"imageId": "abc123", "sessionId": "sess456"}
        inp = ImageAugmentationInput(prompt="edit", imageRef=ref)
        assert inp.imageRef["imageId"] == "abc123"

    def test_json_string_image_ref_parsed(self):
        import json

        ref_dict = {"imageId": "abc123", "sessionId": "sess456"}
        inp = ImageAugmentationInput(prompt="edit", imageRef=json.dumps(ref_dict))
        assert isinstance(inp.imageRef, dict)
        assert inp.imageRef["imageId"] == "abc123"

    def test_invalid_json_string_raises_validation_error(self):
        # _parse_json_string returns the raw string on bad JSON, but Pydantic
        # then validates imageRef: dict | list[dict] | None and rejects a plain string.
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            ImageAugmentationInput(prompt="edit", imageRef="not-json{{{")

    def test_missing_prompt_raises(self):
        with pytest.raises(Exception):
            ImageAugmentationInput()
