"""Freeze pinned NV-Ingest URL, job-option and result-envelope behavior."""

import argparse
import copy
import json
from pathlib import Path

from export_authorization import BASELINE, fixture_strings


def export(root):
    import nat_nv_ingest.nat_nv_ingest as document
    from nv_ingest_api.util.service_clients.rest.rest_client import (
        _TERMINAL_RESPONSE_STATUSES,
        RestClient,
    )
    from nv_ingest_client.client import NvIngestClient
    from nv_ingest_client.util.util import check_ingest_result

    urls = []
    for host in [
        "localhost",
        " localhost ",
        "127.0.0.1",
        "localhost:9000",
        "",
        "http://HOST",
        "HTTPS://HOST:8443/base/",
        "http://user:pass@host/base?x=1#f",
        "http://",
        "http://host:bad",
        "http://host:80/",
        "https://[::1]/",
    ]:
        try:
            expected = {"ok": RestClient._generate_url(host, 7670)}
        except Exception as exc:
            expected = {"error": type(exc).__name__}
        urls.append({"host": host, "port": 7670, "expected": expected})

    results = []
    sample = [
        {
            "document_type": "text",
            "metadata": {
                "content": "Synthetic 雪🌲",
                "content_metadata": {"page_number": 0},
            },
        }
    ]
    envelopes = [None, [], {}, {"data": sample}]
    for status in [
        "",
        "f",
        "fail",
        "failed",
        "failure",
        "FAILED",
        "success",
        "pending",
        None,
        False,
        1,
        [],
        {},
    ]:
        for description in ["", "Synthetic description", None, 1]:
            envelopes.append(
                {"status": status, "description": description, "data": sample}
            )
    for data in [None, [], {}, "text", 1]:
        envelopes.append({"status": "success", "data": data})
    for name, values in {
        "document_type": [None, [], {}, 1],
        "metadata": [None, [], {}, 1],
        "page": [None, [], {}, 1, True, "one", 10**30, 10**30 + 1],
        "content": [None, [], {}, 1, ""],
    }.items():
        for value in values:
            entry = copy.deepcopy(sample[0])
            if name == "page":
                entry["metadata"]["content_metadata"]["page_number"] = value
            elif name == "content":
                entry["metadata"]["content"] = value
            else:
                entry[name] = value
            for data in [[entry], [entry, sample[0]]]:
                envelopes.append({"status": "success", "data": data})
    for envelope in envelopes:
        try:
            failed, _ = check_ingest_result(envelope)
            # The concurrent processor omits failed jobs and returns .get("data")
            # for accepted jobs. Exceptions also become failed jobs.
            expected = [] if failed else [envelope.get("data")]
        except Exception:
            expected = []
        try:
            markdown = {"ok": list(document.results_to_markdown(expected))}
        except Exception as exc:
            markdown = {"error": type(exc).__name__}
        results.append({"input": envelope, "expected": expected, "markdown": markdown})

    jobs = []
    client = NvIngestClient(message_client_hostname="127.0.0.1", message_client_port=1)
    for filename in [
        "fixture.pdf",
        "fixture.docx",
        "fixture.txt",
        "fixture.sh",
        "fixture.wav",
        ".txt",
        "dir.with.dot/file",
        "dir/name.PDF",
    ]:
        for method in [
            "pdfium",
            "doughnut",
            "tesseract",
            "render_as_pdf",
            "invalid",
            "adobe",
            "nemotron_parse",
            "nemoretriever_parse",
            "haystack",
            "llama_parse",
            "tika",
            "unstructured_io",
            "unstructured_local",
            "pdfium_hybrid",
            "ocr",
            "audio",
        ]:
            for pages in [-1, 1, 32, 500]:
                try:
                    config = document.NvIngestFunctionConfig(
                        use_v2_api=True,
                        pdf_pages_per_chunk=pages,
                        extract_method=method,
                    )
                    ingestor = document._build_ingestor(
                        nv_client=client,
                        document_bytes=b"Synthetic",
                        filename=filename,
                        config=config,
                        collection_name="",
                        chunk_size=1024,
                        chunk_overlap=150,
                        extract_only=True,
                    )
                    expected = {"ok": ingestor._job_specs.to_dict()}
                except Exception as exc:
                    expected = {"error": type(exc).__name__}
                jobs.append(
                    {
                        "filename": filename,
                        "method": method,
                        "pages": pages,
                        "expected": expected,
                    }
                )

    fixture = {
        "baseline_sha": BASELINE,
        "client_version": "26.3.0",
        "terminal_statuses": _TERMINAL_RESPONSE_STATUSES,
        "urls": urls,
        "results": results,
        "jobs": jobs,
    }
    (root / "tests/fixtures/nv-ingest.json").write_text(
        json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
    )
    print({key: len(fixture[key]) for key in ["urls", "results", "jobs"]})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
