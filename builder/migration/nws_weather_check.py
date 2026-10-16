"""Compare retained and native NWS requests/cache over real isolated DNS/TLS."""

import argparse
import base64
import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from public_http_check import ROOT
from public_http_check import main as compare

BASE = "https://api.weather.gov"
POINT = "/points/42.3000,-83.1000"


def scenarios():
    cases = []

    def case(name, response=None, config=None, urls=None, **options):
        cases.append(
            {
                "name": name,
                "config": config or {},
                "urls": urls or [BASE + POINT] * 2,
                "responses": {POINT: response or {}},
                **options,
            }
        )

    case("successful_point_cached")
    case("configured_cache_disabled", config={"points_cache_ttl_seconds": 0})
    case("close_clears_cached_points", close_each=True)
    case(
        "cached_point_does_not_fetch_again",
        dns=[["8.8.8.8"], ["8.8.8.8"], ["127.0.0.1"]],
    )
    case(
        "point_load_timeout",
        config={"timeout": 5},
        urls=[BASE + POINT],
        hold=True,
        expected_disconnected=1,
    )
    case(
        "configured_ttl_expires", config={"points_cache_ttl_seconds": 0.01}, pause=0.025
    )
    for directive in [
        "no-store",
        "private",
        "no-cache",
        "max-age=0",
        "public, max-age=60",
    ]:
        case("cache_control_" + directive, {"headers": {"Cache-Control": directive}})
    case(
        "server_age_expired", {"headers": {"Cache-Control": "max-age=30", "Age": "30"}}
    )
    case(
        "set_cookie_not_cached",
        {"headers": {"Set-Cookie": "synthetic=ignored; Path=/"}},
    )
    case("unsuccessful_not_cached", {"status": 503})
    case("missing_redirect_location", {"status": 302})
    case(
        "private_redirect",
        {"status": 302, "headers": {"Location": "http://127.0.0.1/secret"}},
    )
    case(
        "foreign_origin_redirect",
        {"status": 302, "headers": {"Location": "https://other.weather.test/secret"}},
    )
    case(
        "relative_redirect",
        {"status": 302, "headers": {"Location": "/gridpoints/synthetic"}},
    )
    case("redirect_loop", {"status": 302, "headers": {"Location": POINT}})
    case(
        "redirect_encoded_hostname",
        {"status": 302, "headers": {"Location": "https://%61pi.weather.gov/secret"}},
    )
    case(
        "redirect_empty_credentials",
        {"status": 302, "headers": {"Location": "https://@api.weather.gov/secret"}},
    )
    case(
        "redirect_same_scheme_relative",
        {"status": 302, "headers": {"Location": "https:relative"}},
    )
    case(
        "redirect_empty_query",
        urls=[BASE + "/alerts/active?point=x"],
        responses={
            "/alerts/active?point=x": {"status": 302, "headers": {"Location": "?"}}
        },
    )
    for status in [300, 304, 305, 306, 399]:
        case(f"redirect_{status}", {"status": status, "body": ""})
    case("encoding_rejected", {"headers": {"Content-Encoding": "gzip"}})
    case("oversized_body", {"headers": {"Content-Length": "2097153"}, "close": True})
    case("mixed_dns_answers", dns=[["8.8.8.8", "127.0.0.1"]])
    case("dns_rebinding", dns=[["8.8.8.8"], ["127.0.0.1"]])
    for name, raw in [
        ("empty", b""),
        ("malformed", b"{"),
        ("array", b"[]"),
        ("null", b"null"),
        ("nonfinite", b'{"temperature":NaN,"wind":Infinity,"negative":-Infinity}'),
        ("surrogate", b'{"city":"\\ud800","state":"\\udfff"}'),
        ("invalid_utf8", b'{"city":"\xff"}'),
        *[
            (
                encoding,
                json.dumps({"city": "Synthetic 雪🌲"}, ensure_ascii=False).encode(
                    encoding
                ),
            )
            for encoding in [
                "utf-8-sig",
                "utf-16",
                "utf-16-be",
                "utf-16-le",
                "utf-32",
                "utf-32-be",
                "utf-32-le",
            ]
        ],
    ]:
        case("json_" + name, {"body": base64.b64encode(raw).decode()})
    urls = [BASE + f"/points/synthetic-{index}" for index in range(65)]
    case("cache_capacity_64", urls=[*urls, urls[0]])
    case(
        "cache_hit_updates_lru", urls=[*urls[:64], urls[0], urls[64], urls[0], urls[1]]
    )
    for mode in ["concurrent", "cancel_one", "cancel_all", "close", "pending_capacity"]:
        case("lifecycle_" + mode, mode=mode, hold=True, unordered_calls=True)
    return cases


def weather_scenarios(now=None):
    from export_nws_weather import period

    now = now or datetime(2026, 10, 14, 16, 30, tzinfo=UTC)
    forecast = "/gridpoints/DTX/1,1/forecast"
    stations = "/gridpoints/DTX/1,1/stations"
    observation = "/stations/KSYN/observations/latest"
    alerts = "/alerts/active?point=42.3000,-83.1000"
    payloads = {
        POINT: {
            "properties": {
                "forecast": BASE + forecast,
                "observationStations": BASE + stations,
                "timeZone": "America/Detroit",
                "relativeLocation": {
                    "properties": {"city": "Synthetic 雪🌲", "state": "MI"}
                },
            }
        },
        alerts: {
            "updated": now.isoformat(),
            "features": [
                {
                    "id": BASE + "/alerts/synthetic",
                    "properties": {
                        "event": "Synthetic event",
                        "severity": "Minor",
                        "urgency": "Expected",
                        "certainty": "Likely",
                        "headline": "Synthetic alert",
                        "description": "Synthetic evidence only",
                        "instruction": "Synthetic instruction",
                    },
                }
            ],
        },
        forecast: {
            "properties": {
                "updateTime": now.isoformat(),
                "periods": [
                    period(
                        now + timedelta(hours=12 * index - 1),
                        now + timedelta(hours=12 * (index + 1) - 1),
                    )
                    for index in range(17)
                ],
            }
        },
        stations: {"features": [{"id": BASE + "/stations/KSYN"}]},
        observation: {
            "properties": {
                "timestamp": (now - timedelta(minutes=30)).isoformat(),
                "textDescription": "Synthetic clear",
                "temperature": {"value": 20, "unitCode": "wmoUnit:degC"},
                "relativeHumidity": {"value": 50, "unitCode": "wmoUnit:percent"},
                "windSpeed": {"value": 5, "unitCode": "wmoUnit:km_h-1"},
                "visibility": {"value": 10000, "unitCode": "wmoUnit:m"},
            }
        },
    }
    default = {"latitude": 42.3, "longitude": -83.1, "include_observations": True}
    cases = []

    def case(name, updates=None, responses=None, inputs=None, config=None):
        data = copy.deepcopy(payloads)
        for path, update in (updates or {}).items():
            data[path] = update(data[path]) if callable(update) else update
        replies = {
            path: {
                "body": base64.b64encode(
                    json.dumps(value, ensure_ascii=True).encode()
                ).decode()
            }
            for path, value in data.items()
        }
        replies.update(responses or {})
        cases.append(
            {
                "name": name,
                "mode": "weather",
                "now": now.isoformat(),
                "config": config or {},
                "inputs": inputs or [default],
                "responses": replies,
                "unordered_calls": True,
            }
        )

    case("complete_weather")
    case(
        "repeated_weather_refreshes_alerts_forecast_observation",
        inputs=[default, default],
    )
    case(
        "default_forecast_without_observations",
        inputs=[{"latitude": 42.3, "longitude": -83.1}],
    )
    for days in [1, 7]:
        case(f"coverage_{days}_days", inputs=[{**default, "days": days}])
    for path, name in [
        (POINT, "points"),
        (alerts, "alerts"),
        (forecast, "forecast"),
        (stations, "stations"),
        (observation, "observation"),
    ]:
        case(name + "_unavailable", responses={path: {"status": 503}})
        case(name + "_non_object", updates={path: []})
    case(
        "all_sources_unavailable",
        responses={POINT: {"status": 503}, alerts: {"status": 503}},
    )
    case("no_active_alerts", updates={alerts: {"features": []}})
    for name, features in [
        ("missing", None),
        ("object", {}),
        ("null_feature", [None]),
        ("missing_properties", [{}]),
        ("null_properties", [{"properties": None}]),
    ]:
        case(
            "invalid_alerts_" + name,
            updates={alerts: {} if features is None else {"features": features}},
        )
    for name, properties in [
        ("null", None),
        ("list", []),
        ("missing_links", {}),
        ("relative_null", {"relativeLocation": None}),
        ("relative_properties_null", {"relativeLocation": {"properties": None}}),
    ]:
        case("point_properties_" + name, updates={POINT: {"properties": properties}})
    for name, zone in [
        ("unknown", "Synthetic/Unknown"),
        ("absolute", "/etc/passwd"),
        ("null", None),
        ("integer", 1),
    ]:
        case(
            "timezone_" + name,
            updates={
                POINT: lambda payload, zone=zone: {
                    "properties": {**payload["properties"], "timeZone": zone}
                }
            },
        )
    for name, link in [
        ("foreign", "https://other.weather.test/forecast"),
        ("private", "http://127.0.0.1/forecast"),
        ("credentials", "https://user:synthetic@api.weather.gov/forecast"),
        ("missing", None),
    ]:
        case(
            "forecast_link_" + name,
            updates={
                POINT: lambda payload, link=link: {
                    "properties": {**payload["properties"], "forecast": link}
                }
            },
        )
    case(
        "forecast_stale",
        updates={
            forecast: lambda payload: {
                "properties": {
                    **payload["properties"],
                    "updateTime": (now - timedelta(days=2)).isoformat(),
                }
            }
        },
    )
    case(
        "forecast_missing_issue_time",
        updates={
            forecast: lambda payload: {
                "properties": {"periods": payload["properties"]["periods"]}
            }
        },
    )
    case("forecast_empty", updates={forecast: {"properties": {"periods": []}}})
    case(
        "forecast_short_coverage",
        updates={
            forecast: lambda payload: {
                "properties": {
                    **payload["properties"],
                    "periods": payload["properties"]["periods"][:2],
                }
            }
        },
    )
    case(
        "forecast_internal_gap",
        updates={
            forecast: lambda payload: {
                "properties": {
                    **payload["properties"],
                    "periods": [
                        entry
                        for index, entry in enumerate(payload["properties"]["periods"])
                        if index != 1
                    ],
                }
            }
        },
    )
    for field in [
        "temperature",
        "temperatureUnit",
        "shortForecast",
        "detailedForecast",
    ]:

        def missing(payload, field=field):
            payload["properties"]["periods"][0][field] = None
            return payload

        case("forecast_missing_" + field, updates={forecast: missing})
    case(
        "forecast_invalid_period",
        updates={forecast: {"properties": {"periods": [None]}}},
    )
    for name, features in [
        ("none", []),
        ("object", {"0": {"id": BASE + "/stations/KSYN"}}),
        ("string", "x"),
        ("null_station", [None]),
        ("missing_id", [{}]),
        ("foreign", [{"id": "https://other.weather.test/station"}]),
    ]:
        case("station_features_" + name, updates={stations: {"features": features}})
    for name, timestamp in [
        ("stale", (now - timedelta(hours=3)).isoformat()),
        ("future", (now + timedelta(minutes=5)).isoformat()),
        ("naive", now.replace(tzinfo=None).isoformat()),
        ("missing", None),
    ]:
        case(
            "observation_time_" + name,
            updates={
                observation: lambda payload, timestamp=timestamp: {
                    "properties": {**payload["properties"], "timestamp": timestamp}
                }
            },
        )
    case(
        "observation_no_values",
        updates={
            observation: {
                "properties": {
                    "timestamp": now.isoformat(),
                    "temperature": {"value": None},
                }
            }
        },
    )
    case(
        "observation_zero_value",
        updates={
            observation: {
                "properties": {
                    "timestamp": now.isoformat(),
                    "temperature": {"value": 0, "unitCode": "wmoUnit:degC"},
                }
            }
        },
    )
    case("observation_invalid_properties", updates={observation: {"properties": None}})

    def nonfinite(payload):
        payload["properties"]["periods"][0]["temperature"] = float("nan")
        return payload

    case("nonfinite_forecast_value", updates={forecast: nonfinite})
    case(
        "surrogates_from_separate_sources",
        updates={
            POINT: lambda payload: {
                "properties": {
                    **payload["properties"],
                    "relativeLocation": {
                        "properties": {"city": "\ud800", "state": "\U000f0000"}
                    },
                }
            },
            alerts: {
                "features": [{"id": "synthetic", "properties": {"headline": "\udfff"}}]
            },
        },
    )
    case(
        "custom_description_and_agent",
        config={
            "description": "Synthetic weather description",
            "user_agent": "daedalus-fixture/1.0",
        },
    )
    case(
        "invalid_arguments",
        inputs=[
            {},
            {"latitude": 91, "longitude": -83},
            {"latitude": True, "longitude": -83},
            {**default, "days": 8},
        ],
    )
    case("unknown_arguments_ignored", inputs=[{**default, "unknown": "ignored"}])
    for name, config in [
        ("factory_non_ascii_user_agent", {"user_agent": "Synthetic 雪"}),
        ("factory_blank_description", {"description": " \t "}),
    ]:
        case(name, config=config)
        cases[-1]["factory_error"] = True
    return cases


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--weather", action="store_true")
    args = parser.parse_args()
    compare(
        args,
        cases=weather_scenarios() if args.weather else scenarios(),
        python_runner="nws_weather_baseline.py",
        rust_runner="nws_weather::service::tests::actual_service",
        sources=[
            Path(__file__),
            Path(__file__).with_name("nws_weather_baseline.py"),
            ROOT / "runtime/src/nws_weather.rs",
            ROOT / "runtime/src/nws_weather_service.rs",
        ],
        success="passed-native-nws-weather-services"
        if args.weather
        else "passed-native-nws-point-services",
    )
