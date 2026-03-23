import json
import logging
import os
from difflib import SequenceMatcher
from statistics import median

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

VALID_ENDPOINTS = (
    "llms",
    "text-to-image",
    "text-to-speech",
    "text-to-video",
    "image-to-video",
    "image-editing",
)

ENDPOINT_PATHS: dict[str, str] = {
    "llms": "/data/llms/models",
    "text-to-image": "/data/media/text-to-image",
    "text-to-speech": "/data/media/text-to-speech",
    "text-to-video": "/data/media/text-to-video",
    "image-to-video": "/data/media/image-to-video",
    "image-editing": "/data/media/image-editing",
}

ENDPOINT_ALIASES: dict[str, str] = {
    "llm": "llms",
    "models": "llms",
    "language_models": "llms",
    "text_to_image": "text-to-image",
    "text_to_speech": "text-to-speech",
    "text_to_video": "text-to-video",
    "image_to_video": "image-to-video",
    "image_editing": "image-editing",
    "tts": "text-to-speech",
    "tti": "text-to-image",
    "ttv": "text-to-video",
    "itv": "image-to-video",
}

CATEGORY_ENDPOINTS = frozenset({"text-to-image", "text-to-video", "image-to-video"})

CHART_TYPE_ALIASES: dict[str, str] = {
    "barchart": "bar",
    "bar_chart": "bar",
    "scatter": "quadrant",
    "scatterplot": "quadrant",
    "scatter_plot": "quadrant",
    "quadrant_chart": "quadrant",
}


def _normalize_endpoint(raw: str) -> str:
    """Normalize endpoint input to a canonical value, tolerating case and formatting variants."""
    cleaned = raw.strip().lower().replace(" ", "-").replace("_", "-")
    if cleaned in VALID_ENDPOINTS:
        return cleaned
    alias_key = raw.strip().lower().replace(" ", "_").replace("-", "_")
    if alias_key in ENDPOINT_ALIASES:
        return ENDPOINT_ALIASES[alias_key]
    return cleaned


def _normalize_chart_type(raw: str) -> str:
    """Normalize chart_type input to 'bar' or 'quadrant'."""
    cleaned = raw.strip().lower().replace(" ", "_").replace("-", "_")
    if cleaned in ("bar", "quadrant"):
        return cleaned
    return CHART_TYPE_ALIASES.get(cleaned, cleaned)


LLM_METRIC_LABELS: dict[str, str] = {
    "artificial_analysis_intelligence_index": "Intelligence Index",
    "artificial_analysis_coding_index": "Coding Index",
    "artificial_analysis_math_index": "Math Index",
    "mmlu_pro": "MMLU Pro",
    "gpqa": "GPQA",
    "hle": "HLE",
    "livecodebench": "LiveCodeBench",
    "scicode": "SciCode",
    "math_500": "MATH 500",
    "aime": "AIME",
    "median_output_tokens_per_second": "Output Tokens/sec",
    "median_time_to_first_token_seconds": "Time to First Token (s)",
    "median_time_to_first_answer_token": "Time to First Answer Token (s)",
    "price_1m_blended_3_to_1": "Blended Price ($/1M tokens)",
    "price_1m_input_tokens": "Input Price ($/1M tokens)",
    "price_1m_output_tokens": "Output Price ($/1M tokens)",
}

MEDIA_METRIC_LABELS: dict[str, str] = {
    "elo": "ELO Rating",
    "rank": "Rank",
    "ci95": "95% Confidence Interval",
    "appearances": "Appearances",
    "release_date": "Release Date",
}


class ArtificialAnalysisFunctionConfig(FunctionBaseConfig, name="artificial_analysis"):
    """Configuration for the Artificial Analysis API function."""

    api_key: str = Field(
        default_factory=lambda: os.environ.get("AA_API_KEY", ""),
        description="API key for Artificial Analysis. Falls back to the AA_API_KEY environment variable.",
    )
    base_url: str = Field(
        default="https://artificialanalysis.ai/api/v2",
        description="Base URL for the Artificial Analysis API.",
    )


def _normalize_for_match(text: str) -> str:
    """Strip separators and lowercase for fuzzy matching."""
    return (
        text.lower().replace("-", "").replace("_", "").replace(" ", "").replace(".", "")
    )


def _model_match_score(model: dict, query: str) -> float:
    """Score how well a model matches a filter query (0.0 to 1.0).

    Checks name, slug, and creator fields. Returns the best score found.
    """
    query_norm = _normalize_for_match(query)
    candidates = [
        model.get("name", ""),
        model.get("slug", ""),
        model.get("model_creator", {}).get("name", ""),
    ]
    best = 0.0
    for text in candidates:
        text_norm = _normalize_for_match(text)
        if query_norm in text_norm or text_norm in query_norm:
            best = max(best, 0.95)
        score = SequenceMatcher(None, query_norm, text_norm).ratio()
        best = max(best, score)
    return best


def _filter_models(
    models: list[dict], raw_filter: str, min_score: float = 0.45
) -> list[dict]:
    """Filter models by name similarity to the query.

    First tries substring matching. If nothing matches, falls back to
    fuzzy scoring and returns all models above min_score, sorted by
    relevance. This ensures a best-effort match even when the user's
    phrasing doesn't exactly match the API's model names.
    """
    filter_lower = raw_filter.strip().lower()
    filter_norm = _normalize_for_match(filter_lower)

    exact = [
        m
        for m in models
        if filter_lower in m.get("name", "").lower()
        or filter_lower in m.get("slug", "").lower()
        or filter_norm in _normalize_for_match(m.get("name", ""))
        or filter_norm in _normalize_for_match(m.get("slug", ""))
    ]
    if exact:
        return exact

    scored = [(m, _model_match_score(m, raw_filter)) for m in models]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    matched = [m for m, s in scored if s >= min_score]
    return matched


def _resolve_metric_value(model: dict, metric: str) -> float | None:
    """Extract a metric value from a model dict, searching nested structures."""
    if metric in model:
        return model[metric]
    for section in ("evaluations", "pricing"):
        if section in model and isinstance(model[section], dict):
            if metric in model[section]:
                return model[section][metric]
    return None


def _get_metric_label(metric: str, endpoint: str) -> str:
    """Get a human-readable label for a metric key."""
    if endpoint == "llms":
        return LLM_METRIC_LABELS.get(metric, metric.replace("_", " ").title())
    return MEDIA_METRIC_LABELS.get(metric, metric.replace("_", " ").title())


def _build_bar_chart(
    models: list[dict],
    metric: str,
    endpoint: str,
    top_n: int,
) -> tuple[str, str]:
    """Build a bar chart payload and summary from model data."""
    rows: list[dict] = []
    for m in models:
        name = m.get("name", m.get("slug", "Unknown"))
        value = _resolve_metric_value(m, metric)
        if value is not None:
            rows.append({"name": name, "value": round(float(value), 3)})

    rows.sort(key=lambda r: r["value"], reverse=True)
    rows = rows[:top_n]

    if not rows:
        return "", f"No models found with metric `{metric}` for endpoint `{endpoint}`."

    metric_label = _get_metric_label(metric, endpoint)
    label = f"Top {len(rows)} Models by {metric_label}"

    chart_payload = {
        "ChartType": "BarChart",
        "Label": label,
        "Data": rows,
        "XAxisKey": "name",
        "YAxisKey": "value",
    }

    chart_tag = f"<chart>{json.dumps(chart_payload)}</chart>"

    summary_lines = [f"**{label}**\n"]
    for i, row in enumerate(rows[:5], 1):
        summary_lines.append(f"{i}. **{row['name']}**: {row['value']}")
    if len(rows) > 5:
        summary_lines.append(f"_...and {len(rows) - 5} more in the chart below._")
    summary = "\n".join(summary_lines)

    return chart_tag, summary


def _build_quadrant_chart(
    models: list[dict],
    x_metric: str,
    y_metric: str,
    endpoint: str,
    top_n: int,
) -> tuple[str, str]:
    """Build a quadrant scatter chart payload and summary from model data."""
    rows: list[dict] = []
    for m in models:
        name = m.get("name", m.get("slug", "Unknown"))
        x_val = _resolve_metric_value(m, x_metric)
        y_val = _resolve_metric_value(m, y_metric)
        if x_val is not None and y_val is not None:
            rows.append(
                {"name": name, "x": round(float(x_val), 3), "y": round(float(y_val), 3)}
            )

    rows.sort(key=lambda r: r["y"], reverse=True)
    rows = rows[:top_n]

    if not rows:
        return (
            "",
            f"No models found with both `{x_metric}` and `{y_metric}` for endpoint `{endpoint}`.",
        )

    x_label = _get_metric_label(x_metric, endpoint)
    y_label = _get_metric_label(y_metric, endpoint)
    label = f"{y_label} vs {x_label}"

    chart_payload = {
        "ChartType": "QuadrantChart",
        "Label": label,
        "Data": rows,
        "XAxisKey": "x",
        "YAxisKey": "y",
        "NameKey": "name",
        "XAxisLabel": x_label,
        "YAxisLabel": y_label,
    }

    chart_tag = f"<chart>{json.dumps(chart_payload)}</chart>"

    x_values = [r["x"] for r in rows]
    y_values = [r["y"] for r in rows]
    x_med = round(median(x_values), 2)
    y_med = round(median(y_values), 2)

    top_right = [r for r in rows if r["x"] >= x_med and r["y"] >= y_med]
    summary_lines = [
        f"**{label}** ({len(rows)} models plotted)\n",
        f"Quadrant dividers at {x_label} = {x_med}, {y_label} = {y_med}\n",
    ]
    if top_right:
        leaders = ", ".join(r["name"] for r in top_right[:5])
        summary_lines.append(f"Top-right quadrant leaders: {leaders}")
    summary = "\n".join(summary_lines)

    return chart_tag, summary


def _build_category_summary(models: list[dict], top_n: int) -> str:
    """Build a text summary of category-level ELO breakdowns when available."""
    lines: list[str] = []
    for m in models[:top_n]:
        categories = m.get("categories")
        if not categories:
            continue
        name = m.get("name", m.get("slug", "Unknown"))
        cat_parts: list[str] = []
        for cat in categories[:5]:
            label_parts = [
                cat.get("style_category", ""),
                cat.get("subject_matter_category", ""),
                cat.get("format_category", ""),
            ]
            label = " / ".join(p for p in label_parts if p)
            cat_elo = cat.get("elo")
            if label and cat_elo is not None:
                ci = cat.get("ci95", "")
                ci_str = f" ({ci})" if ci else ""
                cat_parts.append(f"  - {label}: ELO {cat_elo}{ci_str}")
        if cat_parts:
            lines.append(f"**{name}** categories:")
            lines.extend(cat_parts)

    if not lines:
        return ""
    return "**Category Breakdowns**\n" + "\n".join(lines)


async def _execute_aa_query(
    api_key: str,
    base_url: str,
    endpoint: str,
    chart_type: str,
    metric: str,
    x_metric: str,
    y_metric: str,
    top_n: int,
    model_filter: str,
    model_exclude: str = "",
    include_categories: bool = False,
) -> tuple[str, str]:
    """Shared query logic: validate inputs, call the API, filter, and build chart.

    Returns (summary, chart_tag). On error, summary contains the error message
    and chart_tag is empty.
    """
    if not api_key:
        return (
            "**Error:** No API key configured. Set the `AA_API_KEY` environment variable.",
            "",
        )

    endpoint = _normalize_endpoint(endpoint)
    if endpoint not in VALID_ENDPOINTS:
        return (
            f"**Error:** Invalid endpoint `{endpoint}`. Choose from: {', '.join(VALID_ENDPOINTS)}",
            "",
        )

    chart_type = _normalize_chart_type(chart_type)
    if chart_type not in ("bar", "quadrant"):
        return (
            f"**Error:** Invalid chart_type `{chart_type}`. Choose `bar` or `quadrant`.",
            "",
        )

    metric = metric.strip().lower()
    x_metric = x_metric.strip().lower()
    y_metric = y_metric.strip().lower()
    top_n = max(1, min(top_n, 50))

    path = ENDPOINT_PATHS[endpoint]
    url = f"{base_url}{path}"

    params: dict[str, str] = {}
    if include_categories and endpoint in CATEGORY_ENDPOINTS:
        params["include_categories"] = "true"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                url, headers={"x-api-key": api_key}, params=params
            )
            response.raise_for_status()
            body = response.json()
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Artificial Analysis API returned %d: %s",
            exc.response.status_code,
            exc.response.text[:500],
        )
        return f"**Error:** API returned status {exc.response.status_code}.", ""
    except httpx.RequestError as exc:
        logger.error("Request to Artificial Analysis API failed: %s", exc)
        return f"**Error:** Could not reach the Artificial Analysis API: {exc}", ""

    models = body.get("data", [])
    if not models:
        return f"No data returned from the `{endpoint}` endpoint.", ""

    if model_filter:
        all_models = models
        models = _filter_models(models, model_filter)
        if not models:
            closest = sorted(
                all_models,
                key=lambda m: _model_match_score(m, model_filter),
                reverse=True,
            )[:5]
            suggestions = [m.get("name", m.get("slug", "?")) for m in closest]
            return (
                f"No models matched `{model_filter}` on the `{endpoint}` endpoint. "
                f"Closest names: {', '.join(suggestions)}"
            ), ""

    if model_exclude:
        exclude_tokens = [
            t.strip().lower() for t in model_exclude.split(",") if t.strip()
        ]
        before_count = len(models)
        models = [
            m
            for m in models
            if not any(
                token in _normalize_for_match(m.get("name", ""))
                or token in _normalize_for_match(m.get("slug", ""))
                or token
                in _normalize_for_match(m.get("model_creator", {}).get("name", ""))
                for token in exclude_tokens
            )
        ]
        logger.info(
            "model_exclude '%s' removed %d model(s), %d remaining",
            model_exclude,
            before_count - len(models),
            len(models),
        )
        if not models:
            return (
                f"No models remained after applying exclusion filter `{model_exclude}` "
                f"on the `{endpoint}` endpoint."
            ), ""

    if chart_type == "bar":
        chart_tag, summary = _build_bar_chart(models, metric, endpoint, top_n)
    else:
        chart_tag, summary = _build_quadrant_chart(
            models, x_metric, y_metric, endpoint, top_n
        )

    if include_categories and endpoint in CATEGORY_ENDPOINTS:
        cat_summary = _build_category_summary(models, top_n)
        if cat_summary:
            summary = f"{summary}\n\n{cat_summary}"

    return summary, chart_tag


_QUERY_PARAMS_DOCSTRING = """
        Args:
            endpoint: API data source. One of: "llms", "text-to-image", "text-to-speech",
                      "text-to-video", "image-to-video", "image-editing".
            chart_type: Visualization type. "bar" for ranked bar chart, "quadrant" for
                        two-metric scatter plot with quadrant dividers.
            metric: Y-axis metric for bar charts. For LLMs use evaluation keys like
                    "artificial_analysis_intelligence_index", "artificial_analysis_coding_index",
                    "median_output_tokens_per_second", "median_time_to_first_answer_token",
                    or pricing keys like "price_1m_blended_3_to_1".
                    For media endpoints use "elo", "rank", or "appearances".
            x_metric: X-axis metric for quadrant charts (e.g., "median_output_tokens_per_second").
            y_metric: Y-axis metric for quadrant charts (e.g., "artificial_analysis_intelligence_index").
            top_n: Maximum number of models to include (default 20).
            model_filter: Optional substring to include only matching models. Case-insensitive.
                          Matches against model name, slug, and creator name. Use to narrow
                          results to a specific model or family (e.g., "llama-3.1", "claude").
            model_exclude: Optional comma-separated list of substrings to exclude models.
                           Any model whose name, slug, or creator matches any token is removed.
                           Example: "openai,anthropic" removes all OpenAI and Anthropic models.
            include_categories: If true, request category-level ELO breakdowns for media
                                endpoints (text-to-image, text-to-video, image-to-video).
                                Categories include style, subject matter, and format breakdowns.
"""

_METRICS_DESCRIPTION = (
    "For the LLMs endpoint, available metrics include: "
    "artificial_analysis_intelligence_index, artificial_analysis_coding_index, "
    "artificial_analysis_math_index, median_output_tokens_per_second, "
    "median_time_to_first_token_seconds, median_time_to_first_answer_token, "
    "price_1m_blended_3_to_1, price_1m_input_tokens, price_1m_output_tokens, "
    "mmlu_pro, gpqa, hle, livecodebench, scicode, math_500, aime. "
    "For media endpoints (text-to-image, text-to-video, etc.), use: elo, rank, appearances, ci95. "
    "Media endpoints also support include_categories=true to get ELO breakdowns by category "
    "(style, subject matter, format)."
)


@register_function(config_type=ArtificialAnalysisFunctionConfig)
async def artificial_analysis_function(
    config: ArtificialAnalysisFunctionConfig, builder: Builder
):
    api_key = config.api_key or os.environ.get("AA_API_KEY", "")

    async def _query_fn(
        endpoint: str,
        chart_type: str = "bar",
        metric: str = "artificial_analysis_intelligence_index",
        x_metric: str = "median_output_tokens_per_second",
        y_metric: str = "artificial_analysis_intelligence_index",
        top_n: int = 20,
        model_filter: str = "",
        model_exclude: str = "",
        include_categories: bool = False,
    ) -> str:
        f"""Query the Artificial Analysis API for AI model benchmark data.
{_QUERY_PARAMS_DOCSTRING}
        """
        summary, _chart_tag = await _execute_aa_query(
            api_key,
            config.base_url,
            endpoint,
            chart_type,
            metric,
            x_metric,
            y_metric,
            top_n,
            model_filter,
            model_exclude,
            include_categories,
        )
        return summary

    try:
        yield FunctionInfo.from_fn(
            _query_fn,
            description=(
                "Query the Artificial Analysis API to retrieve benchmark data, pricing, "
                "and performance metrics for AI models (LLMs, text-to-image, text-to-video, etc.). "
                "Returns a text summary of the data. Use chart_type 'bar' for "
                "ranked comparisons or 'quadrant' for two-dimensional scatter analysis "
                "(e.g., speed vs intelligence, cost vs quality). "
                "Use model_filter to include only models matching a substring (e.g., 'llama-3.1', 'claude'). "
                "Use model_exclude to remove models by provider or family — accepts comma-separated "
                "substrings (e.g., 'openai' removes all OpenAI models; 'openai,anthropic' removes both). "
                "When the user asks about a specific model, always set model_filter. "
                "When the user asks to remove or exclude a provider or family, set model_exclude. "
                "Set include_categories=true for media endpoints (text-to-image, text-to-video, "
                "image-to-video) to get ELO breakdowns by style, subject matter, and format category. "
                + _METRICS_DESCRIPTION
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up artificial_analysis function.")


class ArtificialAnalysisRenderConfig(
    FunctionBaseConfig, name="artificial_analysis_render"
):
    """Configuration for the Artificial Analysis chart rendering function."""

    api_key: str = Field(
        default_factory=lambda: os.environ.get("AA_API_KEY", ""),
        description="API key for Artificial Analysis. Falls back to the AA_API_KEY environment variable.",
    )
    base_url: str = Field(
        default="https://artificialanalysis.ai/api/v2",
        description="Base URL for the Artificial Analysis API.",
    )


@register_function(config_type=ArtificialAnalysisRenderConfig)
async def artificial_analysis_render_function(
    config: ArtificialAnalysisRenderConfig, builder: Builder
):
    api_key = config.api_key or os.environ.get("AA_API_KEY", "")

    async def _render_fn(
        endpoint: str,
        chart_type: str = "bar",
        metric: str = "artificial_analysis_intelligence_index",
        x_metric: str = "median_output_tokens_per_second",
        y_metric: str = "artificial_analysis_intelligence_index",
        top_n: int = 20,
        model_filter: str = "",
        model_exclude: str = "",
        include_categories: bool = False,
    ) -> str:
        f"""Render an interactive chart from Artificial Analysis benchmark data.
{_QUERY_PARAMS_DOCSTRING}
        """
        summary, chart_tag = await _execute_aa_query(
            api_key,
            config.base_url,
            endpoint,
            chart_type,
            metric,
            x_metric,
            y_metric,
            top_n,
            model_filter,
            model_exclude,
            include_categories,
        )
        if not chart_tag:
            return summary
        return f"{summary}\n\n{chart_tag}"

    try:
        yield FunctionInfo.from_fn(
            _render_fn,
            description=(
                "Render an interactive chart visualization from Artificial Analysis "
                "benchmark data. Returns an interactive chart comparing AI models. "
                "Use chart_type 'bar' for ranked bar charts or 'quadrant' for "
                "two-dimensional scatter plots (e.g., speed vs intelligence). "
                "Use model_filter to include only models matching a substring (e.g., 'llama-3.1', 'claude'). "
                "Use model_exclude to remove models by provider or family — accepts comma-separated "
                "substrings (e.g., 'openai' removes all OpenAI models; 'openai,google' removes both). "
                "When the user asks to modify a chart — change scope, remove a provider, or limit count — "
                "always call this tool again with the updated parameters rather than reusing the previous result. "
                "Set include_categories=true for media endpoints (text-to-image, text-to-video, "
                "image-to-video) to get ELO breakdowns by style, subject matter, and format category. "
                + _METRICS_DESCRIPTION
            ),
        )
    except GeneratorExit:
        logger.warning("Render function exited early!")
    finally:
        logger.info("Cleaning up artificial_analysis_render function.")
