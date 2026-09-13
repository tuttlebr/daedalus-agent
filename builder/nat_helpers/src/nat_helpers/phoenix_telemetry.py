"""Phoenix telemetry that cannot block workflow execution or response teardown."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable

from nat.builder.builder import Builder
from nat.cli.register_workflow import register_telemetry_exporter
from nat.data_models.common import SerializableSecretStr, get_secret_value
from nat.data_models.telemetry_exporter import TelemetryExporterBaseConfig
from nat.observability.mixin.batch_config_mixin import BatchConfigMixin
from nat.observability.mixin.collector_config_mixin import CollectorConfigMixin
from nat.plugins.opentelemetry.otel_span import OtelSpan
from nat.plugins.phoenix.phoenix_exporter import PhoenixOtelExporter
from pydantic import Field

logger = logging.getLogger(__name__)

# Keep strong references until detached final-flush tasks complete.
_FINAL_FLUSH_TASKS: set[asyncio.Task[None]] = set()


def _phoenix_auth_headers(api_key: str) -> dict[str, str]:
    token = api_key if api_key.lower().startswith("bearer ") else f"Bearer {api_key}"
    return {"authorization": token}


async def _bounded_cleanup(
    cleanup: Awaitable[None],
    *,
    timeout: float,
) -> None:
    """Flush queued telemetry for at most ``timeout`` seconds off the request path."""

    try:
        async with asyncio.timeout(timeout):
            await cleanup
    except TimeoutError:
        logger.warning(
            "Phoenix final telemetry flush exceeded %.1f seconds; dropping the remainder",
            timeout,
        )
    except Exception:
        logger.warning("Phoenix final telemetry flush failed", exc_info=True)


class DaedalusPhoenixOtelExporter(PhoenixOtelExporter):
    """Move Phoenix's synchronous HTTP exporter and cleanup off the event-loop path."""

    def __init__(self, *args, shutdown_timeout: float = 2.0, **kwargs):
        self._daedalus_shutdown_timeout = shutdown_timeout
        super().__init__(*args, shutdown_timeout=shutdown_timeout, **kwargs)

    async def export_otel_spans(self, spans: list[OtelSpan]) -> None:
        """Run the synchronous Phoenix client in a worker thread."""

        def _export() -> None:
            # Run the pinned mixin's complete export path, including its project
            # scope and exception handling, on a thread-local event loop.
            asyncio.run(PhoenixOtelExporter.export_otel_spans(self, spans))

        try:
            await asyncio.to_thread(_export)
        except Exception:
            logger.warning("Phoenix telemetry export failed", exc_info=True)

    async def _cleanup(self) -> None:
        """Schedule a bounded final flush without delaying the workflow response."""

        task = asyncio.create_task(
            _bounded_cleanup(
                super()._cleanup(),
                timeout=self._daedalus_shutdown_timeout,
            ),
            name="daedalus-phoenix-final-flush",
        )
        _FINAL_FLUSH_TASKS.add(task)
        task.add_done_callback(_FINAL_FLUSH_TASKS.discard)


class DaedalusPhoenixTelemetryConfig(
    BatchConfigMixin,
    CollectorConfigMixin,
    TelemetryExporterBaseConfig,
    name="daedalus_phoenix",
):
    """Phoenix exporter whose network and final flush stay off response paths."""

    timeout: float = Field(
        default=3.0,
        gt=0,
        description="Timeout in seconds for each Phoenix HTTP request.",
    )
    shutdown_timeout: float = Field(
        default=2.0,
        gt=0,
        description="Maximum background time for the final queued span flush.",
    )
    api_key: SerializableSecretStr = Field(
        default_factory=lambda: SerializableSecretStr(""),
        description=(
            "Phoenix API key. If empty, use the PHOENIX_API_KEY environment variable."
        ),
    )


@register_telemetry_exporter(config_type=DaedalusPhoenixTelemetryConfig)
async def daedalus_phoenix_telemetry_exporter(
    config: DaedalusPhoenixTelemetryConfig,
    builder: Builder,
):
    """Create a non-blocking Phoenix telemetry exporter."""

    del builder
    api_key = get_secret_value(config.api_key) if config.api_key else None
    api_key = (api_key or os.environ.get("PHOENIX_API_KEY") or "").strip()
    headers = _phoenix_auth_headers(api_key) if api_key else None
    yield DaedalusPhoenixOtelExporter(
        endpoint=config.endpoint,
        project=config.project,
        timeout=config.timeout,
        headers=headers,
        batch_size=config.batch_size,
        flush_interval=config.flush_interval,
        max_queue_size=config.max_queue_size,
        drop_on_overflow=config.drop_on_overflow,
        shutdown_timeout=config.shutdown_timeout,
    )
