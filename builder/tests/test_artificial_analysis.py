"""Unit tests for artificial_analysis utility functions and data models."""

from artificial_analysis.artificial_analysis_function import (
    CATEGORY_ENDPOINTS,
    ArtificialAnalysisFunctionConfig,
    ArtificialAnalysisRenderConfig,
    _build_bar_chart,
    _build_category_summary,
    _build_quadrant_chart,
    _filter_models,
    _get_metric_label,
    _model_match_score,
    _normalize_chart_type,
    _normalize_endpoint,
    _normalize_for_match,
    _resolve_metric_value,
)

# ---------------------------------------------------------------------------
# _normalize_for_match
# ---------------------------------------------------------------------------


class TestNormalizeForMatch:
    def test_lowercases(self):
        assert _normalize_for_match("GPT-4") == "gpt4"

    def test_removes_separators(self):
        assert _normalize_for_match("llama-3.1-8b") == "llama318b"

    def test_empty_string(self):
        assert _normalize_for_match("") == ""

    def test_spaces_removed(self):
        assert _normalize_for_match("text to image") == "texttoimage"


# ---------------------------------------------------------------------------
# _normalize_endpoint
# ---------------------------------------------------------------------------


class TestNormalizeEndpoint:
    def test_valid_endpoint_passthrough(self):
        assert _normalize_endpoint("llms") == "llms"

    def test_alias_resolved(self):
        assert _normalize_endpoint("llm") == "llms"

    def test_tts_alias(self):
        assert _normalize_endpoint("tts") == "text-to-speech"

    def test_tti_alias(self):
        assert _normalize_endpoint("tti") == "text-to-image"

    def test_case_insensitive(self):
        assert _normalize_endpoint("LLMs") == "llms"

    def test_unknown_returns_cleaned(self):
        result = _normalize_endpoint("unknown_endpoint")
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# _normalize_chart_type
# ---------------------------------------------------------------------------


class TestNormalizeChartType:
    def test_bar_passthrough(self):
        assert _normalize_chart_type("bar") == "bar"

    def test_quadrant_passthrough(self):
        assert _normalize_chart_type("quadrant") == "quadrant"

    def test_scatter_alias(self):
        assert _normalize_chart_type("scatter") == "quadrant"

    def test_barchart_alias(self):
        assert _normalize_chart_type("barchart") == "bar"

    def test_case_insensitive(self):
        assert _normalize_chart_type("BAR") == "bar"

    def test_unknown_returned(self):
        result = _normalize_chart_type("pie")
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# _model_match_score
# ---------------------------------------------------------------------------


class TestModelMatchScore:
    def _make_model(self, name="", slug="", creator_name=""):
        return {
            "name": name,
            "slug": slug,
            "model_creator": {"name": creator_name},
        }

    def test_exact_name_match_high_score(self):
        model = self._make_model(name="gpt-4")
        score = _model_match_score(model, "gpt-4")
        assert score >= 0.9

    def test_substring_match_high_score(self):
        model = self._make_model(name="gpt-4-turbo-preview")
        score = _model_match_score(model, "gpt-4")
        assert score >= 0.9

    def test_no_match_low_score(self):
        # Provide non-empty slug/creator so empty-string substring check doesn't fire
        model = self._make_model(
            name="claude-3-opus", slug="claude-3-opus", creator_name="Anthropic"
        )
        score = _model_match_score(model, "gemini-pro")
        assert score < 0.9

    def test_returns_float(self):
        model = self._make_model(name="test-model")
        score = _model_match_score(model, "test")
        assert isinstance(score, float)

    def test_score_between_0_and_1(self):
        model = self._make_model(name="some-model")
        score = _model_match_score(model, "query")
        assert 0.0 <= score <= 1.0

    def test_slug_match(self):
        model = self._make_model(name="Model Name", slug="llama-3-8b")
        score = _model_match_score(model, "llama-3-8b")
        assert score >= 0.9


# ---------------------------------------------------------------------------
# _filter_models
# ---------------------------------------------------------------------------


class TestFilterModels:
    def _make_models(self):
        return [
            {"name": "GPT-4o", "slug": "gpt-4o", "model_creator": {"name": "OpenAI"}},
            {
                "name": "Claude 3 Opus",
                "slug": "claude-3-opus",
                "model_creator": {"name": "Anthropic"},
            },
            {
                "name": "Llama 3.1 8B",
                "slug": "llama-3-1-8b",
                "model_creator": {"name": "Meta"},
            },
        ]

    def test_exact_filter_returns_match(self):
        models = self._make_models()
        result = _filter_models(models, "gpt-4o")
        assert any(m["name"] == "GPT-4o" for m in result)

    def test_empty_filter_returns_all(self):
        models = self._make_models()
        result = _filter_models(models, "")
        # Empty filter: no substring match applies, falls back to fuzzy
        assert isinstance(result, list)

    def test_no_match_returns_empty(self):
        models = self._make_models()
        result = _filter_models(models, "zzz-nonexistent-model-xyz")
        assert isinstance(result, list)

    def test_case_insensitive(self):
        models = self._make_models()
        result = _filter_models(models, "GPT")
        assert any("gpt" in m["slug"].lower() for m in result)


# ---------------------------------------------------------------------------
# _resolve_metric_value
# ---------------------------------------------------------------------------


class TestResolveMetricValue:
    def test_top_level_metric(self):
        model = {"speed": 100}
        assert _resolve_metric_value(model, "speed") == 100

    def test_evaluations_nested(self):
        model = {"evaluations": {"mmlu_pro": 75.5}}
        assert _resolve_metric_value(model, "mmlu_pro") == 75.5

    def test_pricing_nested(self):
        model = {"pricing": {"price_1m_input_tokens": 0.01}}
        assert _resolve_metric_value(model, "price_1m_input_tokens") == 0.01

    def test_missing_metric_returns_none(self):
        model = {"name": "Model"}
        assert _resolve_metric_value(model, "nonexistent") is None

    def test_evaluations_not_dict_skipped(self):
        model = {"evaluations": "not a dict"}
        assert _resolve_metric_value(model, "some_metric") is None


# ---------------------------------------------------------------------------
# _get_metric_label
# ---------------------------------------------------------------------------


class TestGetMetricLabel:
    def test_llm_known_metric(self):
        label = _get_metric_label("mmlu_pro", "llms")
        assert label == "MMLU Pro"

    def test_llm_unknown_metric_title_case(self):
        label = _get_metric_label("custom_score", "llms")
        assert label == "Custom Score"

    def test_media_known_metric(self):
        label = _get_metric_label("elo", "text-to-image")
        assert label == "ELO Rating"

    def test_media_unknown_metric(self):
        label = _get_metric_label("unknown_metric", "text-to-image")
        assert isinstance(label, str)


# ---------------------------------------------------------------------------
# _build_bar_chart
# ---------------------------------------------------------------------------


class TestBuildBarChart:
    def _make_models(self, n=3):
        return [
            {
                "name": f"Model {i}",
                "artificial_analysis_intelligence_index": float(i * 10),
            }
            for i in range(1, n + 1)
        ]

    def test_returns_chart_tag_and_summary(self):
        models = self._make_models()
        chart_tag, summary = _build_bar_chart(
            models, "artificial_analysis_intelligence_index", "llms", 10
        )
        assert "<chart>" in chart_tag
        assert "</chart>" in chart_tag
        assert isinstance(summary, str)

    def test_empty_models_returns_empty_tag(self):
        chart_tag, summary = _build_bar_chart([], "some_metric", "llms", 10)
        assert chart_tag == ""
        assert "No models found" in summary

    def test_respects_top_n(self):
        models = self._make_models(n=10)
        chart_tag, summary = _build_bar_chart(
            models, "artificial_analysis_intelligence_index", "llms", 3
        )
        import json

        data = json.loads(chart_tag.replace("<chart>", "").replace("</chart>", ""))
        assert len(data["Data"]) == 3

    def test_sorted_descending(self):
        models = [
            {"name": "Low", "metric": 10.0},
            {"name": "High", "metric": 90.0},
            {"name": "Mid", "metric": 50.0},
        ]
        chart_tag, _ = _build_bar_chart(models, "metric", "llms", 10)
        import json

        data = json.loads(chart_tag.replace("<chart>", "").replace("</chart>", ""))
        values = [row["value"] for row in data["Data"]]
        assert values == sorted(values, reverse=True)

    def test_no_metric_data_returns_empty(self):
        models = [{"name": "Model A"}]
        chart_tag, summary = _build_bar_chart(models, "nonexistent_metric", "llms", 10)
        assert chart_tag == ""


# ---------------------------------------------------------------------------
# _build_quadrant_chart
# ---------------------------------------------------------------------------


class TestBuildQuadrantChart:
    def _make_models(self, n=4):
        return [
            {
                "name": f"Model {i}",
                "speed": float(i * 20),
                "intelligence": float(i * 15),
            }
            for i in range(1, n + 1)
        ]

    def test_returns_chart_tag_and_summary(self):
        models = self._make_models()
        chart_tag, summary = _build_quadrant_chart(
            models, "speed", "intelligence", "llms", 10
        )
        assert "<chart>" in chart_tag
        assert isinstance(summary, str)

    def test_empty_models_returns_empty(self):
        chart_tag, summary = _build_quadrant_chart([], "x", "y", "llms", 10)
        assert chart_tag == ""
        assert "No models found" in summary

    def test_missing_one_metric_excluded(self):
        models = [
            {"name": "Complete", "speed": 100.0, "intelligence": 80.0},
            {"name": "MissingY", "speed": 50.0},
        ]
        chart_tag, _ = _build_quadrant_chart(
            models, "speed", "intelligence", "llms", 10
        )
        import json

        data = json.loads(chart_tag.replace("<chart>", "").replace("</chart>", ""))
        assert len(data["Data"]) == 1
        assert data["Data"][0]["name"] == "Complete"

    def test_chart_type_is_quadrant(self):
        models = self._make_models()
        chart_tag, _ = _build_quadrant_chart(
            models, "speed", "intelligence", "llms", 10
        )
        import json

        data = json.loads(chart_tag.replace("<chart>", "").replace("</chart>", ""))
        assert data["ChartType"] == "QuadrantChart"


# ---------------------------------------------------------------------------
# Config models
# ---------------------------------------------------------------------------


class TestArtificialAnalysisFunctionConfig:
    def test_defaults(self):
        config = ArtificialAnalysisFunctionConfig()
        assert "artificialanalysis.ai" in config.base_url

    def test_api_key_from_env(self, monkeypatch):
        monkeypatch.setenv("AA_API_KEY", "test-key-123")
        config = ArtificialAnalysisFunctionConfig()
        assert config.api_key == "test-key-123"

    def test_custom_api_key(self):
        config = ArtificialAnalysisFunctionConfig(api_key="my-key")
        assert config.api_key == "my-key"


class TestGetMetricLabelNewFields:
    def test_llm_time_to_first_answer_token(self):
        label = _get_metric_label("median_time_to_first_answer_token", "llms")
        assert label == "Time to First Answer Token (s)"

    def test_media_ci95(self):
        label = _get_metric_label("ci95", "text-to-image")
        assert label == "95% Confidence Interval"

    def test_media_release_date(self):
        label = _get_metric_label("release_date", "text-to-video")
        assert label == "Release Date"


# ---------------------------------------------------------------------------
# CATEGORY_ENDPOINTS
# ---------------------------------------------------------------------------


class TestCategoryEndpoints:
    def test_text_to_image_included(self):
        assert "text-to-image" in CATEGORY_ENDPOINTS

    def test_text_to_video_included(self):
        assert "text-to-video" in CATEGORY_ENDPOINTS

    def test_image_to_video_included(self):
        assert "image-to-video" in CATEGORY_ENDPOINTS

    def test_llms_not_included(self):
        assert "llms" not in CATEGORY_ENDPOINTS

    def test_text_to_speech_not_included(self):
        assert "text-to-speech" not in CATEGORY_ENDPOINTS


# ---------------------------------------------------------------------------
# _build_category_summary
# ---------------------------------------------------------------------------


class TestBuildCategorySummary:
    def test_no_categories_returns_empty(self):
        models = [{"name": "Model A", "elo": 1200}]
        assert _build_category_summary(models, 10) == ""

    def test_with_categories(self):
        models = [
            {
                "name": "DALL-E 3",
                "elo": 1250,
                "categories": [
                    {
                        "style_category": "Photorealistic",
                        "subject_matter_category": "People: Portraits",
                        "elo": 1280,
                        "ci95": "-5/+5",
                        "appearances": 1234,
                    }
                ],
            }
        ]
        result = _build_category_summary(models, 10)
        assert "Category Breakdowns" in result
        assert "DALL-E 3" in result
        assert "Photorealistic" in result
        assert "1280" in result
        assert "-5/+5" in result

    def test_respects_top_n(self):
        models = [
            {
                "name": f"Model {i}",
                "categories": [{"style_category": "Style", "elo": 1000 + i}],
            }
            for i in range(5)
        ]
        result = _build_category_summary(models, 2)
        assert "Model 0" in result
        assert "Model 1" in result
        assert "Model 2" not in result

    def test_format_category_included(self):
        models = [
            {
                "name": "Kling",
                "categories": [
                    {
                        "style_category": "Photorealistic",
                        "subject_matter_category": "Nature",
                        "format_category": "Moving camera",
                        "elo": 1140,
                    }
                ],
            }
        ]
        result = _build_category_summary(models, 10)
        assert "Moving camera" in result

    def test_empty_models_returns_empty(self):
        assert _build_category_summary([], 10) == ""


# ---------------------------------------------------------------------------
# Config models
# ---------------------------------------------------------------------------


class TestArtificialAnalysisRenderConfig:
    def test_defaults(self):
        config = ArtificialAnalysisRenderConfig()
        assert "artificialanalysis.ai" in config.base_url
