---
name: nat-telemetry
description: >-
  Use when adding, configuring, or troubleshooting NeMo Agent Toolkit
  observability, including logging, tracing, spans, telemetry exporters,
  OpenTelemetry (OTel), and provider integrations for Langfuse, LangSmith,
  Weights and Biases Weave, and Phoenix, plus workflow profiling. Discover
  exporters with nat info components -t logging and -t tracing. Use
  nat-evaluation for measuring answer quality and correctness; this skill
  covers instrumentation and profiling, not quality scoring.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit Telemetry

Use this skill for workflow observability, tracing, logging, and profiling.

## Workflow

1. Discover registered logging and tracing exporters:

```bash
uv run nat info components -t logging
uv run nat info components -t tracing
```

2. Prefer built-in provider integrations when available.
3. Use file or console exporters for deterministic local debugging.
4. For custom exporters, adapt `references/otel_file_exporter.py` and nearby toolkit exporter code.

## References

- `references/telemetry.md`
- `references/otel_file_exporter.py`
