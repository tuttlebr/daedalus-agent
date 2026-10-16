"""Capture NWS validation and forecast formatting with the retained runtime.

The argument cases replace only the network boundary with a failing operation.
They are offline evidence; actual DNS, TLS, caching and cancellation need the
separate service and built-image acceptance gates before native activation.
"""

import argparse
import asyncio
import contextlib
import copy
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from export_llm_sandbox import fixture_strings
from export_perplexity_search import canonical, observation
from export_user_interaction import failure


def period(start, end, **fields):
    return {
        "name": "Synthetic forecast 雪🌲",
        "startTime": start.isoformat(),
        "endTime": end.isoformat(),
        "isDaytime": True,
        "temperature": 70,
        "temperatureUnit": "F",
        "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": 20},
        "windSpeed": "5 mph",
        "windDirection": "N",
        "shortForecast": "Synthetic sunny forecast",
        "detailedForecast": "Synthetic weather evidence.",
        **fields,
    }


async def export(root):
    from nat_helpers.public_content import _cache_ttl
    from webscrape import nws_weather_function as nws

    factory = contextlib.asynccontextmanager(nws.nws_weather_function)
    defaults = nws.NwsWeatherFunctionConfig()
    async with factory(defaults, None) as tool:
        resource = {
            "defaults": defaults.model_dump(mode="python"),
            "configuration_schema": defaults.model_json_schema(),
            "schema": tool.schema("nws_weather"),
        }
        inputs = []
        raw_inputs = [
            {},
            None,
            [],
            {"latitude": 42.3},
            {"latitude": 42.3, "longitude": -83.1, "extra": True},
        ]
        for field in ["latitude", "longitude", "days", "include_observations"]:
            for value in [
                None,
                "",
                " ",
                "42.3",
                "1_0",
                "true",
                "off",
                "NaN",
                "Infinity",
                [],
                {},
                False,
                True,
                -181,
                -180,
                -91,
                -90,
                -1,
                0,
                1,
                1.5,
                4,
                7,
                8,
                90,
                91,
                180,
                181,
                1e30,
            ]:
                raw_inputs.append({"latitude": 42.3, "longitude": -83.1, field: value})
        raw_inputs += [
            {
                "latitude": latitude,
                "longitude": longitude,
                "days": 1,
                "include_observations": True,
            }
            for latitude, longitude in [
                (0.0, -0.0),
                (42.34565, -83.12345),
                (89.99999, -179.99999),
                (0.00005, -0.00005),
            ]
        ]
        with patch.object(
            nws.NwsWeatherClient,
            "_json",
            AsyncMock(side_effect=RuntimeError("Synthetic offline transport")),
        ):
            for raw in raw_inputs:
                try:
                    expected = {"ok": await tool.ainvoke(raw)}
                except Exception as error:
                    expected = failure(error)
                inputs.append({"input": raw, "expected": expected})

    configurations = []
    for field in [*resource["configuration_schema"]["properties"], "unknown"]:
        for value in [
            None,
            "",
            "Synthetic",
            " \t\u001c",
            0,
            -1,
            1,
            4.9,
            5,
            20,
            60,
            61,
            86400,
            86401,
            True,
            False,
            [],
            {},
            "5",
            "5.0",
            "NaN",
            "Infinity",
            "off",
            "1_0",
        ]:
            raw = {field: value}
            try:
                config = nws.NwsWeatherFunctionConfig.model_validate(raw)
                expected = {"ok": canonical(config.model_dump(mode="python"))}
                try:
                    async with factory(config, None) as tool:
                        expected["schema"] = tool.schema("configured_weather")
                except Exception as error:
                    expected["schema_error"] = type(error).__name__
            except ValueError:
                expected = {"error": True}
            configurations.append({"input": raw, "expected": expected})

    urls = [
        None,
        0,
        [],
        {},
        "",
        "https://api.weather.gov",
        "https://API.WEATHER.GOV/a?b=c#fragment",
        "HTTPS://api.weather.gov/a",
        " https://api.weather.gov/a ",
        "https://api.weather.gov./a",
        "https://api.weather.gov:443/a",
        "https://api.weather.gov:0443/a",
        "https://api.weather.gov:/a",
        "https://api.weather.gov:bad/a",
        "https://api.weather.gov:65536/a",
        "https://api.weather.gov:444/a",
        "http://api.weather.gov/a",
        "https://user@api.weather.gov/a",
        "https://:pass@api.weather.gov/a",
        "https://api.weather.gov.attacker.invalid/a",
        "https://api.weather.gov\\@attacker.invalid/a",
        "https://[::1]/a",
        "https://[broken/a",
        "https://api.weather.gov\n/a",
        "//api.weather.gov/a",
        "https://api.weather.gov/a;b?x=1",
    ]
    times = [
        None,
        1,
        [],
        {},
        "",
        "2026-10-14",
        "2026-10-14T12:34:56",
        "2026-10-14T12:34:56Z",
        "20261014T123456+0000",
        "2026-W42-3T12:34:56+00:00",
        "2026-10-14 12:34:56.1234567+05:30",
        "2026-10-14🌲12:34:56,1-04:00",
        "2026-10-14T12Z",
        "2026-10-14T12:34+00:00:00.5",
        "2026-10-14T12:34:56+00:00:01.5",
        "2026-10-14T12:34:56+24:00",
        "2026-10-14T25:00:00Z",
        "2026-02-29T00:00:00Z",
        "2028-02-29T00:00:00Z",
        "2026-10-14T12:34:60Z",
        "2026-10-14T12:34:56z",
        " 2026-10-14T12:34:56Z",
        "2026-10-14T12:34:56Z ",
        "0001-01-01T00:00:00Z",
        "9999-12-31T23:59:59Z",
    ]

    def parsed_time(raw):
        value = nws._parse_time(raw)
        return value.isoformat() if value is not None else None

    forecasts = []

    def add_forecast(name, payload, now, zone="America/Detroit", days=4):
        fetched = now.isoformat()
        source = "https://api.weather.gov/gridpoints/DTX/1,1/forecast"
        forecasts.append(
            {
                "name": name,
                "payload": payload,
                "now": fetched,
                "fetched_at": fetched,
                "source_url": source,
                "timezone": zone,
                "days": days,
                "expected": observation(
                    nws._forecast, payload, fetched, source, zone, days, now
                ),
            }
        )

    for date in [
        "2026-10-14T12:34:56+00:00",
        "2026-03-08T06:30:00+00:00",
        "2026-11-01T05:30:00+00:00",
        "2028-02-28T23:00:00+00:00",
        "2026-12-31T23:00:00+00:00",
    ]:
        now = datetime.fromisoformat(date)
        periods = [
            period(now + timedelta(hours=i * 12), now + timedelta(hours=(i + 1) * 12))
            for i in range(16)
        ]
        payload = {"properties": {"updateTime": now.isoformat(), "periods": periods}}
        for zone in [
            "UTC",
            "America/Detroit",
            "America/Phoenix",
            "America/Anchorage",
            "Pacific/Honolulu",
            "Pacific/Guam",
        ]:
            for days in [1, 4, 7]:
                add_forecast("complete", payload, now, zone, days)
        for name, changed in [
            ("empty", []),
            ("missing-tail", periods[:2]),
            ("internal-gap", [periods[0], *periods[2:]]),
            ("unsorted", list(reversed(periods))),
            (
                "overlap",
                [period(now - timedelta(hours=2), now + timedelta(days=5)), *periods],
            ),
            ("expired", [period(now - timedelta(days=2), now), *periods]),
            ("zero-duration", [period(now, now), *periods]),
        ]:
            add_forecast(
                name, {"properties": {**payload["properties"], "periods": changed}}, now
            )
        for field in ["updateTime", "generatedAt"]:
            for issue in [
                None,
                "bad",
                (now - timedelta(hours=24)).isoformat(),
                (now - timedelta(hours=24, microseconds=1)).isoformat(),
                (now + timedelta(days=2)).isoformat(),
            ]:
                add_forecast(
                    "issue-time",
                    {"properties": {field: issue, "periods": periods}},
                    now,
                )
    now = datetime(2026, 10, 14, 12, tzinfo=UTC)
    base = {
        "properties": {
            "updateTime": now.isoformat(),
            "periods": [period(now, now + timedelta(days=5))],
        }
    }
    for field in [
        "temperature",
        "temperatureUnit",
        "shortForecast",
        "detailedForecast",
        "startTime",
        "endTime",
        "name",
    ]:
        for value in [None, "", 0, False, [], {}, "bad"]:
            changed = copy.deepcopy(base)
            changed["properties"]["periods"][0][field] = value
            add_forecast("period-field", changed, now)
    for payload in [
        None,
        [],
        0,
        {},
        {"properties": None},
        {"properties": []},
        {"properties": {"periods": None}},
        {"properties": {"periods": [None]}},
        {"properties": {"periods": [1]}},
    ]:
        add_forecast("response-type", payload, now)
    for zone in ["", "Invalid/Zone", "/etc/passwd", "../UTC", "America/New_York"]:
        add_forecast("timezone", base, now, zone)
    ttl = []
    for headers in [
        {},
        *[
            {"cache-control": value}
            for value in [
                "max-age=20",
                'public, max-age="30"',
                "Max-Age = 50",
                "s-maxage=40",
                "max-age=0",
                "max-age=-1",
                "max-age=1.5",
                "max-age=5, max-age=20",
                "private",
                "no-cache",
                "no-store",
                "public, max-age=20, private",
                "private-extension=1",
            ]
        ],
        {"cache-control": "max-age=20", "age": "5"},
        {"cache-control": "max-age=20", "age": "100"},
        {"cache-control": "max-age=20", "age": "-1"},
        {"set-cookie": "synthetic=one"},
        {"set-cookie": ""},
    ]:
        for default in [0, 10, 86400]:
            ttl.append(
                {
                    "headers": headers,
                    "default": default,
                    "expected": _cache_ttl(httpx.Headers(headers), default),
                }
            )

    fixtures = {
        "configuration": configurations,
        "inputs": inputs,
        "urls": [
            {"input": raw, "expected": observation(nws._nws_url, raw)} for raw in urls
        ],
        "times": [
            {"input": raw, "expected": observation(parsed_time, raw)} for raw in times
        ],
        "forecasts": forecasts,
        "cache_ttl": ttl,
    }
    resource["source_sha256"] = hashlib.sha256(
        Path(nws.__file__).read_bytes()
    ).hexdigest()
    files = [
        ("resources", "nws-weather.json", resource),
        (
            "tests/fixtures",
            "nws-weather.json",
            fixture_strings(
                {key: value for key, value in fixtures.items() if key != "forecasts"}
            ),
        ),
        *[
            (
                "tests/fixtures",
                f"nws-weather-forecasts-{offset // 40}.json",
                fixture_strings({"forecasts": forecasts[offset : offset + 40]}),
            )
            for offset in range(0, len(forecasts), 40)
        ],
    ]
    for directory, name, value in files:
        path = root / directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        )
    print({name: len(value) for name, value in fixtures.items()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
