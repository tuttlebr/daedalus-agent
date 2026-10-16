"""Freeze real NV-Ingest REST execution, failure counts, and upload decisions."""

import argparse
import copy
import json
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from export_authorization import BASELINE, fixture_strings


def expand(value):
    if isinstance(value, dict):
        if set(value) == {"$string_parts"}:
            return "".join(value["$string_parts"])
        return {key: expand(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item) for item in value]
    return value


def timed_out(*_args):
    raise TimeoutError("SDK export timed out")


def export(root):
    import nat_nv_ingest.nat_nv_ingest as document
    from nv_ingest_client.client import NvIngestClient

    oracle = expand(json.loads((root / "tests/fixtures/nv-ingest.json").read_text()))
    cases = [
        {"name": f"envelope-{index}", "envelope": case["input"]}
        for index, case in enumerate(oracle["results"])
    ]
    success = {"status": "success", "data": []}
    cases.extend(
        {"name": f"{method}-{status}", "fault": [method, status], "envelope": success}
        for method, status in [
            ("POST", 400),
            ("POST", 503),
            ("GET", 500),
            ("GET", 429),
            ("GET", 202),
        ]
    )
    cases.append({"name": "malformed-json", "raw": "not-json"})
    state = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            self.reply()

        def do_GET(self):
            self.reply()

        def reply(self):
            if self.command == "POST":
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
            state["calls"].append([self.command, self.path])
            fault = state.get("fault")
            status = 200
            if fault and fault[0] == self.command:
                status = fault[1]
                state["fault"] = None
            body = (
                json.dumps("synthetic-job")
                if self.command == "POST"
                else state["case"].get("raw", json.dumps(state["case"].get("envelope")))
            ).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    output = []
    try:
        for case in cases:
            state.clear()
            state.update(case=case, calls=[], fault=case.get("fault"))
            writes = []
            client = NvIngestClient(
                message_client_hostname="127.0.0.1",
                message_client_port=server.server_port,
                worker_pool_size=2,
            )
            try:
                ingestor = document._build_ingestor(
                    nv_client=client,
                    document_bytes=b"Synthetic",
                    filename="fixture.txt",
                    config=document.NvIngestFunctionConfig(),
                    collection_name="synthetic",
                    chunk_size=1024,
                    chunk_overlap=150,
                    extract_only=True,
                )
                # Preserve the real concurrent processor and Ingestor's decision
                # whether to call the local writer; only the write body is fake.
                ingestor._vdb_bulk_upload = SimpleNamespace(
                    run=lambda results: writes.append(copy.deepcopy(results))
                )
                with ingestor as ctx:
                    results, failures = ctx.ingest(
                        show_progress=False, return_failures=True
                    )
                output.append(
                    {
                        **case,
                        "results": results,
                        "failures": len(failures[0]) if failures and failures[0] else 0,
                        "upload": bool(writes),
                        "calls": state["calls"],
                    }
                )
            finally:
                client._worker_pool.shutdown(wait=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    (root / "tests/fixtures/nv-ingest-failures.json").write_text(
        json.dumps(
            fixture_strings({"baseline_sha": BASELINE, "cases": output}),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(f"Frozen {len(output)} real SDK REST ingestion and upload decisions")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    # A changed SDK must fail this exporter instead of hanging on polling.
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(90)
    export(parser.parse_args().root)
