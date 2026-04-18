"""Unit tests for nat_helpers.image_utils shared utilities."""

import json

from nat_helpers.image_utils import parse_ref

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
