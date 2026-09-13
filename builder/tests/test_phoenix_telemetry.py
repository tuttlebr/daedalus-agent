"""Latency and configuration contracts for the Daedalus Phoenix exporter."""

import asyncio
import threading
import time

from nat_helpers.phoenix_telemetry import (
    _FINAL_FLUSH_TASKS,
    DaedalusPhoenixOtelExporter,
    DaedalusPhoenixTelemetryConfig,
)


def test_phoenix_http_export_runs_outside_the_event_loop_thread():
    class BlockingExporter:
        def __init__(self):
            self.thread_id = None

        def export(self, _spans):
            self.thread_id = threading.get_ident()
            time.sleep(0.05)

    async def _run():
        exporter = object.__new__(DaedalusPhoenixOtelExporter)
        exporter._project = "test"
        exporter._exporter = BlockingExporter()
        event_loop_thread = threading.get_ident()

        task = asyncio.create_task(exporter.export_otel_spans([]))
        started = time.monotonic()
        await asyncio.sleep(0.005)
        elapsed = time.monotonic() - started
        assert elapsed < 0.04
        assert not task.done()
        await task
        assert exporter._exporter.thread_id != event_loop_thread

    asyncio.run(_run())


def test_final_flush_is_detached_and_bounded():
    class SlowProcessor:
        def __init__(self):
            self.cancelled = False

        async def shutdown(self):
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                self.cancelled = True
                raise

    async def _run():
        processor = SlowProcessor()
        exporter = object.__new__(DaedalusPhoenixOtelExporter)
        exporter._processors = [processor]
        exporter._daedalus_shutdown_timeout = 0.01

        started = time.monotonic()
        await exporter._cleanup()
        assert time.monotonic() - started < 0.04
        assert _FINAL_FLUSH_TASKS
        await asyncio.sleep(0.03)
        assert processor.cancelled is True
        assert not _FINAL_FLUSH_TASKS

    asyncio.run(_run())


def test_phoenix_defaults_bound_network_and_final_flush_delays():
    config = DaedalusPhoenixTelemetryConfig(
        endpoint="http://phoenix.test/v1/traces",
        project="test",
    )

    assert config.timeout == 3.0
    assert config.shutdown_timeout == 2.0
