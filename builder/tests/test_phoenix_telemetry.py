"""Telemetry remains optional and closes outside the event-loop thread."""

import asyncio
import threading

from nat_helpers.phoenix_telemetry import close_telemetry, configure_telemetry


def test_unconfigured_telemetry_does_not_create_a_network_client(monkeypatch):
    monkeypatch.delenv("DAEDALUS_PHOENIX_ENDPOINT", raising=False)
    assert configure_telemetry({}) is None


def test_exporter_shutdown_runs_off_the_event_loop():
    async def run():
        current = threading.get_ident()

        class Provider:
            thread = None

            def shutdown(self):
                self.thread = threading.get_ident()

        provider = Provider()
        await close_telemetry(provider)
        assert provider.thread is not None and provider.thread != current

    asyncio.run(run())
