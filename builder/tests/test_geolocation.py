"""Unit tests for nat_helpers.geolocation module."""

import pytest
from nat_helpers.geolocation import GeolocationResult, _as_mapping, _extract_results

# ---------------------------------------------------------------------------
# _as_mapping
# ---------------------------------------------------------------------------


class TestAsMapping:
    def test_dict_returns_same_dict(self):
        d = {"key": "value"}
        assert _as_mapping(d) is d

    def test_object_with_dict_attrs(self):
        class Obj:
            def __init__(self):
                self.foo = "bar"
                self.num = 42

        result = _as_mapping(Obj())
        assert result is not None
        assert result["foo"] == "bar"
        assert result["num"] == 42

    def test_none_returns_none(self):
        assert _as_mapping(None) is None

    def test_string_returns_none(self):
        assert _as_mapping("not a mapping") is None

    def test_integer_returns_none(self):
        assert _as_mapping(42) is None

    def test_list_returns_none(self):
        assert _as_mapping([1, 2, 3]) is None

    def test_empty_dict(self):
        result = _as_mapping({})
        assert result == {}

    def test_nested_dict(self):
        d = {"a": {"b": 1}}
        assert _as_mapping(d) is d


# ---------------------------------------------------------------------------
# _extract_results
# ---------------------------------------------------------------------------


class TestExtractResults:
    def test_dict_with_results_key(self):
        payload = {
            "results": [
                {"page_content": "doc1", "metadata": {}},
                {"page_content": "doc2", "metadata": {}},
            ]
        }
        results = _extract_results(payload)
        assert len(results) == 2

    def test_empty_results_list(self):
        results = _extract_results({"results": []})
        assert results == []

    def test_no_results_key(self):
        results = _extract_results({"other": "data"})
        assert results == []

    def test_none_payload(self):
        results = _extract_results(None)
        assert results == []

    def test_string_payload(self):
        results = _extract_results("not a payload")
        assert results == []

    def test_non_mapping_items_skipped(self):
        payload = {"results": ["string", 42, {"valid": "dict"}]}
        results = _extract_results(payload)
        assert len(results) == 1
        assert results[0]["valid"] == "dict"

    def test_object_with_results_attribute(self):
        class PayloadObj:
            results = [{"page_content": "x", "metadata": {}}]

        results = _extract_results(PayloadObj())
        assert len(results) == 1

    def test_object_results_attribute_with_non_mappings(self):
        class PayloadObj:
            results = ["string", {"valid": "dict"}, None]

        results = _extract_results(PayloadObj())
        assert len(results) == 1

    def test_empty_object_results(self):
        class PayloadObj:
            results = []

        results = _extract_results(PayloadObj())
        assert results == []

    def test_mapping_results_takes_precedence(self):
        """When payload is a dict with 'results', use it (don't fall through)."""

        class PayloadObj:
            results = [{"should_not": "appear"}]

        # Dict wrapping the object won't trigger the attribute path
        payload = {"results": [{"page_content": "from_dict"}]}
        results = _extract_results(payload)
        assert len(results) == 1
        assert results[0]["page_content"] == "from_dict"


# ---------------------------------------------------------------------------
# GeolocationResult.from_retriever_output
# ---------------------------------------------------------------------------


def _make_payload(
    lat=48.8566,
    lon=2.3522,
    name="Paris",
    country_code="FR",
    page_content=None,
):
    return {
        "results": [
            {
                "page_content": page_content or name,
                "metadata": {
                    "gps_latitude": lat,
                    "gps_longitude": lon,
                    "name": name,
                    "country_code": country_code,
                },
            }
        ]
    }


class TestGeolocationResultFromRetrieverOutput:
    def test_valid_full_payload(self):
        result = GeolocationResult.from_retriever_output(_make_payload())
        assert result is not None
        assert result.name == "Paris"
        assert result.latitude == pytest.approx(48.8566)
        assert result.longitude == pytest.approx(2.3522)
        assert result.country_code == "FR"

    def test_empty_results_returns_none(self):
        assert GeolocationResult.from_retriever_output({"results": []}) is None

    def test_none_payload_returns_none(self):
        assert GeolocationResult.from_retriever_output(None) is None

    def test_missing_gps_coords_returns_none(self):
        payload = {
            "results": [{"page_content": "Place", "metadata": {"name": "Place"}}]
        }
        assert GeolocationResult.from_retriever_output(payload) is None

    def test_missing_latitude_returns_none(self):
        payload = {
            "results": [
                {
                    "metadata": {
                        "gps_longitude": 2.3522,
                        "name": "Paris",
                    }
                }
            ]
        }
        assert GeolocationResult.from_retriever_output(payload) is None

    def test_missing_longitude_returns_none(self):
        payload = {
            "results": [
                {
                    "metadata": {
                        "gps_latitude": 48.8566,
                        "name": "Paris",
                    }
                }
            ]
        }
        assert GeolocationResult.from_retriever_output(payload) is None

    def test_invalid_coords_returns_none(self):
        payload = {
            "results": [
                {
                    "metadata": {
                        "gps_latitude": "not-a-number",
                        "gps_longitude": "also-not",
                        "name": "Place",
                    }
                }
            ]
        }
        assert GeolocationResult.from_retriever_output(payload) is None

    def test_string_coords_coerced_to_float(self):
        payload = {
            "results": [
                {
                    "metadata": {
                        "gps_latitude": "48.8566",
                        "gps_longitude": "2.3522",
                        "name": "Paris",
                    }
                }
            ]
        }
        result = GeolocationResult.from_retriever_output(payload)
        assert result is not None
        assert isinstance(result.latitude, float)
        assert isinstance(result.longitude, float)

    def test_name_from_metadata(self):
        payload = _make_payload(name="Berlin", country_code="DE")
        result = GeolocationResult.from_retriever_output(payload)
        assert result is not None
        assert result.name == "Berlin"

    def test_name_fallback_to_page_content(self):
        payload = {
            "results": [
                {
                    "page_content": "Fallback City",
                    "metadata": {
                        "gps_latitude": 10.0,
                        "gps_longitude": 20.0,
                        # no 'name' key
                    },
                }
            ]
        }
        result = GeolocationResult.from_retriever_output(payload)
        assert result is not None
        assert result.name == "Fallback City"

    def test_name_fallback_to_unknown(self):
        payload = {
            "results": [
                {
                    "metadata": {
                        "gps_latitude": 10.0,
                        "gps_longitude": 20.0,
                    }
                }
            ]
        }
        result = GeolocationResult.from_retriever_output(payload)
        assert result is not None
        assert result.name == "Unknown"

    def test_empty_string_name_falls_through_to_page_content(self):
        payload = {
            "results": [
                {
                    "page_content": "Real Name",
                    "metadata": {
                        "gps_latitude": 10.0,
                        "gps_longitude": 20.0,
                        "name": "   ",  # whitespace only
                    },
                }
            ]
        }
        result = GeolocationResult.from_retriever_output(payload)
        assert result is not None
        assert result.name == "Real Name"

    def test_no_country_code(self):
        payload = {
            "results": [
                {
                    "metadata": {
                        "gps_latitude": 10.0,
                        "gps_longitude": 20.0,
                        "name": "City",
                    }
                }
            ]
        }
        result = GeolocationResult.from_retriever_output(payload)
        assert result is not None
        assert result.country_code is None

    def test_empty_country_code_treated_as_none(self):
        payload = {
            "results": [
                {
                    "metadata": {
                        "gps_latitude": 10.0,
                        "gps_longitude": 20.0,
                        "name": "City",
                        "country_code": "",
                    }
                }
            ]
        }
        result = GeolocationResult.from_retriever_output(payload)
        assert result is not None
        assert result.country_code is None

    def test_metadata_stored_on_result(self):
        result = GeolocationResult.from_retriever_output(_make_payload())
        assert result is not None
        assert isinstance(result.metadata, dict)
        assert "gps_latitude" in result.metadata

    def test_page_content_stored_in_metadata(self):
        result = GeolocationResult.from_retriever_output(
            _make_payload(page_content="Custom page content")
        )
        assert result is not None
        assert result.metadata is not None
        assert result.metadata.get("page_content") == "Custom page content"


# ---------------------------------------------------------------------------
# GeolocationResult.display_name
# ---------------------------------------------------------------------------


class TestDisplayName:
    def test_display_name_from_metadata_page_content(self):
        result = GeolocationResult(
            name="Paris",
            latitude=48.8566,
            longitude=2.3522,
            metadata={"page_content": "Paris, France"},
        )
        assert result.display_name == "Paris, France"

    def test_display_name_falls_back_to_name_when_no_page_content(self):
        result = GeolocationResult(
            name="Paris",
            latitude=48.8566,
            longitude=2.3522,
            metadata={"other_key": "value"},
        )
        assert result.display_name == "Paris"

    def test_display_name_with_no_metadata(self):
        result = GeolocationResult(
            name="Tokyo",
            latitude=35.6762,
            longitude=139.6503,
        )
        assert result.display_name == "Tokyo"

    def test_display_name_none_metadata(self):
        result = GeolocationResult(
            name="Berlin",
            latitude=52.5200,
            longitude=13.4050,
            metadata=None,
        )
        assert result.display_name == "Berlin"

    def test_display_name_none_page_content_in_metadata(self):
        result = GeolocationResult(
            name="Rome",
            latitude=41.9028,
            longitude=12.4964,
            metadata={"page_content": None},
        )
        assert result.display_name == "Rome"
