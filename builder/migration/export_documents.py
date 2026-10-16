"""Freeze document extraction helpers, validation, and the pinned NV-Ingest jobs."""

import argparse
import asyncio
import base64
import html
import html.entities
import json
from pathlib import Path

from export_authorization import BASELINE, fixture_strings


def entry(text, page=0, kind="text", **metadata):
    return {
        "document_type": kind,
        "metadata": {
            "content": text,
            "content_metadata": {"page_number": page},
            **metadata,
        },
    }


def texts():
    return [
        "",
        "  Synthetic 雪🌲. \u001c",
        "<span color='red'>A&amp;B<br/> C</span>",
        "&notit; &NotEqualTilde; &#128; &#xD800; &#0; &#x110000; &#x1f;",
        "A\u00a0B\u200bC\u200cD\u200dE\ufeffF\u2028G\u2029H",
        "‘one’ “two” – — …",
        "de-\nhyphen\t   words   \n\n\n\nend",
        "A-\n\u0301 C-\n_ D-\n\u001c",
        "| one | two |\n|---|---|\n| short |\n| a | b | c |\n| |",
        "| |\n||",
        "<DIV>not stripped</DIV><br ><p>case</p>",
        " " * 4,
        "x" * 129,
        "😀" * 140,
        "雪 🌲" * 24,
    ]


async def export(root):
    import document_ingest_api as api
    import httpx
    import nat_nv_ingest.nat_nv_ingest as document
    from fastapi import FastAPI
    from nv_ingest_client.client import NvIngestClient

    cases = []

    def freeze(kind, value, function):
        try:
            expected = {"ok": function(value)}
        except Exception as exc:
            expected = {"error": type(exc).__name__}
        cases.append({"kind": kind, "input": value, "expected": expected})

    for value in texts() + [f"&{name}" for name in html.entities.html5]:
        freeze("clean", value, document.clean_markdown)
        freeze("table", value, document.clean_table_markdown)
    for value in texts():
        for limit in [None, 1, 10, 54, 55, 56, 57, 100, len(value), len(value) + 1]:
            freeze("limit", [value, limit], lambda v: document._apply_char_limit(*v))
    for value in [
        None,
        "",
        "../../report.pdf",
        "..",
        ".hidden",
        "---.pdf",
        'A\nB".txt',
        "C:\\dir\\report.TXT",
        "A" * 200 + ".pdf",
        "雪🌲.pdf",
    ]:
        freeze("filename", value, api._markdown_filename)
    samples = [
        [],
        [[]],
        [[entry("one", 0), entry("two", 1)]],
        [[entry("ignored", 9, "unknown")]],
        [[entry("text", True)]],
        [[entry("a", None), entry("b", 1), entry("c", 0)]],
        [[entry("one two three", 0), entry("one two three@@@@", 0), entry("other", 0)]],
        [
            [
                entry("one two three@@@", 0),
                entry("one two three", 0),
                entry("one two three%%%%", 0),
            ]
        ],
        [[entry("one two", 0), entry("two three", 0)]],
        [[entry("same", 0), entry("same", 1)]],
        [
            [
                entry(
                    "", 0, "structured", table_metadata={"table_content": texts()[8]}
                ),
                entry("", 0, "image", image_metadata={"caption": " Caption 雪 "}),
                entry(
                    "",
                    1,
                    "audio",
                    audio_metadata={"audio_transcript": " Transcript 🌲 "},
                ),
            ]
        ],
        [
            [
                entry("later", 0),
                entry(
                    "first",
                    0,
                    content_metadata={"page_number": 0, "hierarchy": {"y0": -5}},
                ),
            ]
        ],
        [[entry("雪", 0), entry("雪", 0)]],
        [[entry("one", "1"), entry("two", 2)]],
        [[entry("one", 0)], [entry("ignored second result", 1)]],
    ]
    for sample in samples:
        freeze("markdown", sample, document.results_to_markdown)
    for value in [
        None,
        [],
        {},
        {"userId": "alice"},
        {"userId": " alice "},
        {"userId": None},
        {"userId": 1},
        {"userId": "bob"},
    ]:
        for user in ["alice", "anonymous", "ALICE"]:
            freeze(
                "owner",
                [value, user],
                lambda v: document._can_access_stored_document(*v),
            )

    application = FastAPI()

    @application.post("/extract")
    async def validate_extract(body: api.ExtractRequest):
        return body.model_dump(exclude_none=True)

    @application.post("/markdown")
    async def validate_markdown(body: api.MarkdownRequest):
        return body.model_dump(exclude_none=True)

    ref = {"documentId": "document-1", "sessionId": "session-1"}
    inputs = [
        None,
        [],
        {},
        {"documentRef": None},
        {"documentRef": []},
        {"documentRef": {}},
        {"documentRef": ref},
        {"documentRef": ref, "username": "alice", "ignored": True},
    ]
    for name in ["documentId", "sessionId", "filename", "mimeType", "userId"]:
        for value in [None, 1, "", "  ", "雪"]:
            inputs.append({"documentRef": {**ref, name: value}})
    for value in [
        None,
        0,
        -1,
        500001,
        1,
        500000,
        True,
        False,
        "1.0",
        "3",
        1.5,
        1e30,
        -1e30,
        float(2**63 - 1024),
        float(2**63),
        "bad",
        [],
        10**30,
    ]:
        inputs.append({"documentRef": ref, "char_limit": value})
    inputs += [
        {"documentRef": ref, "username": value}
        for value in [None, "", 1, [], " alice "]
    ]
    validation = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://fixture"
    ) as client:
        for route in ["extract", "markdown"]:
            for value in inputs:
                response = await client.post(
                    "/" + route,
                    content=json.dumps(value),
                    headers={"Content-Type": "application/json"},
                )
                validation.append(
                    {
                        "route": route,
                        "input": value,
                        "status": response.status_code,
                        "expected": response.json(),
                    }
                )

    jobs = []
    client = NvIngestClient(message_client_hostname="127.0.0.1", message_client_port=1)
    for extension in [
        "txt",
        "md",
        "html",
        "json",
        "sh",
        "pdf",
        "docx",
        "pptx",
        "jpg",
        "jpeg",
        "png",
        "bmp",
        "tiff",
        "svg",
        "wav",
        "mp3",
        "mp4",
        "mov",
        "avi",
        "mkv",
        "bin",
        "",
        "PDF",
    ]:
        for v2, filtered in [(False, True), (True, False)]:
            config = document.NvIngestFunctionConfig(
                use_v2_api=v2,
                enable_image_filter=filtered,
                pdf_pages_per_chunk=129,
                extract_method="pdfium",
            )
            raw = "Synthetic document 雪🌲".encode()
            filename = "fixture." + extension if extension else "fixture"
            try:
                ingestor = document._build_ingestor(
                    nv_client=client,
                    document_bytes=raw,
                    filename=filename,
                    config=config,
                    collection_name="",
                    chunk_size=1024,
                    chunk_overlap=150,
                    extract_only=True,
                )
                expected = {"ok": ingestor._job_specs.to_dict()}
            except Exception as exc:
                expected = {"error": type(exc).__name__, "message": str(exc)}
            jobs.append(
                {
                    "filename": filename,
                    "data": base64.b64encode(raw).decode(),
                    "v2": v2,
                    "filter": filtered,
                    "expected": expected,
                }
            )
    encodings = []
    for text in [
        "Synthetic ASCII document.",
        "Préférences françaises : café, été, forêt.",
        "Русский текст для проверки кодировки документа.",
        "日本語の文書を変換します。",
        "中文文档转换测试。",
        "Synthetic 雪🌲 content.",
    ]:
        for encoding in [
            "utf-8",
            "utf-8-sig",
            "utf-16",
            "utf-16-be",
            "utf-32",
            "cp1252",
            "cp1251",
            "shift_jis",
            "gb18030",
            "big5",
            "latin1",
        ]:
            try:
                raw = text.encode(encoding)
            except UnicodeEncodeError:
                continue
            from io import BytesIO

            from nv_ingest_client.util.file_processing.extract import (
                detect_encoding_and_read_text_file,
            )

            try:
                expected = {"ok": detect_encoding_and_read_text_file(BytesIO(raw))}
            except Exception as exc:
                expected = {"error": type(exc).__name__}
            encodings.append(
                {
                    "encoding": encoding,
                    "data": base64.b64encode(raw).decode(),
                    "expected": expected,
                }
            )

    ranges = []
    for n in range(0x110000):
        if chr(n).isalnum():
            if ranges and ranges[-1][1] == n - 1:
                ranges[-1][1] = n
            else:
                ranges.append([n, n])
    resources = {
        "html_entities": html.entities.html5,
        "invalid_charrefs": {str(k): v for k, v in html._invalid_charrefs.items()},
        "alnum_ranges": ranges,
        "decimal_zeros": [
            n for n in range(0x110000) if chr(n).isdecimal() and int(chr(n)) == 0
        ],
    }
    (root / "resources/document-text.json").write_text(
        json.dumps(resources, ensure_ascii=False, indent=2) + "\n"
    )
    fixture = {
        "baseline_sha": BASELINE,
        "cases": cases,
        "validation": validation,
        "jobs": jobs,
        "encodings": encodings,
    }
    (root / "tests/fixtures/documents.json").write_text(
        # Normalize helper tuples before recursively chunking long strings.
        json.dumps(
            fixture_strings(json.loads(json.dumps(fixture))),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(
        {key: len(fixture[key]) for key in ["cases", "validation", "jobs", "encodings"]}
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
