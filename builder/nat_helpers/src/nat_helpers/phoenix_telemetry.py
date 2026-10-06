"""Nonblocking, content-free OpenTelemetry export to Phoenix."""

import asyncio
import logging
import os

logger = logging.getLogger(__name__)


def configure_telemetry(config: dict):
    endpoint = config.get("endpoint") or os.getenv("DAEDALUS_PHOENIX_ENDPOINT", "")
    if not endpoint:
        return None
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    key = os.getenv("PHOENIX_API_KEY", "").strip()
    token = key if key.lower().startswith("bearer ") else f"Bearer {key}"
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": "daedalus-tools",
                "openinference.project.name": config.get("project")
                or os.getenv("PHOENIX_PROJECT_NAME", "daedalus"),
            }
        )
    )
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=endpoint,
                headers={"authorization": token} if key else None,
                timeout=float(config.get("timeout", 3)),
            ),
            max_queue_size=2048,
            schedule_delay_millis=1000,
        )
    )
    trace.set_tracer_provider(provider)
    return provider


async def close_telemetry(provider):
    if provider is not None:
        try:
            await asyncio.wait_for(asyncio.to_thread(provider.shutdown), timeout=3)
        except TimeoutError:
            logger.warning("Telemetry shutdown exceeded its budget")
