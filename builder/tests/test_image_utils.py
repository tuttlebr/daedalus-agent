"""Unit tests for nat_helpers.image_utils shared utilities."""

import json
from types import SimpleNamespace

from nat_helpers.image_utils import extract_images_from_response, parse_ref

# ---------------------------------------------------------------------------
# parse_ref
# ---------------------------------------------------------------------------


class TestParseRef:
    def test_none_returns_none(self):
        assert parse_ref(None) is None

    def test_dict_passthrough(self):
        ref = {"imageId": "abc", "sessionId": "xyz"}
        assert parse_ref(ref) is ref

    def test_valid_json_string(self):
        ref_dict = {"imageId": "abc", "sessionId": "xyz"}
        result = parse_ref(json.dumps(ref_dict))
        assert result == ref_dict

    def test_invalid_json_string_returns_none(self):
        assert parse_ref("not-valid-json{{{") is None

    def test_other_type_returns_none(self):
        assert parse_ref(42) is None


# ---------------------------------------------------------------------------
# extract_images_from_response
# ---------------------------------------------------------------------------


def _make_response(images=None, model_extra=None):
    """Build a mock chat completion response with optional images."""
    msg_attrs = {"content": "Here is the image.", "role": "assistant"}
    if images is not None:
        msg_attrs["images"] = images
    if model_extra is not None:
        msg_attrs["model_extra"] = model_extra
    message = SimpleNamespace(**msg_attrs)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


class TestExtractImagesFromResponse:
    def test_no_choices(self):
        response = SimpleNamespace(choices=[])
        assert extract_images_from_response(response) == []

    def test_no_images_field(self):
        response = _make_response()
        assert extract_images_from_response(response) == []

    def test_data_url_dict_format(self):
        images = [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="},
            }
        ]
        response = _make_response(images=images)
        result = extract_images_from_response(response)
        assert len(result) == 1
        assert result[0] == ("iVBORw0KGgo=", "image/png")

    def test_jpeg_mime_type_parsed(self):
        images = [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ"},
            }
        ]
        response = _make_response(images=images)
        result = extract_images_from_response(response)
        assert result[0][1] == "image/jpeg"

    def test_raw_base64_without_data_url(self):
        images = [{"type": "image_url", "image_url": {"url": "iVBORw0KGgo="}}]
        response = _make_response(images=images)
        result = extract_images_from_response(response)
        assert len(result) == 1
        assert result[0] == ("iVBORw0KGgo=", "image/png")

    def test_multiple_images(self):
        images = [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,img1data"},
            },
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,img2data"},
            },
        ]
        response = _make_response(images=images)
        result = extract_images_from_response(response)
        assert len(result) == 2

    def test_images_in_model_extra(self):
        images = [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,fromExtra"},
            }
        ]
        response = _make_response(model_extra={"images": images})
        result = extract_images_from_response(response)
        assert len(result) == 1
        assert result[0][0] == "fromExtra"

    def test_object_style_images(self):
        """Test extraction when images are returned as objects, not dicts."""
        img_url_obj = SimpleNamespace(url="data:image/webp;base64,webpdata")
        img_obj = SimpleNamespace(type="image_url", image_url=img_url_obj)
        response = _make_response(images=[img_obj])
        result = extract_images_from_response(response)
        assert len(result) == 1
        assert result[0] == ("webpdata", "image/webp")
