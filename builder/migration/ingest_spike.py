"""Capture the pinned client's wire payload for one synthetic extract-only job.

Run inside the baseline image against an explicitly provided loopback service.
No embedding, vector upload, or production document is requested.
"""

import argparse
import io
import json
from pathlib import Path
from urllib.parse import urlsplit

import requests
from nv_ingest_client.client import Ingestor, NvIngestClient

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
captured = []


class RecordingSession(requests.Session):
    def post(self, url, **kwargs):
        captured.append(
            {"method": "POST", "path": urlsplit(url).path, "body": kwargs.get("json")}
        )
        return super().post(url, **kwargs)


client = NvIngestClient(
    message_client_hostname="127.0.0.1",
    message_client_port=args.port,
    message_client_kwargs={
        "api_version": "v2",
        "http_allocator": RecordingSession,
        "max_retries": 0,
        "default_connect_timeout": 10,
        "default_read_timeout": 60,
    },
)
result = (
    Ingestor(client=client)
    .buffers(
        [
            (
                "migration-fixture.txt",
                io.BytesIO(
                    b"Synthetic Daedalus migration evidence. No production document."
                ),
            )
        ]
    )
    .extract(
        extract_text=True,
        extract_tables=False,
        extract_charts=False,
        extract_images=False,
    )
    .ingest(show_progress=False, return_failures=True)
)
if "Synthetic Daedalus migration evidence" not in json.dumps(result, default=str):
    raise RuntimeError("Extract-only service result did not contain the synthetic text")
args.output.write_text(
    json.dumps(
        {
            "fixture_version": 1,
            "client_version": "26.3.0",
            "requests": captured,
            "result": result,
        },
        default=str,
        indent=2,
    )
    + "\n"
)
print("Pinned NV-Ingest client extract-only service probe passed.")
