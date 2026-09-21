"""NWS data preserves complete date coverage and explicit missing-source states."""

import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import httpx
import pytest
import webscrape.nws_weather_function as nws
from nat_helpers.url_guard import UnsafeURLError
from pydantic import ValidationError


def _forecast_data(now, periods):
    return {"properties": {"updateTime": now.isoformat(), "periods": periods}}


def _period(start, end):
    return {
        "startTime": start.isoformat(),
        "endTime": end.isoformat(),
        "name": "Day",
        "temperature": 70,
        "temperatureUnit": "F",
        "isDaytime": True,
        "detailedForecast": "Sunny.",
    }


def test_forecast_includes_four_local_dates_and_final_night():
    zone = ZoneInfo("America/Detroit")
    now = datetime(2026, 9, 21, 8, tzinfo=zone)
    periods = [
        _period(now + timedelta(hours=i * 12), now + timedelta(hours=(i + 1) * 12))
        for i in range(9)
    ]
    result = nws._forecast(
        _forecast_data(now, periods),
        now.isoformat(),
        "https://api.weather.gov/gridpoints/DTX/1,1/forecast",
        "America/Detroit",
        4,
        now,
    )
    assert result["status"] == "ok"
    assert result["coverage"]["dates"] == [
        "2026-09-21",
        "2026-09-22",
        "2026-09-23",
        "2026-09-24",
    ]
    assert result["coverage"]["end"] == "2026-09-25T00:00:00-04:00"
    assert result["coverage"]["today"] == "remaining_hours"
    assert result["coverage"]["complete"] is True
    assert len(result["periods"]) == 8
    partial = nws._forecast(
        _forecast_data(now, periods[:7]),
        now.isoformat(),
        "source",
        "America/Detroit",
        4,
        now,
    )
    assert partial["status"] == "partial"
    assert partial["coverage"]["complete"] is False
    assert partial["coverage"]["gaps"][-1]["end"] == "2026-09-25T00:00:00-04:00"


def test_internal_forecast_gap_is_partial_even_when_last_day_present():
    now = datetime(2026, 9, 21, 12, tzinfo=UTC)
    periods = [
        _period(now, now + timedelta(hours=8)),
        _period(now + timedelta(hours=9), now + timedelta(days=5)),
    ]
    result = nws._forecast(
        _forecast_data(now, periods),
        now.isoformat(),
        "source",
        "America/Detroit",
        4,
        now,
    )
    assert result["status"] == "partial"
    assert len(result["coverage"]["gaps"]) == 1


def test_stale_forecast_and_empty_forecast_are_not_complete_success():
    now = datetime(2026, 9, 21, 12, tzinfo=UTC)
    stale = _forecast_data(
        now - timedelta(days=2), [_period(now, now + timedelta(days=5))]
    )
    result = nws._forecast(stale, now.isoformat(), "source", "America/Detroit", 4, now)
    assert result["status"] == "partial"
    assert result["freshness"] == "stale_or_unknown"
    missing = nws._forecast(
        {"properties": {}}, now.isoformat(), "source", "America/Detroit", 4, now
    )
    assert missing["status"] == "partial"
    assert missing["coverage"]["complete"] is False


@pytest.mark.parametrize(
    "url",
    [
        "http://api.weather.gov/a",
        "https://api.weather.gov.attacker.test/a",
        "https://127.0.0.1/a",
        "https://secret@api.weather.gov/a",
        "https://api.weather.gov:444/a",
    ],
)
def test_api_links_cannot_escape_nws(url):
    with pytest.raises(UnsafeURLError):
        nws._nws_url(url)


def test_redirect_to_another_host_is_rejected_before_follow(monkeypatch):
    async def run():
        monkeypatch.setattr(nws, "validate_public_url", lambda *args, **kwargs: None)
        client = AsyncMock()
        client.get.return_value = httpx.Response(
            302,
            headers={"location": "https://example.com/foreign"},
            request=httpx.Request("GET", "https://api.weather.gov/points/1,1"),
        )
        with pytest.raises(UnsafeURLError):
            await nws.NwsWeatherClient(client)._json(
                "https://api.weather.gov/points/1,1", "points"
            )
        client.get.assert_awaited_once()

    asyncio.run(run())


def test_weather_points_cached_but_alerts_and_forecast_refreshed(monkeypatch):
    async def run():
        client = nws.NwsWeatherClient(AsyncMock())
        now = datetime.now(UTC)
        calls = []

        async def fetch(url, phase):
            calls.append(phase)
            if phase == "points":
                return (
                    {
                        "properties": {
                            "forecast": "https://api.weather.gov/gridpoints/DTX/1,1/forecast",
                            "timeZone": "America/Detroit",
                        }
                    },
                    now.isoformat(),
                    {},
                )
            if phase == "alerts":
                return {"features": []}, now.isoformat(), {}
            return (
                _forecast_data(
                    now, [_period(now - timedelta(hours=1), now + timedelta(days=7))]
                ),
                now.isoformat(),
                {},
            )

        monkeypatch.setattr(client, "_json", fetch)
        first = await client.weather(42.1, -83.1)
        second = await client.weather(42.1, -83.1)
        assert first["status"] == second["status"] == "ok"
        assert calls.count("points") == 1
        assert calls.count("alerts") == calls.count("forecast") == 2
        assert first["alerts"]["items"] == []
        assert "observations" not in first

    asyncio.run(run())


def test_alert_failure_keeps_forecast_and_never_claims_no_alerts(monkeypatch):
    async def run():
        client = nws.NwsWeatherClient(AsyncMock())
        now = datetime.now(UTC)

        async def fetch(url, phase):
            if phase == "alerts":
                raise httpx.ReadTimeout("temporarily unavailable")
            if phase == "points":
                return (
                    {
                        "properties": {
                            "forecast": "https://api.weather.gov/gridpoints/DTX/1,1/forecast",
                            "timeZone": "America/Detroit",
                        }
                    },
                    now.isoformat(),
                    {},
                )
            return (
                _forecast_data(
                    now, [_period(now - timedelta(hours=1), now + timedelta(days=7))]
                ),
                now.isoformat(),
                {},
            )

        monkeypatch.setattr(client, "_json", fetch)
        result = await client.weather(42.1, -83.1, include_observations=True)
        assert result["status"] == "partial"
        assert result["forecast"]["status"] == "ok"
        assert result["alerts"]["status"] == "unavailable"
        assert "items" not in result["alerts"]
        assert result["observations"]["status"] == "unavailable"

    asyncio.run(run())


def test_points_failure_still_returns_available_alerts(monkeypatch):
    async def run():
        client = nws.NwsWeatherClient(AsyncMock())

        async def fetch(url, phase):
            if phase == "points":
                raise ValueError("missing mapping")
            return {"features": []}, datetime.now(UTC).isoformat(), {}

        monkeypatch.setattr(client, "_json", fetch)
        result = await client.weather(42.1, -83.1)
        assert result["status"] == "partial"
        assert result["forecast"]["status"] == "unavailable"
        assert result["alerts"]["status"] == "ok"

    asyncio.run(run())


def test_optional_observation_preserves_timestamp_units_and_staleness(monkeypatch):
    async def run():
        client = nws.NwsWeatherClient(AsyncMock())
        now = datetime.now(UTC)

        async def fetch(url, phase):
            if phase == "stations":
                return (
                    {"features": [{"id": "https://api.weather.gov/stations/KDTW"}]},
                    now.isoformat(),
                    {},
                )
            return (
                {
                    "properties": {
                        "timestamp": (now - timedelta(hours=4)).isoformat(),
                        "temperature": {"value": 20, "unitCode": "wmoUnit:degC"},
                    }
                },
                now.isoformat(),
                {},
            )

        monkeypatch.setattr(client, "_json", fetch)
        result = await client._observations(
            {
                "observationStations": "https://api.weather.gov/gridpoints/DTX/1,1/stations"
            }
        )
        assert result["status"] == "partial"
        assert result["freshness"] == "stale_or_unknown"
        assert result["observation"]["temperature"]["unitCode"] == "wmoUnit:degC"

    asyncio.run(run())


def test_input_bounds_and_schema():
    assert nws.WeatherInput(latitude=42, longitude=-83).days == 4
    for data in (
        {"latitude": float("nan"), "longitude": 1},
        {"latitude": 91, "longitude": 1},
        {"latitude": 1, "longitude": 1, "days": 8},
    ):
        with pytest.raises(ValidationError):
            nws.WeatherInput(**data)


def test_cancelled_points_waiter_does_not_cancel_other_request(monkeypatch):
    async def run():
        client = nws.NwsWeatherClient(AsyncMock())
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def fetch(*args):
            calls.append(args)
            entered.set()
            await release.wait()
            return (
                {"properties": {"timeZone": "America/Detroit"}},
                datetime.now(UTC).isoformat(),
                {},
            )

        monkeypatch.setattr(client, "_json", fetch)
        url = "https://api.weather.gov/points/42,-83"
        first = asyncio.create_task(client._point(url))
        await entered.wait()
        second = asyncio.create_task(client._point(url))
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        assert (await second)[0]["properties"]["timeZone"] == "America/Detroit"
        assert len(calls) == 1
        await asyncio.sleep(0)
        assert not client._pending
        await client.close()

    asyncio.run(run())
