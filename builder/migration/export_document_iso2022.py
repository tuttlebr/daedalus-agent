"""Freeze CPython ISO-2022 mappings and stateful decoding from the baseline."""

import argparse
import base64
import encodings.aliases
import hashlib
import json
import random
import struct
import sys
import zlib
from pathlib import Path

from export_authorization import BASELINE
from export_document_encodings import fixture_strings
from export_document_multibyte import digest_result

NAMES = [
    "iso2022_jp",
    "iso2022_jp_1",
    "iso2022_jp_2",
    "iso2022_jp_2004",
    "iso2022_jp_3",
    "iso2022_jp_ext",
    "iso2022_kr",
]


def decoded(name, raw, ignore):
    try:
        return {"ok": raw.decode(name, errors="ignore" if ignore else "strict")}
    except (UnicodeDecodeError, RuntimeError) as exc:
        return {"error": type(exc).__name__}


def packed(result):
    if "error" in result:
        return struct.pack("<II", 0xFFFFFFFF, 0xFFFFFFFF)
    value = result["ok"]
    if not 1 <= len(value) <= 2:
        raise ValueError("ISO-2022 mapping did not return one or two characters")
    return struct.pack(
        "<II", ord(value[0]), ord(value[1]) if len(value) == 2 else 0xFFFFFFFF
    )


def export(root):
    mappings = {}
    mapping_ids = {}
    codecs = {}
    total_vectors = 0
    total_pairs = 0

    def store_map(name, mark, raw, width):
        digest = hashlib.sha256(raw).hexdigest()
        if digest not in mapping_ids:
            key = f"{name}_{mark:02x}"
            mapping_ids[digest] = key
            encoded = base64.b64encode(zlib.compress(raw, level=9)).decode()
            mappings[key] = {
                "width": width,
                "sha256": digest,
                "data": [encoded[i : i + 64] for i in range(0, len(encoded), 64)],
            }
        return mapping_ids[digest]

    for name in NAMES:
        designations = {}
        prefixes = [b""]
        for mark in range(64, 256):
            if mark == 66:
                continue  # ASCII is handled directly.
            prefix = (
                b"\x1b$(" + bytes([mark & 127])
                if mark & 128
                else b"\x1b(" + bytes([mark])
            )
            if decoded(name, prefix, False) != {"ok": ""}:
                continue
            width = 2 if mark & 128 else 1
            raw = bytearray()
            for first in range(32, 128):
                for second in range(256) if width == 2 else [None]:
                    suffix = (
                        bytes([first]) if second is None else bytes([first, second])
                    )
                    raw.extend(packed(decoded(name, prefix + suffix, False)))
            designations[str(mark)] = store_map(name, mark, raw, width)
            prefixes.append(prefix)
            if name == "iso2022_kr":
                prefixes.append(prefix[:2] + b")" + prefix[3:] + b"\x0e")
        codecs[name] = {"designations": designations}
        if name == "iso2022_jp_2":
            g2 = {}
            for mark in [65, 66, 70]:
                prefix = b"\x1b." + bytes([mark]) + b"\x1bN"
                g2[str(mark)] = [
                    decoded(name, prefix + bytes([byte]), False).get("ok")
                    for byte in range(256)
                ]
                prefixes.append(prefix[:3])
            codecs[name]["g2"] = g2

        pairs = []
        for prefix in prefixes:
            for ignore in [False, True]:
                digest = hashlib.sha256()
                for n in range(65536):
                    digest_result(
                        digest, decoded(name, prefix + n.to_bytes(2, "big"), ignore)
                    )
                pairs.append(
                    {
                        "prefix": base64.b64encode(prefix).decode(),
                        "ignore": ignore,
                        "sha256": digest.hexdigest(),
                    }
                )
        total_pairs += len(pairs) * 65536

        samples = [b"", bytes(range(256)), bytes(range(255, -1, -1))]
        for text in [
            "Synthetic ASCII\n\t",
            "日本語の文書、テスト。",
            "中文文档與繁體字",
            "한국어 문서",
            "Café £¥¢‾\\",
            "か゚か゚カ゚カ゚",
        ]:
            raw = text.encode(name, errors="ignore")
            samples.extend([raw, raw[:-1], raw + b"\xff", raw[:2] + b"\xff" + raw[2:]])
        escapes = [
            b"\x1b(B",
            b"\x1b(J",
            b"\x1b(I",
            b"\x1b$B",
            b"\x1b$@",
            b"\x1b$(D",
            b"\x1b$(O",
            b"\x1b$(P",
            b"\x1b$(Q",
            b"\x1b$)C",
            b"\x1b.A",
            b"\x1b.F",
            b"\x1b.J",
            b"\x1bN",
            b"\x1b&@\x1b$B",
            b"\x1b[123m",
            b"\x1b\xff\xff@",
            b"\x1b$",
            b"\x1b",
            b"\x1b$" + b"x" * 14,
            b"\x1b$" + b"x" * 13 + b"B",
            b"\x1b$" + b"x" * 12 + b"&@",
            b"\x1b&@",
            b"\x1b&@\x1b$B\x1b",
            b"\x1b&@&@&@&@&@&@A",
        ]
        for prefix in prefixes:
            for escape in escapes:
                for suffix in [b"", b"!!\x1b(Btail", b"\x0e!!\x0fA\nB", b"\x1bN\xffz"]:
                    samples.append(prefix + b"!!" + escape + suffix)
        rng = random.Random(941)  # nosec B311 - reproducible stateful decoding vectors
        for _ in range(256):
            samples.append(
                b"".join(
                    rng.choice(
                        escapes + [b"\x0e", b"\x0f", b"!!", b"\xff", b"A", b"\n"]
                    )
                    for _ in range(8)
                )
            )
        cases = [
            {
                "encoding": name,
                "data": base64.b64encode(raw).decode(),
                "ignore": ignore,
                "expected": decoded(name, raw, ignore),
            }
            for raw in samples
            for ignore in [False, True]
        ]
        total_vectors += len(cases)
        fixture = {
            "baseline_sha": BASELINE,
            "encoding": name,
            "prefix_pairs": pairs,
            "cases": cases,
        }
        (root / f"tests/fixtures/document-codecs-{name}.json").write_text(
            json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
        )
        print(
            {
                "codec": name,
                "designations": len(designations),
                "vectors": len(cases),
                "pairs": len(pairs) * 65536,
            },
            flush=True,
        )

    resource = {
        "baseline_sha": BASELINE,
        "python": sys.version.split()[0],
        "aliases": {
            **{
                alias: target
                for alias, target in encodings.aliases.aliases.items()
                if target in NAMES
            },
            **{name: name for name in NAMES},
        },
        "codecs": codecs,
        "mappings": mappings,
    }
    (root / "resources/document-codecs-iso2022.json").write_text(
        json.dumps(resource, ensure_ascii=False, indent=2) + "\n"
    )
    print(
        {
            "codecs": len(codecs),
            "mappings": len(mappings),
            "vectors": total_vectors,
            "pairs": total_pairs,
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
