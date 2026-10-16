"""Freeze finite CPython multibyte decoders from the immutable baseline.

The generated transition data covers both strict and ignore modes, including
incomplete input. Exhaustive byte-pair digests and longer independent vectors
use bytes.decode(), rather than the incremental decoder used for the tables.
"""

import argparse
import base64
import codecs
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

GROUPS = {
    "chinese": ["big5", "big5hkscs", "cp950", "gb2312", "gbk"],
    "japanese": ["cp932", "euc_jp", "shift_jis"],
    "japanese-extended": [
        "euc_jis_2004",
        "euc_jisx0213",
        "shift_jis_2004",
        "shift_jisx0213",
    ],
    "other": ["cp949", "hz", "johab"],
}


def decoder_table(name, errors="ignore"):
    factory = codecs.getincrementaldecoder(name)
    decoder = factory(errors=errors)
    strict = factory(errors="strict")
    states = [decoder.getstate()]
    state_ids = {states[0]: 0}
    strings = [""]
    string_ids = {"": 0}

    def string_id(value):
        if value not in string_ids:
            string_ids[value] = len(strings)
            strings.append(value)
        return string_ids[value]

    def step(state, raw, final):
        decoder.setstate(state)
        output = decoder.decode(raw, final=final)
        next_state = decoder.getstate()
        strict.setstate(state)
        try:
            if strict.decode(raw, final=final) != output:
                raise ValueError(f"{name} strict/{errors} decoding diverged")
            invalid = False
        except UnicodeDecodeError:
            invalid = True
        return output, next_state, invalid

    rows = bytearray()
    for state in states:
        output, _, invalid = step(state, b"", True)
        rows.extend(struct.pack("<HB", string_id(output), invalid))
        for byte in range(256):
            output, next_state, invalid = step(state, bytes([byte]), False)
            if next_state not in state_ids:
                state_ids[next_state] = len(states)
                states.append(next_state)
            rows.extend(
                struct.pack("<HHB", state_ids[next_state], string_id(output), invalid)
            )
        # Large/infinite-state codecs require a separate implementation. Never
        # silently truncate a table or ship an approximation for those codecs.
        if len(states) > 1024:
            raise ValueError(f"{name} requires a specialized decoder")
    payload = bytearray(b"DCD1" + struct.pack("<HH", len(states), len(strings)))
    payload.extend(rows)
    for value in strings:
        raw = value.encode("utf-8")
        payload.extend(struct.pack("<H", len(raw)))
        payload.extend(raw)
    encoded = base64.b64encode(zlib.compress(payload, level=9)).decode()
    return {
        "states": len(states),
        "strings": len(strings),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "data": [encoded[i : i + 64] for i in range(0, len(encoded), 64)],
    }


def decoded(name, raw, ignore):
    try:
        return {"ok": raw.decode(name, errors="ignore" if ignore else "strict")}
    except UnicodeDecodeError:
        return {"error": "UnicodeDecodeError"}


def pair_digest(name, ignore):
    digest = hashlib.sha256()
    for n in range(65536):
        digest_result(digest, decoded(name, n.to_bytes(2, "big"), ignore))
    return digest.hexdigest()


def digest_result(digest, result):
    if "ok" in result:
        raw = result["ok"].encode()
        digest.update(b"\x01" + len(raw).to_bytes(4, "little") + raw)
    else:
        digest.update(b"\x00")


def euc_kr(root):
    pairs = bytearray()
    for first in range(128, 256):
        for second in range(256):
            result = decoded("euc_kr", bytes([first, second]), False)
            value = ord(result["ok"]) if "ok" in result else 0xFFFFFFFF
            pairs.extend(struct.pack("<I", value))
    # Derive the eight-byte Hangul composition selectors from encoded syllables.
    # Ordinary KS X 1001 mappings alone would miss these legal EUC-KR sequences.
    selectors = [[None] * 19, [None] * 21, [None] * 28]
    syllables = "".join(chr(n) for n in range(0xAC00, 0xD7A4))
    for n, character in enumerate(syllables):
        raw = character.encode("euc_kr")
        if len(raw) == 8:
            for table, index, value in zip(
                selectors, [n // 588, (n // 28) % 21, n % 28], [raw[3], raw[5], raw[7]]
            ):
                if table[index] is not None and table[index] != value:
                    raise ValueError("Inconsistent EUC-KR composition selector")
                table[index] = value
    if any(value is None for table in selectors for value in table):
        raise ValueError("Incomplete EUC-KR composition selectors")
    encoded = base64.b64encode(zlib.compress(pairs, level=9)).decode()
    resource = {
        "baseline_sha": BASELINE,
        "python": sys.version.split()[0],
        "pairs": [encoded[i : i + 64] for i in range(0, len(encoded), 64)],
        "selectors": selectors,
        "aliases": {
            **{
                alias: target
                for alias, target in encodings.aliases.aliases.items()
                if target == "euc_kr"
            },
            "euc_kr": "euc_kr",
        },
    }
    (root / "resources/document-codecs-euc-kr.json").write_text(
        json.dumps(resource, indent=2) + "\n"
    )
    seed = bytes(
        [
            0xA4,
            0xD4,
            0xA4,
            selectors[0][0],
            0xA4,
            selectors[1][0],
            0xA4,
            selectors[2][0],
        ]
    )
    mutations = []
    for ignore in [False, True]:
        digest = hashlib.sha256()
        for position in range(8):
            for value in range(256):
                raw = seed[:position] + bytes([value]) + seed[position + 1 :]
                digest_result(digest, decoded("euc_kr", raw, ignore))
        mutations.append({"ignore": ignore, "sha256": digest.hexdigest()})
    samples = [syllables.encode("euc_kr"), bytes(range(256)), bytes(range(255, -1, -1))]
    for end in range(9):
        samples.extend(
            [
                seed[:end],
                b"abc" + seed[:end],
                seed[:end] + b"z",
                seed[:end] + b"\xff\xff",
            ]
        )
    rng = random.Random(917)  # nosec B311 - reproducible decoding vectors
    for length in [3, 4, 7, 8, 16, 32, 64, 255]:
        for _ in range(8):
            samples.append(bytes(rng.randrange(256) for _ in range(length)))
    fixture = {
        "baseline_sha": BASELINE,
        "pairs": [
            {
                "encoding": "euc_kr",
                "ignore": ignore,
                "sha256": pair_digest("euc_kr", ignore),
            }
            for ignore in [False, True]
        ],
        "mutation_seed": base64.b64encode(seed).decode(),
        "mutations": mutations,
        "cases": [
            {
                "encoding": "euc_kr",
                "data": base64.b64encode(raw).decode(),
                "ignore": ignore,
                "expected": decoded("euc_kr", raw, ignore),
            }
            for raw in samples
            for ignore in [False, True]
        ],
    }
    (root / "tests/fixtures/document-codecs-euc-kr.json").write_text(
        json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
    )
    print(
        {
            "codec": "euc_kr",
            "syllables": len(syllables),
            "vectors": len(fixture["cases"]),
            "mutations": 4096,
        },
        flush=True,
    )


def gb18030(root):
    # Its four-byte space is linear apart from unassigned intervals. Export
    # contiguous Unicode ranges rather than expanding 160,000 prefix states.
    pairs = bytearray()
    for first in range(128, 256):
        for second in range(256):
            result = decoded("gb18030", bytes([first, second]), False)
            value = ord(result["ok"]) if "ok" in result else 0xFFFFFFFF
            pairs.extend(struct.pack("<I", value))
    ranges = []
    digests = [hashlib.sha256(), hashlib.sha256()]
    boundary_samples = []
    previous = None
    for index in range(126 * 10 * 126 * 10):
        n = index
        fourth, n = n % 10 + 48, n // 10
        third, n = n % 126 + 129, n // 126
        second, first = n % 10 + 48, n // 10 + 129
        raw = bytes([first, second, third, fourth])
        results = [decoded("gb18030", raw, ignore) for ignore in [False, True]]
        value = ord(results[0]["ok"]) if "ok" in results[0] else None
        for digest, result in zip(digests, results):
            digest_result(digest, result)
        if value is not None:
            if ranges and ranges[-1][1] == index and previous == value - 1:
                ranges[-1][1] += 1
            else:
                ranges.append([index, index + 1, value])
                boundary_samples.append(raw)
        if value is None and previous is not None:
            boundary_samples.append(raw)
        previous = value
    encoded = base64.b64encode(zlib.compress(pairs, level=9)).decode()
    resource = {
        "baseline_sha": BASELINE,
        "python": sys.version.split()[0],
        "pairs": [encoded[i : i + 64] for i in range(0, len(encoded), 64)],
        "ranges": ranges,
        "aliases": {
            **{
                alias: target
                for alias, target in encodings.aliases.aliases.items()
                if target == "gb18030"
            },
            "gb18030": "gb18030",
        },
    }
    (root / "resources/document-codecs-gb18030.json").write_text(
        json.dumps(resource, indent=2) + "\n"
    )
    samples = boundary_samples + [bytes([byte]) for byte in range(256)]
    samples.extend([b"", bytes(range(256)), bytes(range(255, -1, -1))])
    for first in [0x80, 0x81, 0xFE, 0xFF]:
        for second in [0, 0x2F, 0x30, 0x39, 0x3A, 0x7F, 0x80, 0xFF]:
            for third in [0, 0x80, 0x81, 0xFE, 0xFF]:
                raw = bytes([first, second, third])
                samples.extend(
                    [raw, raw + b"0", raw + b"A", raw + b"\xff", b"a" + raw + b"0z"]
                )
    for text in ["中文文档與繁體字", "Synthetic 雪🌲 e\u0301\x00\uffff\U0010ffff"]:
        raw = text.encode("gb18030")
        samples.extend([raw, raw[:-1], raw[:-2], raw + b"\xff"])
    rng = random.Random(503)  # nosec B311 - reproducible decoding vectors
    for length in [3, 4, 7, 8, 16, 32, 64, 255]:
        for _ in range(8):
            samples.append(bytes(rng.randrange(256) for _ in range(length)))
    cases = [
        {
            "encoding": "gb18030",
            "data": base64.b64encode(raw).decode(),
            "ignore": ignore,
            "expected": decoded("gb18030", raw, ignore),
        }
        for raw in samples
        for ignore in [False, True]
    ]
    fixture = {
        "baseline_sha": BASELINE,
        "pairs": [
            {
                "encoding": "gb18030",
                "ignore": ignore,
                "sha256": pair_digest("gb18030", ignore),
            }
            for ignore in [False, True]
        ],
        "four_byte": [
            {"ignore": ignore, "sha256": digest.hexdigest()}
            for ignore, digest in zip([False, True], digests)
        ],
        "cases": cases,
    }
    (root / "tests/fixtures/document-codecs-gb18030.json").write_text(
        json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
    )
    print(
        {
            "codec": "gb18030",
            "ranges": len(ranges),
            "vectors": len(cases),
            "four_byte": 2 * 126 * 10 * 126 * 10,
        },
        flush=True,
    )


def export(root):
    cases = []
    pairs = []
    for group, names in GROUPS.items():
        tables = {}
        for name in names:
            tables[name] = decoder_table(name)
            for ignore in [False, True]:
                pairs.append(
                    {
                        "encoding": name,
                        "ignore": ignore,
                        "sha256": pair_digest(name, ignore),
                    }
                )
            samples = [bytes([byte]) for byte in range(256)]
            samples.extend([b"", bytes(range(256)), bytes(range(255, -1, -1))])
            for text in [
                "Synthetic ASCII \n\t",
                "中文文件日本語文書한국어",
                "日本語の文書、テスト。",
                "中文文档與繁體字",
                "한국어 문서",
                "Café £¥¢‾\\",
                "か゚か゚カ゚カ゚",
            ]:
                raw = text.encode(name, errors="ignore")
                samples.extend(
                    [raw, raw[:-1], raw + b"\xff", raw[:2] + b"\xff" + raw[2:]]
                )
            rng = random.Random(427)  # nosec B311 - reproducible decoding vectors
            for length in [3, 4, 7, 8, 16, 32, 64, 255]:
                for _ in range(8):
                    samples.append(bytes(rng.randrange(256) for _ in range(length)))
            # HZ changes state and accepts escapes/newlines; include mixed modes
            # and incomplete escape/pair boundaries beyond the byte-pair sweep.
            if name == "hz":
                samples.extend(
                    [
                        b"ASCII~{VPND~}tail",
                        b"~{VPND\n~}tail",
                        b"~{!~}tail",
                        b"~~ ~\n ASCII",
                        b"~{~{VPND~}~}",
                    ]
                )
            for raw in samples:
                for ignore in [False, True]:
                    cases.append(
                        {
                            "encoding": name,
                            "data": base64.b64encode(raw).decode(),
                            "ignore": ignore,
                            "expected": decoded(name, raw, ignore),
                        }
                    )
        aliases = {
            alias: target
            for alias, target in encodings.aliases.aliases.items()
            if target in names
        }
        aliases.update({name: name for name in names})
        resource = {
            "baseline_sha": BASELINE,
            "python": sys.version.split()[0],
            "format": "DCD1: zlib; little-endian header, transition rows, UTF-8 strings",
            "aliases": aliases,
            "codecs": tables,
        }
        (root / f"resources/document-codecs-{group}.json").write_text(
            json.dumps(resource, ensure_ascii=False, indent=2) + "\n"
        )
        print(
            {
                "group": group,
                "states": {name: value["states"] for name, value in tables.items()},
            },
            flush=True,
        )
    # Keep each reviewable fixture under the repository's file-size limit.
    for group, names in GROUPS.items():
        fixture = {
            "baseline_sha": BASELINE,
            "pairs": [pair for pair in pairs if pair["encoding"] in names],
            "cases": [case for case in cases if case["encoding"] in names],
        }
        (root / f"tests/fixtures/document-codecs-{group}.json").write_text(
            json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
        )
    print(
        {
            "codecs": sum(map(len, GROUPS.values())),
            "vectors": len(cases),
            "byte_pairs": len(pairs) * 65536,
        }
    )
    gb18030(root)
    euc_kr(root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
