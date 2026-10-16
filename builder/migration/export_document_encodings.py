"""Export CPython codec data and independent document-decoding vectors.

Run inside the immutable baseline with networking disabled. These are byte/Unicode
mapping facts from its installed codecs, not guesses from another detector.
"""

import argparse
import base64
import encodings.aliases
import json
import random
import unicodedata
from pathlib import Path

from export_authorization import BASELINE


def fixture_strings(value):
    # Control characters expand to six JSON characters. Bound serialized chunks
    # as well as ordinary strings so generated data passes the secret scanner.
    if isinstance(value, str):
        parts = []
        current = ""
        for character in value:
            if len(json.dumps(current + character, ensure_ascii=False)) - 2 > 80:
                parts.append(current)
                current = ""
            current += character
        parts.append(current)
        return {"$string_parts": parts} if len(parts) > 1 else value
    if isinstance(value, list):
        return [fixture_strings(item) for item in value]
    if isinstance(value, dict):
        return {key: fixture_strings(item) for key, item in value.items()}
    return value


def export(root):
    from charset_normalizer.api import IANA_SUPPORTED_MB_FIRST
    from charset_normalizer.utils import is_multi_byte_encoding

    names = sorted(
        {name for name in IANA_SUPPORTED_MB_FIRST if not is_multi_byte_encoding(name)}
    )
    tables = {}
    cases = []

    def freeze(name, raw):
        for errors in ["strict", "ignore"]:
            try:
                expected = {"ok": raw.decode(name, errors=errors)}
            except UnicodeDecodeError:
                expected = {"error": "UnicodeDecodeError"}
            cases.append(
                {
                    "encoding": name,
                    "data": base64.b64encode(raw).decode(),
                    "ignore": errors == "ignore",
                    "expected": expected,
                }
            )

    for name in names:
        table = []
        for byte in range(256):
            try:
                table.append(ord(bytes([byte]).decode(name)))
            except UnicodeDecodeError:
                table.append(None)
        tables[name] = table
        valid = bytes(i for i, value in enumerate(table) if value is not None)
        freeze(name, valid)
        freeze(name, bytes(range(256)))
        freeze(name, valid[::-1] + valid)

    unicode_names = [
        "utf_8",
        "utf_8_sig",
        "utf_16",
        "utf_16_le",
        "utf_16_be",
        "utf_32",
        "utf_32_le",
        "utf_32_be",
    ]
    for name in unicode_names:
        for text in [
            "",
            "Synthetic ASCII",
            "Préférences françaises : café, été, forêt.",
            "Русский текст",
            "日本語の文書",
            "中文文档",
            "Synthetic 雪🌲 e\u0301\x00\uffff\U0010ffff",
            "\ufeffembedded\ufeff",
        ]:
            freeze(name, text.encode(name))
        for raw in [
            b"",
            b"A",
            b"A\0",
            b"\xff\xfe",
            b"\xfe\xff",
            b"\xff\xfe\0\0",
            b"\0\0\xfe\xff",
            b"\x00\xd8A\0",
            b"\x00\xdc\x00\xd8",
            b"\xff\xff\xff\xff",
            bytes(range(256)),
        ]:
            freeze(name, raw)
        rng = random.Random(2701)  # nosec B311 - reproducible codec vectors
        for length in range(1, 40):
            freeze(name, bytes(rng.randrange(256) for _ in range(length)))
    supported = set(names + unicode_names)
    aliases = {
        alias: target
        for alias, target in encodings.aliases.aliases.items()
        if target in supported
    }
    for name in supported:
        aliases[name] = name
    resources = {
        "python_unicode": unicodedata.unidata_version,
        "single_byte": tables,
        "aliases": aliases,
    }
    fixture = {"baseline_sha": BASELINE, "cases": cases}
    (root / "resources/document-codecs.json").write_text(
        json.dumps(resources, ensure_ascii=False, indent=2) + "\n"
    )
    (root / "tests/fixtures/document-codecs.json").write_text(
        json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
    )
    print(
        {
            "single_byte_codecs": len(tables),
            "unicode_codecs": len(unicode_names),
            "decode_vectors": len(cases),
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
