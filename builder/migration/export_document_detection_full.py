"""Freeze complete pinned encoding selection and NV-Ingest text decoding."""

import argparse
import base64
import hashlib
import json
import random
from io import BytesIO
from pathlib import Path

from export_authorization import BASELINE
from export_document_encodings import fixture_strings


def export(root):
    import charset_normalizer
    from charset_normalizer.api import IANA_SUPPORTED_MB_FIRST
    from charset_normalizer.utils import any_specified_encoding
    from nv_ingest_client.util.file_processing.extract import (
        detect_encoding_and_read_text_file,
    )

    samples = []
    seen = set()

    def add(label, raw, repeat=1):
        digest = hashlib.sha256(raw).digest(), repeat
        if digest not in seen:
            seen.add(digest)
            samples.append((label, raw, repeat))

    texts = [
        "Synthetic document with words and numbers 123.\n",
        "Préférences françaises : café, été, forêt et résultats du document.\n",
        "Русский текст для проверки кодировки документа.\n",
        "日本語の文書を変換します。 テキストを確認します。\n",
        "中文文档转换测试。今天我们一起学习中文。\n",
        "한국어 문서 테스트입니다.\n",
        "مرحبا بالعالم هذا نص عربي لاختبار المستند\n",
        "Αυτή είναι μια δοκιμή ελληνικού κειμένου.\n",
        "Synthetic 雪🌲 e\u0301\x00\uffff\U0010ffff\n",
    ]
    for name in IANA_SUPPORTED_MB_FIRST:
        for i, text in enumerate(texts):
            try:
                raw = text.encode(name)
            except UnicodeEncodeError:
                continue
            add(f"{name}:{i}:short", raw)
            add(f"{name}:{i}:sampled", raw, 80)
    for raw in [
        b"",
        b"\x00",
        b"\xff",
        b"\xff\xfe",
        b"\xfe\xff",
        b"\xef\xbb\xbf",
        b"\x00\x00\xfe\xff",
        b"\xff\xfe\x00\x00",
        bytes(range(256)),
    ]:
        add("boundary", raw)
    for text in [
        "\ufeffSynthetic text\n",
        "\ufeffSynthetic document " * 20 + "\ud800A\udfff",
        "\ufeff\ud800",
    ]:
        for name in ["utf_7", "utf_8", "utf_16", "utf_32"]:
            add(f"unicode-edge:{name}", text.encode(name, errors="surrogatepass"))
    rng = random.Random(8303)  # nosec B311 - reproducible binary text probes
    for length in [1, 2, 3, 7, 8, 15, 16, 31, 32, 511, 512, 1024, 2559, 2560, 2561]:
        for _ in range(4):
            add(f"binary:{length}", bytes(rng.randrange(256) for _ in range(length)))
    declarations = []
    for name in [
        "utf-8",
        "utf_8_sig",
        "latin1",
        "CP1252",
        "utf-16",
        "utf-7",
        "rot13",
        "base64",
        "unknown",
        "MacCyrillic",
    ]:
        for header in [
            f"# coding: {name}\n",
            f'<meta charset="{name}">',
            f"encoding='{name}'",
            f"CHARSET = {name}",
        ]:
            raw = header.encode() + b" Synthetic text \x80\xe9.\n"
            declarations.append(
                {
                    "data": base64.b64encode(raw).decode(),
                    "expected": any_specified_encoding(raw),
                }
            )
            add(f"declaration:{name}", raw)
    for offset in [8190, 8191, 8192, 8193]:
        raw = b"x" * offset + b" charset=cp1252 \x80\xe9"
        declarations.append(
            {
                "data": base64.b64encode(raw).decode(),
                "expected": any_specified_encoding(raw),
            }
        )
        add(f"declaration-offset:{offset}", raw)
    add("large-ascii", b"Synthetic document. ", 500001)
    add("large-declared-latin", b"# coding: cp1252\nCaf\xe9. ", 454546)

    cases = []
    for i, (label, raw, repeat) in enumerate(samples):
        data = raw * repeat
        try:
            encoding = charset_normalizer.detect(data)["encoding"]
            expected = {"encoding": encoding}
            try:
                text = detect_encoding_and_read_text_file(BytesIO(data))
                expected["text"] = {
                    "characters": len(text),
                    "sha256_utf32le": hashlib.sha256(
                        text.encode("utf-32-le", errors="surrogatepass")
                    ).hexdigest(),
                }
            except Exception as exc:
                expected["error"] = type(exc).__name__
        except Exception as exc:
            expected = {"error": type(exc).__name__}
        cases.append(
            {
                "label": label,
                "data": base64.b64encode(raw).decode(),
                "repeat": repeat,
                "expected": expected,
            }
        )
        if i % 100 == 0:
            print({"completed": i + 1, "total": len(samples)}, flush=True)
    for index in range(3):
        fixture = {
            "baseline_sha": BASELINE,
            "charset_normalizer": charset_normalizer.__version__,
            "cases": cases[index::3],
            "declarations": declarations[index::3],
        }
        (root / f"tests/fixtures/document-detection-full-{index}.json").write_text(
            json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
        )
    print({"cases": len(cases), "declarations": len(declarations)}, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
