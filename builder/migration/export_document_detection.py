"""Freeze pinned charset-normalizer properties and detection helper contracts."""

import argparse
import base64
import ctypes
import encodings.aliases
import hashlib
import importlib.metadata
import json
import random
import struct
import unicodedata
import zlib
from pathlib import Path

from export_authorization import BASELINE
from export_document_encodings import fixture_strings

FIELDS = [
    "printable",
    "alpha",
    "upper",
    "lower",
    "space",
    "digit",
    "is_ascii",
    "case_variable",
    "accentuated",
    "latin",
    "is_cjk",
    "is_arabic",
    "is_glyph",
    "punct",
    "sym",
    "sep",
    "emoticon",
    "safe",
    "common_cjk",
    "arabic_isolated",
    "case_ignorable",
    "cased",
]


def compressed(raw):
    encoded = base64.b64encode(zlib.compress(raw, level=9)).decode()
    return [encoded[i : i + 64] for i in range(0, len(encoded), 64)]


def export(root):
    from charset_normalizer import __version__
    from charset_normalizer.api import IANA_SUPPORTED_MB_FIRST
    from charset_normalizer.cd import (
        alpha_unicode_split,
        coherence_ratio,
        encoding_languages,
        mb_encoding_languages,
        merge_coherence_ratios,
    )
    from charset_normalizer.constant import (
        _ARABIC_ISOLATED_FORM,
        CHARDET_CORRESPONDENCE,
        ENCODING_MARKS,
        FREQUENCIES,
        IANA_SUPPORTED_SIMILAR,
        UNICODE_RANGES_COMBINED,
    )
    from charset_normalizer.md import (
        CharInfo,
        is_suspiciously_successive_range,
        mess_ratio,
    )
    from charset_normalizer.utils import (
        is_multi_byte_encoding,
        is_unicode_range_secondary,
        remove_accent,
    )

    ignorable = ctypes.pythonapi._PyUnicode_IsCaseIgnorable
    ignorable.argtypes = [ctypes.c_uint]
    ignorable.restype = ctypes.c_int
    cased = ctypes.pythonapi._PyUnicode_IsCased
    cased.argtypes = [ctypes.c_uint]
    cased.restype = ctypes.c_int
    ranges = [None, *UNICODE_RANGES_COMBINED]
    range_ids = {name: index for index, name in enumerate(ranges)}
    properties = []
    lower = {}
    accents = {}
    digest = hashlib.sha256()
    for n in range(0x110000):
        character = chr(n)
        info = CharInfo(character)
        flags = sum(
            int(getattr(info, name)) << index for index, name in enumerate(FIELDS[:19])
        )
        flags |= int(bool(info.flags & _ARABIC_ISOLATED_FORM)) << 19
        flags |= int(bool(ignorable(n))) << 20
        flags |= int(bool(cased(n))) << 21
        range_id = range_ids[info.range]
        digest.update(struct.pack("<IH", flags, range_id))
        if not properties or properties[-1][1:] != [flags, range_id]:
            properties.append([n, flags, range_id])
        if character.lower() != character:
            lower[str(n)] = [ord(c) for c in character.lower()]
        if info.accentuated:
            try:
                accent = ord(remove_accent(character))
                if accent != n:
                    accents[str(n)] = accent
            except ValueError:
                accents[str(n)] = None
    suspicious = bytes(
        is_suspiciously_successive_range(a, b) for a in ranges for b in ranges
    )
    properties_resource = {
        "baseline_sha": BASELINE,
        "charset_normalizer": __version__,
        "python_unicode": unicodedata.unidata_version,
        "fields": FIELDS,
        "ranges": ranges,
        "properties": properties,
        "properties_sha256": digest.hexdigest(),
        "lower": lower,
        "accents": accents,
        "suspicious": compressed(suspicious),
        "range_secondary": [
            False if name is None else is_unicode_range_secondary(name)
            for name in ranges
        ],
    }
    (root / "resources/document-detection-properties.json").write_text(
        json.dumps(properties_resource, ensure_ascii=False, indent=2) + "\n"
    )
    languages = {
        name: {
            "multi": is_multi_byte_encoding(name),
            "languages": mb_encoding_languages(name)
            if is_multi_byte_encoding(name)
            else encoding_languages(name),
        }
        for name in IANA_SUPPORTED_MB_FIRST
    }
    detection_resource = {
        "baseline_sha": BASELINE,
        "charset_normalizer": __version__,
        "aliases": encodings.aliases.aliases,
        "encodings": languages,
        "similar": IANA_SUPPORTED_SIMILAR,
        "frequencies": FREQUENCIES,
        "chardet": CHARDET_CORRESPONDENCE,
        "marks": {
            name: [
                base64.b64encode(raw).decode()
                for raw in (values if isinstance(values, list) else [values])
            ]
            for name, values in ENCODING_MARKS.items()
        },
    }
    (root / "resources/document-detection.json").write_text(
        json.dumps(detection_resource, ensure_ascii=False, indent=2) + "\n"
    )

    texts = [
        "",
        "Synthetic ASCII document. Text with words, numbers 123 and spaces.",
        "Préférences françaises : café, été, forêt et résultats du document.",
        "Русский текст для проверки кодировки документа.",
        "日本語の文書を変換します。 テキストを確認します。",
        "中文文档转换测试。今天我们一起学习中文。",
        "한국어 문서 테스트입니다.",
        "مرحبا بالعالم هذا نص عربي لاختبار المستند",
        "Αυτή είναι μια δοκιμή ελληνικού κειμένου.",
        "これはABC와한글和中文です。",
        "pRÉFÉRENCES àÀàÀ éÉéÉ \ufeff",
        "éééé œœœœ àààà ùùùù îîîî ",
        "俑鼹鼷龘麤灥爨纞虋讟钃鸜龗龞龡龢",
        "ﺍﺏﺕﺙﺝﺡﺥﺩﺫﺭﺯﺱﺵﺹ",
        "\ud800A\udfff\x00\x1a\ufeff",
        "[[[[[[ ]] {{{ } } } **** ++===--|<>&",
        "Longforeignwordé" * 8,
        "ÉnormouslylongForeignWordWithAccents" * 4,
        "latin雪latin latin雪latin latin雪latin ",
        "A\u001cB\u001dC\u001eD\u001fE",
    ]
    samples = []
    for text in texts:
        samples.extend([text, text * 12])
        for length in [31, 32, 33, 510, 511, 512, 1023, 1024, 1025]:
            samples.append((text * (length // max(1, len(text)) + 1))[:length])
    rng = random.Random(1409)  # nosec B311 - reproducible detector vectors
    alphabet = "".join(texts)
    for length in [7, 8, 13, 14, 23, 24, 31, 32, 33, 64, 65, 511, 1024]:
        for _ in range(8):
            samples.append("".join(rng.choice(alphabet) for _ in range(length)))
    cases = []
    for text in samples:
        results = []
        for threshold in [0.0, 0.1, 0.2, 0.5, 1.0, 2.0]:
            try:
                expected = {"ok": mess_ratio(text, threshold)}
            except ValueError:
                expected = {"error": "ValueError"}
            results.append({"threshold": threshold, "expected": expected})
        cases.append({"codepoints": [ord(c) for c in text], "results": results})
    # Packed code points keep long/control/surrogate vectors readable to tools
    # while avoiding invalid UTF-8 in the fixture files themselves.
    for case in cases:
        case["codepoints"] = compressed(
            b"".join(struct.pack("<I", n) for n in case["codepoints"])
        )
    fixture = {"baseline_sha": BASELINE, "cases": cases}
    (root / "tests/fixtures/document-detection-chaos.json").write_text(
        json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
    )
    coherence_cases = []
    for text in samples + ["AΣ", "ΑΣΑ", "AΣʰB", "ΟΣ ΟΣΑ", "İIı", "AΣʰ"]:
        checks = []
        for inclusion in [
            None,
            "Latin Based",
            "English,French",
            "Japanese",
            "Chinese,Korean",
        ]:
            for threshold in [0.1, 0.8]:
                checks.append(
                    {
                        "inclusion": inclusion,
                        "threshold": threshold,
                        "expected": coherence_ratio(text, threshold, inclusion),
                    }
                )
        coherence_cases.append(
            {
                "codepoints": compressed(
                    b"".join(struct.pack("<I", ord(c)) for c in text)
                ),
                "layers": [
                    [ord(c) for c in layer] for layer in alpha_unicode_split(text)
                ],
                "checks": checks,
            }
        )
    merges = []
    for _ in range(48):
        chunks = [
            [
                (
                    rng.choice(["English", "English—", "French", "Korean", "Japanese"]),
                    rng.randint(0, 10000) / 10000,
                )
                for _ in range(rng.randint(0, 8))
            ]
            for _ in range(rng.randint(0, 8))
        ]
        merges.append({"input": chunks, "expected": merge_coherence_ratios(chunks)})
    # Split by complete text cases so each fixture remains below the size cap.
    for index in range(3):
        fixture = {
            "baseline_sha": BASELINE,
            "cases": coherence_cases[index::3],
            "merges": merges[index::3],
        }
        (root / f"tests/fixtures/document-detection-coherence-{index}.json").write_text(
            json.dumps(
                fixture_strings(json.loads(json.dumps(fixture))),
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
    notices = root / "notices"
    notices.mkdir(exist_ok=True)
    distribution = importlib.metadata.distribution("charset-normalizer")
    license_file = next(path for path in distribution.files if path.name == "LICENSE")
    (notices / "charset-normalizer.txt").write_text(
        distribution.locate_file(license_file).read_text()
    )
    print(
        {
            "property_spans": len(properties),
            "ranges": len(ranges),
            "texts": len(cases),
            "chaos_cases": len(cases) * 6,
            "coherence_cases": len(coherence_cases) * 10,
            "merges": len(merges),
        },
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
