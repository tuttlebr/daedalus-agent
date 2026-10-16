"""Freeze UTF-7 code points, including CPython's accepted isolated surrogates."""

import argparse
import base64
import encodings.aliases
import hashlib
import json
import random
from pathlib import Path

from export_authorization import BASELINE
from export_document_encodings import fixture_strings


def decoded(raw, ignore):
    try:
        return {
            "ok": [
                ord(c) for c in raw.decode("utf_7", "ignore" if ignore else "strict")
            ]
        }
    except UnicodeDecodeError:
        return {"error": "UnicodeDecodeError"}


def digest_result(digest, result):
    if "ok" not in result:
        digest.update(b"\x00")
        return
    values = result["ok"]
    digest.update(b"\x01" + len(values).to_bytes(4, "little"))
    for value in values:
        digest.update(value.to_bytes(4, "little"))


def export(root):
    pairs = []
    for prefix, suffix in [(b"", b""), (b"+", b"-"), (b"+", b" "), (b"+", b"\xff")]:
        for ignore in [False, True]:
            digest = hashlib.sha256()
            for n in range(65536):
                digest_result(
                    digest, decoded(prefix + n.to_bytes(2, "big") + suffix, ignore)
                )
            pairs.append(
                {
                    "prefix": base64.b64encode(prefix).decode(),
                    "suffix": base64.b64encode(suffix).decode(),
                    "ignore": ignore,
                    "sha256": digest.hexdigest(),
                }
            )
    bmp = []
    for ignore in [False, True]:
        digest = hashlib.sha256()
        for n in range(65536):
            raw = b"+" + base64.b64encode(n.to_bytes(2, "big")).rstrip(b"=") + b"-"
            digest_result(digest, decoded(raw, ignore))
        bmp.append({"ignore": ignore, "sha256": digest.hexdigest()})
    samples = [b"", bytes(range(256)), bytes(range(255, -1, -1))]
    for text in [
        "Synthetic ASCII\n\t",
        "Préférences françaises : café, été, forêt.",
        "Русский текст",
        "日本語の文書",
        "中文文档",
        "Synthetic 雪🌲 e\u0301\x00\uffff\U0010ffff",
        "\ufeffembedded\ufeff",
        "\ud800A\udfff\ud800\udc00",
    ]:
        raw = text.encode("utf_7")
        for end in range(len(raw) + 1):
            samples.extend([raw[:end], raw[:end] + b"\xff"])
    for raw in [
        b"+",
        b"+-",
        b"+!",
        b"+A",
        b"+AA",
        b"+AAA",
        b"+AAB",
        b"+AAAA",
        b"+AAAAA",
        b"+2AA",
        b"+3AA",
        b"+2ADcAA",
        b"+AAAA2AA",
        b"+2AAAAA",
        b"+\xff",
    ]:
        for suffix in [b"", b"-", b"!", b" ", b"\xff", b"+AAA-", b"+2ADcAA-"]:
            samples.extend([raw + suffix, b"before" + raw + suffix + b"after"])
    rng = random.Random(1701)  # nosec B311 - reproducible codec vectors
    for length in [3, 4, 7, 8, 16, 32, 64, 255]:
        for _ in range(16):
            samples.append(bytes(rng.randrange(256) for _ in range(length)))
            alphabet = (
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            )
            samples.append(
                b"+" + bytes(rng.choice(alphabet) for _ in range(length)) + b"-"
            )
    cases = [
        {
            "data": base64.b64encode(raw).decode(),
            "ignore": ignore,
            "expected": decoded(raw, ignore),
        }
        for raw in samples
        for ignore in [False, True]
    ]
    fixture = {"baseline_sha": BASELINE, "pairs": pairs, "bmp": bmp, "cases": cases}
    (root / "tests/fixtures/document-codecs-utf7.json").write_text(
        json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
    )
    resource = {
        "aliases": {
            **{
                alias: target
                for alias, target in encodings.aliases.aliases.items()
                if target == "utf_7"
            },
            "utf_7": "utf_7",
        }
    }
    (root / "resources/document-codecs-utf7.json").write_text(
        json.dumps(resource, indent=2) + "\n"
    )
    print({"vectors": len(cases), "pairs": len(pairs) * 65536, "bmp": len(bmp) * 65536})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
