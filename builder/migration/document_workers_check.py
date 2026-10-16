"""Verify shared NV-Ingest scheduling through built-image document endpoints.

Each SSE request targets an independent collection. Progress barriers prove all
requests reached processing before inspecting the held NV requests. The peer
returns explicit job failures after release, so this scheduling test performs
no indexing writes. Existing indexing acceptance covers successful writes.
"""

import argparse
import base64
import copy
import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from documents_check import DocumentPeers
from image_check import environment, require, run
from ingestion_check import stream_events

ROOT = Path(__file__).resolve().parents[1]


class Workers(DocumentPeers):
    def __init__(self):
        super().__init__()
        self.condition = threading.Condition()
        self.release = threading.Event()
        self.method = "POST"
        self.active = 0
        self.peak = 0
        self.entered = 0
        self.calls = []

    def reset(self, method):
        with self.condition:
            require(
                self.condition.wait_for(lambda: self.active == 0, 5),
                "Previous NV request did not finish",
            )
            self.release.clear()
            self.method = method
            self.peak = self.entered = 0
            self.calls.clear()

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def nv_request(self):
                body = None
                if self.command == "POST":
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    body = json.loads(body["payload"])
                with peers.condition:
                    peers.calls.append({"method": self.command, "body": body})
                    held = self.command == peers.method
                    counted = held and not peers.release.is_set()
                    if held:
                        peers.entered += 1
                    if counted:
                        peers.active += 1
                        peers.peak = max(peers.peak, peers.active)
                    if held:
                        peers.condition.notify_all()
                try:
                    if held and not peers.release.wait(20):
                        raise TimeoutError("NV scheduling fixture was never released")
                    if self.command == "POST" and peers.method == "GET":
                        self.reply(body["job_payload"]["source_name"][0])
                    elif self.command == "POST":
                        self.reply(
                            {"detail": "Synthetic terminal submission failure"}, 503
                        )
                    else:
                        self.reply({"status": "failed", "data": []})
                finally:
                    if counted:
                        with peers.condition:
                            peers.active -= 1
                            peers.condition.notify_all()

            def do_POST(self):
                if self.path == "/v2/submit_job":
                    return self.nv_request()
                return super().do_POST()

            def do_GET(self):
                if self.path.startswith("/v2/fetch_job/"):
                    return self.nv_request()
                return super().do_GET()

        return Handler


def exercise(image, redis_image, *, native=False, minimal=False):
    output = []
    for workers in [1, 2]:
        peers = Workers()
        with environment(
            image,
            redis_image,
            minimal=minimal,
            memory=False,
            peers=peers,
            redis_json=True,
            extra_env=lambda port: {
                "DAEDALUS_PREPARATION": "rust" if native else "python",
                "DAEDALUS_AUTHORIZATION": "rust" if native else "python",
                "NV_INGEST_HOST": "127.0.0.1",
                "NV_INGEST_PORT": str(port),
                "DOCUMENT_INGEST_WORKER_POOL_SIZE": str(workers),
                "DOCUMENT_INGEST_MAX_RETRIES": "0",
                "DOCUMENT_INGEST_TIMEOUT_SECONDS": "20",
                # Both implementations fail open on this dimension-read error.
                "MILVUS_URI": "invalid://synthetic-unavailable",
            },
        ) as fixture:
            for index in range(workers + 2):
                fixture["redis"].execute_command(
                    "JSON.SET",
                    f"document:worker-session:document-{index}",
                    "$",
                    json.dumps(
                        {
                            "userId": "synthetic-alice",
                            "filename": f"fixture-{index}.txt",
                            "data": base64.b64encode(
                                b"Synthetic worker fixture"
                            ).decode(),
                        }
                    ),
                )
            for method in ["POST", "GET"]:
                peers.reset(method)
                count = workers + 2
                processing = [threading.Event() for _ in range(count)]

                def request(index):
                    with fixture["client"].stream(
                        "POST",
                        fixture["base"] + "/v1/documents/ingest/stream",
                        headers=fixture["headers"],
                        json={
                            "documentRef": {
                                "documentId": f"document-{index}",
                                "sessionId": "worker-session",
                            },
                            "collection_name": f"worker_{workers}_{method.lower()}_{index}",
                        },
                    ) as response:
                        response.raise_for_status()
                        events = []
                        for event, payload in stream_events(response):
                            events.append([event, payload])
                            if event == "progress" and payload["phase"] == "processing":
                                processing[index].set()
                        require(
                            events and events[-1][0] == "complete",
                            "Document stream did not complete",
                        )
                        return events

                with ThreadPoolExecutor(max_workers=count) as pool:
                    pending = [pool.submit(request, index) for index in range(count)]
                    try:
                        for barrier in processing:
                            require(
                                barrier.wait(12), "A document never reached processing"
                            )
                        with peers.condition:
                            require(
                                peers.condition.wait_for(
                                    lambda: peers.entered >= workers, 5
                                ),
                                "Worker slots were not used",
                            )
                            # All request producers have crossed their processing
                            # barrier. Give a broken unbounded client an opportunity
                            # to expose additional requests while every slot is held.
                            excess = peers.condition.wait_for(
                                lambda: peers.entered > workers, 0.5
                            )
                            require(
                                not excess,
                                f"{image}: {method} exceeded worker limit {workers}: {peers.entered}",
                            )
                    finally:
                        peers.release.set()
                    responses = [future.result(timeout=25) for future in pending]
                calls = copy.deepcopy(peers.calls)
                calls.sort(
                    key=lambda call: (
                        call["method"],
                        json.dumps(call["body"], sort_keys=True),
                    )
                )
                require(
                    peers.entered == count, "A queued document never reached NV-Ingest"
                )
                require(peers.peak == workers, "Shared worker capacity changed")
                output.append(
                    {
                        "workers": workers,
                        "held_method": method,
                        "peak": peers.peak,
                        "entered": peers.entered,
                        "events": responses,
                        "calls": calls,
                    }
                )
                print(f"Verified {image}: {workers} workers, held {method}", flush=True)
    return output


def main(args):
    baseline = exercise(args.baseline, args.redis_image)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    oracle = args.report.with_name(args.report.stem + "-baseline.json")
    oracle.write_text(json.dumps(baseline, indent=2) + "\n")
    profiles = [{"image": args.baseline, "native": False, "cases": len(baseline)}]
    candidates = [(args.image, True, True)] if args.image else []
    if args.full_image:
        candidates += [(args.full_image, False, False), (args.full_image, True, False)]
    for image, native, minimal in candidates:
        actual = exercise(image, args.redis_image, native=native, minimal=minimal)
        require(
            actual == baseline, f"Worker scheduling or API response changed: {image}"
        )
        profiles.append({"image": image, "native": native, "cases": len(actual)})
    images = {args.baseline, args.redis_image, args.image, args.full_image} - {None}
    args.report.write_text(
        json.dumps(
            {
                "status": "passed",
                "profiles": profiles,
                "oracle_sha256": hashlib.sha256(oracle.read_bytes()).hexdigest(),
                "image_ids": {
                    image: run(
                        "docker",
                        "image",
                        "inspect",
                        image,
                        "--format",
                        "{{.Id}}",
                        capture_output=True,
                        text=True,
                    ).stdout.strip()
                    for image in sorted(images)
                },
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "runtime/src/nv_ingest.rs",
                        ROOT / "runtime/src/document_processor.rs",
                    ]
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--image")
    parser.add_argument("--full-image")
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
