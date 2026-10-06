"""Compact, sourced NWS forecasts without scraping forecast-page navigation."""

from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from datetime import UTC, datetime
from datetime import time as daytime
from datetime import timedelta
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import httpx
from daedalus_runtime.tools import (
    ToolConfig,
    ToolDefinition,
    ToolRegistry,
    register_tool,
)
from nat_helpers.phase_timing import phase_timing
from nat_helpers.public_content import AnonymousPublicClient, _cache_ttl
from nat_helpers.safe_http import PublicAsyncHTTPTransport
from nat_helpers.url_guard import UnsafeURLError, validate_public_url
from pydantic import BaseModel, Field

_NWS_BASE = "https://api.weather.gov"


class NwsWeatherFunctionConfig(ToolConfig, name="nws_weather"):
    description: str | None = None
    user_agent: str = "daedalus-weather/1.0"
    timeout: float = Field(default=20, ge=5, le=60)
    points_cache_ttl_seconds: float = Field(default=86400, ge=0, le=86400)


class WeatherInput(BaseModel):
    latitude: float = Field(ge=-90, le=90, description="Latitude of the US location.")
    longitude: float = Field(
        ge=-180, le=180, description="Longitude of the US location."
    )
    days: int = Field(
        default=4, ge=1, le=7, description="Today plus following local calendar days."
    )
    include_observations: bool = Field(
        default=False, description="Also request the latest station observation."
    )


def _nws_url(url: str) -> str:
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "api.weather.gov"
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise UnsafeURLError("NWS links must stay on https://api.weather.gov")
    return url


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else None
    except ValueError:
        return None


def _unavailable(exc: BaseException, source_url: str | None = None) -> dict:
    return {
        "status": "unavailable",
        "reason": type(exc).__name__,
        "source_url": source_url,
    }


def _forecast(payload, fetched_at, source_url, timezone_name, days, now):
    properties = payload.get("properties", {})
    zone = ZoneInfo(timezone_name)
    local_now = now.astimezone(zone)
    first_date = local_now.date()
    last_date = first_date + timedelta(days=days)
    coverage_end = datetime.combine(last_date, daytime.min, zone)
    required_dates = [(first_date + timedelta(days=i)).isoformat() for i in range(days)]
    intervals = []
    periods = []
    for period in properties.get("periods", []):
        start, end = (
            _parse_time(period.get("startTime")),
            _parse_time(period.get("endTime")),
        )
        if not start or not end or end <= start or end <= now or start >= coverage_end:
            continue
        intervals.append((start, end))
        periods.append(
            {
                key: period.get(key)
                for key in (
                    "name",
                    "startTime",
                    "endTime",
                    "isDaytime",
                    "temperature",
                    "temperatureUnit",
                    "probabilityOfPrecipitation",
                    "windSpeed",
                    "windDirection",
                    "shortForecast",
                    "detailedForecast",
                )
            }
        )
    gaps = []
    cursor = now
    for start, end in sorted(intervals):
        if start > cursor:
            gaps.append(
                {
                    "start": cursor.isoformat(),
                    "end": min(start, coverage_end).isoformat(),
                }
            )
        cursor = max(cursor, end)
    if cursor < coverage_end:
        gaps.append({"start": cursor.isoformat(), "end": coverage_end.isoformat()})
    issued_at = properties.get("updateTime") or properties.get("generatedAt")
    issued = _parse_time(issued_at)
    stale = issued is None or now - issued > timedelta(hours=24)
    missing_values = any(
        period.get("temperature") is None
        or not period.get("temperatureUnit")
        or not (period.get("shortForecast") or period.get("detailedForecast"))
        for period in periods
    )
    return {
        "status": "ok" if not gaps and not stale and not missing_values else "partial",
        "source_url": source_url,
        "fetched_at": fetched_at,
        "issued_at": issued_at,
        "freshness": "stale_or_unknown" if stale else "current",
        "missing_period_values": missing_values,
        "timezone": timezone_name,
        "coverage": {
            "dates": required_dates,
            "start": local_now.isoformat(),
            "end": coverage_end.isoformat(),
            "today": "remaining_hours",
            "complete": not gaps,
            "gaps": gaps,
        },
        "periods": periods,
    }


class NwsWeatherClient:
    def __init__(self, client, *, points_ttl=86400, timeout=20):
        self.client, self.points_ttl, self.timeout = client, points_ttl, timeout
        self._points = OrderedDict()
        self._pending = {}

    async def _json(self, url: str, phase: str):
        with phase_timing(f"daedalus.nws.{phase}"):
            current_url = _nws_url(url)
            for _ in range(6):
                await asyncio.to_thread(
                    validate_public_url,
                    current_url,
                    allowed_schemes=("https",),
                    check_dns=True,
                )
                response = await self.client.get(current_url)
                if not response.is_redirect:
                    response.raise_for_status()
                    payload = response.json()
                    if not isinstance(payload, dict):
                        raise ValueError("NWS returned a non-object response")
                    return payload, datetime.now(UTC).isoformat(), response.headers
                current_url = _nws_url(
                    urljoin(current_url, response.headers.get("location", ""))
                )
            raise UnsafeURLError("Too many NWS redirects")

    async def close(self):
        pending = list(self._pending.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self._pending.clear()
        self._points.clear()

    async def _point(self, url):
        cached = self._points.get(url)
        if cached and cached[0] > time.monotonic():
            self._points.move_to_end(url)
            return cached[1]
        if cached:
            self._points.pop(url)

        async def load():
            async with asyncio.timeout(self.timeout):
                result = await self._json(url, "points")
            ttl = _cache_ttl(result[2], self.points_ttl)
            if ttl > 0:
                self._points[url] = (time.monotonic() + ttl, result)
                while len(self._points) > 64:
                    self._points.popitem(last=False)
            return result

        pending = self._pending.get(url)
        if pending is None:
            if len(self._pending) >= 64:
                return await load()
            pending = asyncio.create_task(load())
            self._pending[url] = pending

            def finished(task):
                if self._pending.get(url) is task:
                    self._pending.pop(url, None)
                if not task.cancelled():
                    task.exception()

            pending.add_done_callback(finished)
        return await asyncio.shield(pending)

    async def _observations(self, points):
        stations_url = _nws_url(points["observationStations"])
        stations, _, _ = await self._json(stations_url, "stations")
        features = stations.get("features", [])
        if not features:
            raise ValueError("No observation stations available")
        station_url = _nws_url(features[0]["id"])
        url = station_url.rstrip("/") + "/observations/latest"
        payload, fetched_at, _ = await self._json(url, "observation")
        data = payload.get("properties", {})
        observed = _parse_time(data.get("timestamp"))
        fresh = observed is not None and timedelta(0) <= datetime.now(
            UTC
        ) - observed <= timedelta(hours=2)
        fields = {
            key: data.get(key)
            for key in (
                "timestamp",
                "textDescription",
                "temperature",
                "relativeHumidity",
                "windDirection",
                "windSpeed",
                "windGust",
                "visibility",
            )
        }
        meaningful = any(
            isinstance(data.get(key), dict) and data[key].get("value") is not None
            for key in ("temperature", "windSpeed", "visibility")
        )
        return {
            "status": "ok" if fresh and meaningful else "partial",
            "source_url": url,
            "fetched_at": fetched_at,
            "freshness": "current" if fresh else "stale_or_unknown",
            "observation": fields,
        }

    async def weather(self, latitude, longitude, days=4, include_observations=False):
        request = WeatherInput(
            latitude=latitude,
            longitude=longitude,
            days=days,
            include_observations=include_observations,
        )
        coordinate = f"{request.latitude:.4f},{request.longitude:.4f}"
        points_url = f"{_NWS_BASE}/points/{coordinate}"
        alerts_url = f"{_NWS_BASE}/alerts/active?point={coordinate}"

        async def bounded(operation):
            try:
                async with asyncio.timeout(self.timeout):
                    return await operation
            except Exception as exc:
                return exc

        point_result, alerts_result = await asyncio.gather(
            bounded(self._point(points_url)), bounded(self._json(alerts_url, "alerts"))
        )
        result = {"latitude": request.latitude, "longitude": request.longitude}
        if isinstance(alerts_result, Exception):
            result["alerts"] = _unavailable(alerts_result, alerts_url)
        else:
            payload, fetched_at, _ = alerts_result
            if not isinstance(payload.get("features"), list) or any(
                not isinstance(feature, dict)
                or not isinstance(feature.get("properties"), dict)
                for feature in payload.get("features", [])
            ):
                result["alerts"] = _unavailable(
                    ValueError("Missing alerts features"), alerts_url
                )
            else:
                result["alerts"] = {
                    "status": "ok",
                    "source_url": alerts_url,
                    "fetched_at": fetched_at,
                    "issued_at": payload.get("updated"),
                    "items": [
                        {
                            "source_url": feature.get("id"),
                            **{
                                key: feature.get("properties", {}).get(key)
                                for key in (
                                    "event",
                                    "severity",
                                    "urgency",
                                    "certainty",
                                    "headline",
                                    "sent",
                                    "effective",
                                    "onset",
                                    "expires",
                                    "ends",
                                    "description",
                                    "instruction",
                                )
                            },
                        }
                        for feature in payload["features"]
                    ],
                }
        if isinstance(point_result, Exception):
            result["forecast"] = _unavailable(point_result, points_url)
            if include_observations:
                result["observations"] = _unavailable(point_result, points_url)
        else:
            points = point_result[0].get("properties", {})
            result["location"] = {
                "source_url": points_url,
                "fetched_at": point_result[1],
                "timezone": points.get("timeZone"),
                **{
                    key: points.get("relativeLocation", {})
                    .get("properties", {})
                    .get(key)
                    for key in ("city", "state")
                },
            }

            async def forecast():
                url = _nws_url(points["forecast"])
                data, fetched_at, _ = await self._json(url, "forecast")
                return _forecast(
                    data, fetched_at, url, points["timeZone"], days, datetime.now(UTC)
                )

            operations = [bounded(forecast())]
            if include_observations:
                operations.append(bounded(self._observations(points)))
            outcomes = await asyncio.gather(*operations)
            for name, outcome in zip(("forecast", "observations"), outcomes):
                result[name] = (
                    _unavailable(outcome) if isinstance(outcome, Exception) else outcome
                )
        components = [
            result[name]["status"]
            for name in ("forecast", "alerts", "observations")
            if name in result
        ]
        result["status"] = (
            "ok"
            if all(status == "ok" for status in components)
            else "unavailable"
            if all(status == "unavailable" for status in components)
            else "partial"
        )
        return result


@register_tool(config_type=NwsWeatherFunctionConfig)
async def nws_weather_function(config: NwsWeatherFunctionConfig, builder: ToolRegistry):
    async with AnonymousPublicClient(
        headers={"User-Agent": config.user_agent, "Accept": "application/geo+json"},
        transport=PublicAsyncHTTPTransport(max_response_bytes=2 * 1024 * 1024),
        trust_env=False,
        follow_redirects=False,
        timeout=httpx.Timeout(config.timeout, connect=5),
    ) as client:
        weather_client = NwsWeatherClient(
            client, points_ttl=config.points_cache_ttl_seconds, timeout=config.timeout
        )

        async def _response_fn(
            latitude: float,
            longitude: float,
            days: int = 4,
            include_observations: bool = False,
        ) -> str:
            result = await weather_client.weather(
                latitude, longitude, days, include_observations
            )
            return json.dumps(result, ensure_ascii=False)

        try:
            yield ToolDefinition.from_fn(
                _response_fn,
                input_schema=WeatherInput,
                description=config.description
                or (
                    "Get sourced US weather from the official NWS API by latitude and longitude. "
                    "Returns today and the next three complete local days by default, active "
                    "alerts, fetch/issue times and explicit coverage gaps. Optionally includes "
                    "current observations; never treats unavailable data as no alerts."
                ),
            )
        finally:
            await weather_client.close()
