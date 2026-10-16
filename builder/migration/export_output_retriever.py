"""Export C09/C16 retrieval contracts inside the immutable baseline image.

Run with --network none and PYTHONPATH=/workspace. Only synthetic data is used.
"""

import argparse
import json
import re
import unicodedata
from pathlib import Path

from export_authorization import fixture_strings

BASELINE = "7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b"


def export(root):
    from re._casefix import _EXTRA_CASES

    import _sre
    from nat_helpers.tool_output_compaction import tool_output_reference
    from nat_helpers.tool_output_retriever import (
        ToolOutputRetrieverConfig,
        ToolOutputRetrieverInput,
        _page_content,
        _search_content,
    )

    # Python re.IGNORECASE uses simple lowercase plus extra equivalences, not
    # full casefold (which expands characters). Freeze the baseline Unicode
    # version so a Rust dependency upgrade cannot change search semantics.
    mappings = {}
    for code in range(0x110000):
        lower = _sre.unicode_tolower(code)
        canonical = min((lower, *_EXTRA_CASES.get(lower, ())))
        if code != canonical:
            if not re.fullmatch(chr(code), chr(canonical), re.IGNORECASE):
                raise AssertionError("Invalid baseline case equivalence")
            mappings[str(code)] = canonical
    metadata = {
        "baseline_sha": BASELINE,
        "unicode_version": unicodedata.unidata_version,
    }
    resource = {
        **metadata,
        "schema": ToolOutputRetrieverInput.model_json_schema(),
        "description": ToolOutputRetrieverConfig().description,
        "ignorecase": mappings,
    }
    cases = []
    configurations = []
    for field, values in [
        (
            "max_chunk_chars",
            [
                None,
                999,
                1000,
                50000,
                50001,
                1000.5,
                "1e3",
                "1_000",
                "1000.0",
                "+1000",
                " 1000 ",
                "01000",
            ],
        ),
        ("max_matches", [0, 1, 50, 51, True, False, "2.0"]),
        ("context_chars", [49, 50, 2000, 2001]),
        ("description", [None, 12, "Custom description"]),
        ("verbose", [True, 1, 2, "true", "yes", "off", "anything", None]),
        ("unknown", [True]),
    ]:
        for value in values:
            raw = {field: value}
            try:
                parsed = ToolOutputRetrieverConfig(**raw).model_dump()
            except ValueError:
                parsed = None
            configurations.append({"input": raw, "expected": parsed})
    for content in ["", "雪🌲e\u0301\n\x00" * 7, "abcd" * 300]:
        for offset in [0, 1, 3, len(content), len(content) + 10, 10**30]:
            inputs = dict(
                content=content,
                reference=tool_output_reference(content),
                offset=offset,
                max_chars=1000,
            )
            cases.append(
                {
                    "operation": "page",
                    "input": inputs,
                    "expected": _page_content(**inputs),
                }
            )
    searches = [
        ("雪🌲 error ERROR Error", "error"),
        ("aaaaa", "aa"),
        ("a.b a?b a*b a[b a(b a\\b", "a.b"),
        ("Iıİi ſS Kk Σσς ßẞ ss ﬅﬆ", "i"),
        ("Iıİi ſS Kk Σσς ßẞ ss ﬅﬆ", "s"),
        ("Iıİi ſS Kk Σσς ßẞ ss ﬅﬆ", "ß"),
        ("Iıİi ſS Kk Σσς ßẞ ss ﬅﬆ", "ss"),
        ("Iıİi ſS Kk Σσς ßẞ ss ﬅﬆ", "Σ"),
        ("prefix\x00\n雪🌲suffix", "\x00\n雪"),
        ("a" * 1200, "a" * 499 + "b"),
        ("abc", "absent"),
    ]
    # Exercise every nontrivial equivalence with Python's real search function.
    searches.extend(
        (chr(int(code)) + chr(canonical), chr(canonical))
        for code, canonical in mappings.items()
    )
    for content, query in searches:
        inputs = dict(
            content=content,
            reference=tool_output_reference(content),
            query=query,
            max_matches=2,
            context_chars=50,
        )
        cases.append(
            {
                "operation": "search",
                "input": inputs,
                "expected": _search_content(**inputs),
            }
        )
    for case in cases:
        # The expected output retains the baseline hash; avoid duplicating it
        # in every input of the exhaustive Unicode matrix.
        case["input"].pop("reference")
    for path, data in [
        (root / "resources/output-retriever.json", resource),
        (
            root / "tests/fixtures/output-retriever.json",
            fixture_strings(
                {
                    **metadata,
                    "matrix": ["C09", "C16"],
                    "configurations": configurations,
                    "cases": cases,
                }
            ),
        ),
    ]:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
