"""Freeze batch orchestration while replacing only individual document work."""

import argparse
import asyncio
import copy
import json
from pathlib import Path
from unittest.mock import patch

from export_authorization import BASELINE, fixture_strings


def references(count):
    return [
        {
            "documentId": f"document-{i}",
            "sessionId": "synthetic-session",
            "filename": f"Synthetic {i} 雪🌲.txt",
        }
        for i in range(count)
    ]


async def run_case(document, case):
    config = document.NvIngestFunctionConfig(**case.get("config", {}))
    processor = document.NvIngestDocumentProcessor(config)
    progress, calls = [], []
    active, peak = 0, 0

    async def emit(event):
        progress.append(copy.deepcopy(event))
        if case.get("callback_error"):
            raise RuntimeError("Synthetic progress callback failure")

    async def process_document(**kwargs):
        nonlocal active, peak
        callback = kwargs.pop("progress_callback")
        calls.append(copy.deepcopy(kwargs))
        active += 1
        peak = max(peak, active)
        ref = kwargs["documentRef"]
        outcome = case.get("outcomes", {}).get(ref.get("documentId"), {})
        try:
            for event in case.get("stages", [{"phase": "processing"}]):
                await callback(copy.deepcopy(event))
                await asyncio.sleep(0)
            if outcome.get("exception"):
                kind = (
                    TimeoutError
                    if outcome["exception"] == "TimeoutError"
                    else RuntimeError
                )
                raise kind(outcome.get("error", "Synthetic exception"))
            return {
                "status": "success",
                "filename": ref.get("filename", ""),
                "chunks": 2,
                "pages": 3,
                "failures": 0,
                "collection": kwargs["collection_name"],
                "markdown": "",
                "error": "",
                **outcome,
            }
        finally:
            active -= 1

    with patch.object(processor, "process_document", process_document):
        try:
            expected = {
                "ok": await processor.process_multiple_documents(
                    **copy.deepcopy(case["request"]), progress_callback=emit
                )
            }
        except Exception as error:
            expected = {"error": type(error).__name__, "message": str(error)}
    return {
        **case,
        "expected": expected,
        "events": progress,
        "calls": calls,
        "peak": peak,
    }


async def export(root):
    import nat_nv_ingest.nat_nv_ingest as document

    cases = []

    def add(name, refs=None, **kwargs):
        request = {
            "documentRefs": references(3) if refs is None else refs,
            "username": "alice",
        }
        request.update(kwargs.pop("request", {}))
        cases.append({"name": name, "request": request, **kwargs})

    for count in [1, 2, 3, 10, 11]:
        add(f"sequential-{count}", references(count))
    for concurrency in [-1, 0, 1, 2, 4]:
        for batch in [-1, 1, 2, 3, 20]:
            add(
                f"capacity-{concurrency}-{batch}",
                references(5),
                config={
                    "batch_concurrency": concurrency,
                    "max_documents_per_batch": batch,
                },
            )
    for recreate in [False, True]:
        for concurrency in [1, 2]:
            for position in [0, 1, 2, 4]:
                for exception in [False, True]:
                    add(
                        f"timeout-{recreate}-{concurrency}-{position}-{exception}",
                        references(5),
                        config={
                            "recreate_collection": recreate,
                            "batch_concurrency": concurrency,
                            "max_documents_per_batch": 2,
                        },
                        outcomes={
                            f"document-{position}": {
                                "status": "failure",
                                "error": "SYNTHETIC TIMED OUT",
                                **({"exception": "TimeoutError"} if exception else {}),
                            }
                        },
                    )
    for kind in ["failure", "partial", "exception", "timeout-text-exception"]:
        outcome = {"status": kind, "failures": 1, "error": "Synthetic error 雪🌲" * 10}
        if "exception" in kind:
            outcome.update(exception="RuntimeError", error="Synthetic timed out")
        add(f"outcome-{kind}", outcomes={"document-1": outcome})
        add(f"all-{kind}", outcomes={f"document-{i}": outcome for i in range(3)})
    add(
        "returned-filename",
        outcomes={"document-1": {"filename": "Stored name 雪🌲.txt"}},
    )
    add("empty-filename", [dict(ref, filename="") for ref in references(3)])
    add("null-filename", [dict(ref, filename=None) for ref in references(3)])
    add(
        "missing-filename",
        [{k: v for k, v in ref.items() if k != "filename"} for ref in references(3)],
    )
    add("missing-identity", [{}, {}])
    add(
        "duplicate-id",
        references(2)
        + [dict(references(1)[0], sessionId="other", filename="Duplicate.txt")],
    )
    add("empty-input", [])
    add("non-list-input", {})
    add("non-object-reference", [None])
    add("empty-user", request={"username": ""})
    add("callback-errors", callback_error=True)
    for name, value in [
        ("default", None),
        ("explicit", "new"),
        ("legacy", "old_alice"),
        ("shared", "nvidia"),
        ("shared-case", " NVIDIA "),
    ]:
        add(f"collection-{name}", request={"collection_name": value})
    for scope in ["user", "shared", " USER ", "invalid"]:
        add(f"scope-{scope}", request={"collection_scope": scope})
    add("custom-default", config={"default_collection_name": "custom"})
    add("chunk-overrides", request={"chunk_size": 32, "chunk_overlap": 0})
    add("chunk-defaults", config={"chunk_size": 64, "chunk_overlap": 4})
    add(
        "provenance", request={"provenance": {"source": "synthetic", "unicode": "雪🌲"}}
    )
    add(
        "all-phases",
        references(1),
        stages=[
            {"phase": phase, "attempt": 2} for phase in document._PROGRESS_PHASE_WEIGHTS
        ]
        + [
            {
                "phase": "",
                "current": "",
                "message": "",
                "completed": 100,
                "currentIndex": 88,
                "percent": 50,
                "total": 900,
                "chunks": 5,
                "pages": 4,
                "failures": 1,
                "extra": "preserved",
            },
            {"current": "Reported filename.txt", "message": "Synthetic detail"},
            {"phase": "unknown", "message": None},
        ],
    )
    output = {
        "baseline_sha": BASELINE,
        "cases": [await run_case(document, case) for case in cases],
    }
    path = root / "tests/fixtures/document-batch.json"
    path.write_text(
        json.dumps(fixture_strings(output), ensure_ascii=False, indent=2) + "\n"
    )
    print(f"Frozen {len(cases)} retained batch scenarios")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
