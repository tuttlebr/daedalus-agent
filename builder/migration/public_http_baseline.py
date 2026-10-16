"""Exercise the retained public transport against the isolated real DNS/TLS peer."""

import argparse
import asyncio
import base64
import json
from pathlib import Path

import httpx
from nat_helpers.public_content import AnonymousPublicClient
from nat_helpers.safe_http import PublicAsyncHTTPTransport
from nat_helpers.url_guard import validate_public_url


async def run(case):
    results = []
    async with AnonymousPublicClient(
        headers=case["headers"],
        timeout=httpx.Timeout(case.get("timeout", 1), connect=1),
        transport=PublicAsyncHTTPTransport(max_response_bytes=case.get("limit", 1024)),
        trust_env=False,
        follow_redirects=False,
    ) as client:
        for url in case["urls"]:
            try:
                await asyncio.to_thread(validate_public_url, url)
                response = await client.get(url)
                result = {
                    "ok": {
                        "status": response.status_code,
                        "headers": dict(response.headers),
                        "body": base64.b64encode(response.content).decode(),
                    }
                }
            except Exception as error:
                result = {"error": type(error).__name__}
            results.append(result)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(
        json.dumps(asyncio.run(run(json.loads(args.input.read_text()))))
    )
