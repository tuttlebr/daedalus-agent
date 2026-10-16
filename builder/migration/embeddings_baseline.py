"""Exercise the retained embedding client with actual HTTP/TLS transports."""

import argparse
import asyncio
import json
import struct
from pathlib import Path

from export_embeddings import error


async def main(args):
    import httpx
    from nat_helpers.vllm_embeddings import (
        DaedalusVLLMEmbedderConfig,
        create_embeddings,
    )

    fixture = json.loads(args.input.read_text())
    observations = []
    async with httpx.AsyncClient(trust_env=False, timeout=10) as control:
        for case in fixture["cases"]:
            (
                await control.post(fixture["control"] + "/__reset", json=case)
            ).raise_for_status()
            results = []
            try:
                client = create_embeddings(
                    DaedalusVLLMEmbedderConfig.model_validate(case["config"])
                )
                initialization = {"ok": True}
            except Exception as exc:
                initialization = error(exc)
                client = None
            if client:

                async def query(text):
                    try:
                        vector = await asyncio.to_thread(client.embed_query, text)
                        return {"bits": [struct.pack(">d", n).hex() for n in vector]}
                    except Exception as exc:
                        return error(exc)

                try:
                    if case.get("parallel"):
                        results = list(
                            await asyncio.gather(
                                *(query(text) for text in case["queries"])
                            )
                        )
                    else:
                        results = [await query(text) for text in case["queries"]]
                finally:
                    await client.aclose()
            calls = (await control.get(fixture["control"] + "/__calls")).json()
            observations.append(
                {"initialization": initialization, "results": results, "calls": calls}
            )
            print("Retained embeddings: " + case["name"], flush=True)
    args.output.write_text(json.dumps(observations))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
