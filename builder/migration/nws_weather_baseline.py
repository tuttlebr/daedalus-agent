"""Exercise the retained NWS points cache against actual public DNS/TLS peers."""

import argparse
import asyncio
import contextlib
import json
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import httpx
from nat_helpers.public_content import AnonymousPublicClient
from nat_helpers.safe_http import PublicAsyncHTTPTransport
from webscrape.nws_weather_function import NwsWeatherClient, NwsWeatherFunctionConfig


async def weather(case):
    from webscrape import nws_weather_function as nws

    fixed = datetime.fromisoformat(case["now"])

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

    factory = contextlib.asynccontextmanager(nws.nws_weather_function)
    # Only the formatting/freshness clock is fixed. DNS, sockets, HTTP, TLS,
    # monotonic cache expiry and the registered tool invocation are unchanged.
    try:
        with patch.object(nws, "datetime", Clock):
            async with factory(
                NwsWeatherFunctionConfig.model_validate(case["config"]), None
            ) as tool:
                schema = tool.schema("nws_weather")
                responses = []
                for raw in case["inputs"]:
                    try:
                        text = await tool.ainvoke(raw)
                        try:
                            text.encode("utf-8")
                        except UnicodeEncodeError:
                            text = {
                                "$codepoints": [ord(character) for character in text]
                            }
                        responses.append({"ok": text})
                    except Exception as error:
                        value = {"error": type(error).__name__}
                        if type(error).__name__ == "ValidationError":
                            value["validation"] = [
                                {
                                    key: val
                                    for key, val in item.items()
                                    if key not in {"input", "url"}
                                }
                                for item in error.errors(
                                    include_url=False, include_input=False
                                )
                            ]
                            for item in value["validation"]:
                                if "ctx" in item:
                                    item["ctx"] = {
                                        key: str(val)
                                        for key, val in item["ctx"].items()
                                    }
                        responses.append(value)
                return {"schema": schema, "responses": responses}
    except Exception as error:
        return {"startup_error": type(error).__name__}


def observation(result, times):
    if isinstance(result, BaseException):
        return {"error": type(result).__name__}
    payload, fetched, headers = result
    if fetched not in times:
        times.append(fetched)
    text = json.dumps(payload, ensure_ascii=False)
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        text = {"$codepoints": [ord(character) for character in text]}
    return {"ok": text, "fetch": times.index(fetched), "headers": dict(headers)}


async def run(case):
    if case.get("mode") == "weather":
        return await weather(case)
    config = NwsWeatherFunctionConfig.model_validate(case["config"])
    async with AnonymousPublicClient(
        headers={"User-Agent": config.user_agent, "Accept": "application/geo+json"},
        transport=PublicAsyncHTTPTransport(max_response_bytes=2 * 1024 * 1024),
        trust_env=False,
        follow_redirects=False,
        timeout=httpx.Timeout(config.timeout, connect=5),
    ) as http:
        client = NwsWeatherClient(
            http, points_ttl=config.points_cache_ttl_seconds, timeout=config.timeout
        )
        times, results = [], []

        async def point(url):
            try:
                return await client._point(url)
            except BaseException as error:
                return error

        async with httpx.AsyncClient(trust_env=False) as control:

            async def wait(key, count):
                for _ in range(500):
                    state = (await control.get("http://127.0.0.1:9090/state")).json()
                    if state[key] >= count:
                        return
                    await asyncio.sleep(0.02)
                raise AssertionError(
                    f"Peer did not reach {key}={count}: held={state['held']}, disconnected={state['disconnected']}, calls={len(state['calls'])}, TLS={len(state['sni'])}"
                )

            async def release():
                await control.post("http://127.0.0.1:9090/release", json={})

            async def lifecycle(mode):
                url = case["urls"][0]
                if mode == "concurrent":
                    tasks = [asyncio.create_task(point(url)) for _ in range(8)]
                    await wait("held", 1)
                    await release()
                    return await asyncio.gather(*tasks)
                if mode == "pending_capacity":
                    tasks = [
                        asyncio.create_task(
                            point(f"https://api.weather.gov/points/pending-{index}")
                        )
                        for index in range(64)
                    ]
                    await wait("held", 64)
                    overflow = [asyncio.create_task(point(url)) for _ in range(2)]
                    await wait("held", 66)
                    for task in overflow:
                        task.cancel()
                    cancelled = await asyncio.gather(*overflow)
                    await wait("disconnected", 2)
                    await release()
                    loaded = await asyncio.gather(*tasks)
                    return [*cancelled, *loaded, await point(url)]
                task = asyncio.create_task(point(url))
                await wait("held", 1)
                second = (
                    asyncio.create_task(point(url)) if mode == "cancel_one" else None
                )
                if second:
                    await asyncio.sleep(0)
                if mode == "close":
                    await client.close()
                    cancelled = await task
                    await wait("disconnected", 1)
                else:
                    task.cancel()
                    cancelled = await task
                    state = (await control.get("http://127.0.0.1:9090/state")).json()
                    if state["disconnected"] != 0:
                        raise AssertionError(
                            "Cancelling a waiter closed the shared load"
                        )
                await release()
                loaded = await second if second else await point(url)
                return [cancelled, loaded, await point(url)]

            try:
                if case.get("mode"):
                    results = [
                        observation(value, times)
                        for value in await lifecycle(case["mode"])
                    ]
                else:
                    for url in case["urls"]:
                        results.append(observation(await point(url), times))
                        if case.get("close_each"):
                            await client.close()
                        await asyncio.sleep(case.get("pause", 0))
            finally:
                await client.close()
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(
        json.dumps(asyncio.run(run(json.loads(args.input.read_text()))))
    )
