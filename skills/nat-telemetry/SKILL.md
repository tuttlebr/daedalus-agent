---
name: nat-telemetry
description: Use when adding, configuring, or troubleshooting NeMo Agent Toolkit logging, tracing, telemetry exporters, OpenTelemetry, Langfuse, LangSmith, Weave, Phoenix, profiling, or observability provider integrations.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit Telemetry

## Goal

Configure or troubleshoot workflow observability, tracing, logging, and
profiling with built-in NeMo Agent Toolkit providers first. Success means the
exporter choice, config surface, local verification command, and fallback are
explicit.

Stop and ask for the target observability provider or runtime surface when it
cannot be inferred from the workflow.

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
