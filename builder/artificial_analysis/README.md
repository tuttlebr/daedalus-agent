# Artificial Analysis API

The [Artificial Analysis](https://artificialanalysis.ai) v2 API provides benchmark data, pricing, and performance metrics for AI models across multiple domains.

## Authentication

Requests require an API key passed through the `x-api-key` header. Set the `AA_API_KEY` environment variable with your key.

## Endpoints

| Endpoint         | API Path                     | Description                           |
| ---------------- | ---------------------------- | ------------------------------------- |
| `llms`           | `/data/llms/models`          | Language model benchmarks and pricing |
| `text-to-image`  | `/data/media/text-to-image`  | Text-to-image model rankings          |
| `text-to-speech` | `/data/media/text-to-speech` | Text-to-speech model rankings         |
| `text-to-video`  | `/data/media/text-to-video`  | Text-to-video model rankings          |
| `image-to-video` | `/data/media/image-to-video` | Image-to-video model rankings         |
| `image-editing`  | `/data/media/image-editing`  | Image editing model rankings          |

Endpoint names are flexible — aliases like `llm`, `models`, `tts`, `tti`, `ttv`, `itv`, and underscore/space variants are all accepted.

## Available Metrics

### LLM Metrics

| Key                                      | Label                       |
| ---------------------------------------- | --------------------------- |
| `artificial_analysis_intelligence_index` | Intelligence Index          |
| `artificial_analysis_coding_index`       | Coding Index                |
| `artificial_analysis_math_index`         | Math Index                  |
| `mmlu_pro`                               | MMLU Pro                    |
| `gpqa`                                   | GPQA                        |
| `hle`                                    | HLE                         |
| `livecodebench`                          | LiveCodeBench               |
| `scicode`                                | SciCode                     |
| `math_500`                               | MATH 500                    |
| `aime`                                   | AIME                        |
| `median_output_tokens_per_second`        | Output Tokens/sec           |
| `median_time_to_first_token_seconds`     | Time to First Token (s)     |
| `price_1m_blended_3_to_1`                | Blended Price ($/1M tokens) |
| `price_1m_input_tokens`                  | Input Price ($/1M tokens)   |
| `price_1m_output_tokens`                 | Output Price ($/1M tokens)  |

### Media Metrics

| Key           | Label       |
| ------------- | ----------- |
| `elo`         | ELO Rating  |
| `rank`        | Rank        |
| `appearances` | Appearances |

## Chart Types

- **`bar`** — Ranked bar chart comparing models on a single metric.
- **`quadrant`** — Two-metric scatter plot with median-based quadrant dividers (e.g., speed vs intelligence).

## Query Parameters

| Parameter       | Type  | Default                                    | Description                                                           |
| --------------- | ----- | ------------------------------------------ | --------------------------------------------------------------------- |
| `endpoint`      | `str` | _(required)_                               | Data source (see endpoints above)                                     |
| `chart_type`    | `str` | `"bar"`                                    | `"bar"` or `"quadrant"`                                               |
| `metric`        | `str` | `"artificial_analysis_intelligence_index"` | Y-axis metric for bar charts                                          |
| `x_metric`      | `str` | `"median_output_tokens_per_second"`        | X-axis metric for quadrant charts                                     |
| `y_metric`      | `str` | `"artificial_analysis_intelligence_index"` | Y-axis metric for quadrant charts                                     |
| `top_n`         | `int` | `20`                                       | Max models to include (clamped 1–50)                                  |
| `model_filter`  | `str` | `""`                                       | Substring filter to include matching models (fuzzy, case-insensitive) |
| `model_exclude` | `str` | `""`                                       | Comma-separated substrings to exclude models by name/creator          |

## Response Formats

### Text Summary

A markdown-formatted text summary ranking the queried models by the selected metric.

### Chart Visualization

A text summary followed by an interactive chart embedded as a `<chart>` tag with a JSON payload:

```json
{
  "ChartType": "BarChart",
  "Label": "Top 20 Models by Intelligence Index",
  "Data": [{"name": "Model A", "value": 92.5}],
  "XAxisKey": "name",
  "YAxisKey": "value"
}
```

Quadrant charts include additional `NameKey`, `XAxisLabel`, and `YAxisLabel` fields.

## Model Filtering

Filtering uses a two-pass approach:

1. **Substring match** against model name, slug, and normalized variants.
2. **Fuzzy matching** (via `SequenceMatcher`) with a minimum score of 0.45 if no substring match is found. Results are sorted by relevance.

When no models match, the five closest model names are returned as suggestions.
