#!/usr/bin/env python3
"""Drive the retained idempotency helper without replacing its Redis client."""

import asyncio
import dataclasses
import hashlib
import inspect
import json
import os
import sys

from nat_helpers import idempotency


async def execute(request):
    for name in ["REDIS_URL", "REDIS_PORT", "AUTONOMY_IDEMPOTENCY_TTL_SECONDS"]:
        os.environ.pop(name, None)
    os.environ.update(request["environment"])
    if request["operation"] == "reserve":
        compatibility = (
            {
                "contract": request["contract"],
                "legacy_arguments": request.get("legacy_arguments"),
            }
            if request.get("contract")
            else {}
        )
        reservation = await idempotency.reserve_operation(
            user_id=request["user"],
            execution_id=request["execution"],
            operation="ingest_user_documents",
            arguments=request["arguments"],
            **compatibility,
        )
        observation = dataclasses.asdict(reservation)
        if observation.get("contract") is None:
            observation.pop("contract", None)
        result = observation.get("stored_result")
        if isinstance(result, str) and any(0xD800 <= ord(c) <= 0xDFFF for c in result):
            observation["stored_result"] = {"$codepoints": list(map(ord, result))}
        return {
            "acquired": reservation.acquired,
            "reservation": observation,
        }
    return {
        "completed": await idempotency.complete_operation(
            idempotency.Reservation(**request["reservation"]), request["result"]
        )
    }


print(
    "RESERVATION_SOURCE "
    + hashlib.sha256(inspect.getsource(idempotency).encode()).hexdigest(),
    flush=True,
)
for line in sys.stdin:
    try:
        result = asyncio.run(execute(json.loads(line)))
    except Exception:
        # Compare failure/no-write behavior without leaking driver diagnostics.
        result = {"error": True}
    print("RESERVATION_RESULT " + json.dumps(result), flush=True)
