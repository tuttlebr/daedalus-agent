"""Freeze profile validation and real Hindsight batch construction in P0."""

import argparse
import asyncio
import copy
import json
from pathlib import Path
from unittest.mock import patch

from export_authorization import BASELINE, fixture_strings

OPERATION = "70571a02-55a1-481d-97bb-64acfb0a7c9e"
IMPORTED_AT = "2026-10-13T00:00:00+00:00"


def inputs():
    entry = {"label": "Identity", "memory": "Synthetic preference 雪🌲"}
    values = [
        None,
        [],
        4,
        "profile",
        {},
        {"entries": []},
        {"entries": None},
        {"entries": {}},
        {"entries": [entry]},
    ]
    for field, alternatives in {
        "label": [None, 1, "", " \u001c", "x" * 201, "🌲" * 200],
        "memory": [None, False, "", "\t\u001f", "雪" * 4001, "🌲" * 4000],
        "tags": [
            None,
            "tag",
            [1, None],
            [" x ", "x", "", "\u001c", "雪", "source:profile-import", "user_profile"],
        ],
        "metadata": [
            None,
            [],
            {
                "source": "",
                "label": "forged",
                "imported_at": "forged",
                "profile_version": "custom",
                "category": " spaced category ",
                " key ": {"雪": [1e-5, -0.0, 10**30]},
                "": "ignored",
                "key_value_pairs": {"old": 1, "same": "old"},
            },
        ],
        "key_value_pairs": [None, [], {}, {"same": "new", "雪": [True, None]}],
    }.items():
        values += [{"entries": [{**entry, field: value}]} for value in alternatives]
    values += [
        {"entries": [value]} for value in [None, [], 4, "entry", {}, {"label": "x"}]
    ]
    values += [
        {"entries": [entry], "profile_version": value}
        for value in [None, "", "version 雪", 5, {}]
    ]
    values += [
        {"entries": [entry], "mode": value} for value in [None, "replace", "APPEND", 0]
    ]
    values += [
        {"entries": [entry, entry]},
        {"entries": [entry, {**entry, "label": " Identity "}]},
        {"entries": [entry, {**entry, "label": "identity"}]},
        {
            "entries": [{"label": " ", "memory": None, "tags": [3], "metadata": []}],
            "mode": "bad",
            "profile_version": 2,
        },
        {
            "entries": [
                {"label": str(i), "memory": "Synthetic fact"} for i in range(251)
            ]
        },
        {
            "user_id": "forged-user",
            "bank_id": "forged-bank",
            "profile_version": "fixture",
            "entries": [
                {
                    **entry,
                    "bank_id": "ignored",
                    "tags": ["user_profile", "tag"],
                    "metadata": {"key_value_pairs": "replace"},
                    "key_value_pairs": {"x": "雪"},
                }
            ],
        },
        {
            "entries": [
                {
                    "label": " A \u001c",
                    "memory": "  Trimmed 雪. \u001f",
                    "metadata": {"key_value_pairs": {"old": 1, "same": "old"}},
                    "key_value_pairs": {"same": "new"},
                }
            ]
        },
    ]
    return values


async def export(root):
    import uuid

    import httpx
    import profile_import_api as api
    from fastapi import FastAPI
    from nat_helpers import hindsight_client
    from nat_helpers.internal_auth import DaedalusInternalAuthMiddleware

    validation_app = FastAPI()

    @validation_app.post("/validate")
    async def validate(body: api.ProfileImportRequest):
        return body.model_dump()

    cases = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=validation_app), base_url="http://fixture"
    ) as client:
        for value in inputs():
            result = await client.post(
                "/validate",
                content=json.dumps(value),
                headers={"Content-Type": "application/json"},
            )
            cases.append(
                {
                    "input": value,
                    "status": result.status_code,
                    "expected": result.json(),
                }
            )

    batches = []
    app = FastAPI()
    app.include_router(api.router)
    app.add_middleware(DaedalusInternalAuthMiddleware)
    for case in cases:
        if case["status"] != 200:
            continue
        for mode in ["append", "replace"]:
            value = copy.deepcopy(case["input"])
            value["mode"] = mode
            calls = []

            async def peer(request):
                body = json.loads(request.content) if request.content else None
                calls.append(
                    {
                        "method": request.method,
                        "path": request.url.raw_path.decode().split("?")[0],
                        "query": dict(request.url.params),
                        "body": body,
                        "authorization": request.headers.get("authorization"),
                    }
                )
                if request.method == "GET":
                    return httpx.Response(
                        200,
                        json={
                            "items": [{"id": "old-z"}, {"id": "old-a"}, {"id": "old-z"}]
                        },
                    )
                if request.method == "DELETE":
                    return httpx.Response(204)
                return httpx.Response(
                    200, json={"success": True, "operation_id": OPERATION}
                )

            hindsight = hindsight_client.HindsightClient(
                base_url="http://hindsight.invalid",
                api_key="synthetic-hindsight",
                transport=httpx.MockTransport(peer),
            )
            with patch.object(
                api.uuid, "uuid4", return_value=uuid.UUID(OPERATION)
            ), patch.object(api, "_now_iso", return_value=IMPORTED_AT), patch.object(
                hindsight_client, "client_from_env", return_value=hindsight
            ), patch.dict(
                "os.environ",
                {
                    "DAEDALUS_INTERNAL_API_TOKEN": "synthetic-internal",
                    "DAEDALUS_MEMORY_MODE": "hindsight",
                },
            ):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://fixture"
                ) as client:
                    response = await client.post(
                        "/v1/profile/import",
                        json=value,
                        headers={
                            "x-user-id": "synthetic-alice",
                            "x-daedalus-internal-token": "synthetic-internal",
                        },
                    )
            await hindsight.aclose()
            batches.append(
                {
                    "input": value,
                    "normalized": {**case["expected"], "mode": mode},
                    "status": response.status_code,
                    "expected": response.json(),
                    "calls": calls,
                }
            )
    result = {
        "baseline_sha": BASELINE,
        "operation": OPERATION,
        "imported_at": IMPORTED_AT,
        "cases": cases,
        "batches": batches,
    }
    (root / "tests/fixtures/profile-import.json").write_text(
        json.dumps(fixture_strings(result), ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
