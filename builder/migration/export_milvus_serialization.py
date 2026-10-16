"""Freeze the pinned SDK's final row serialization and rejection messages."""

import argparse
import base64
import json
from pathlib import Path

from export_authorization import BASELINE, fixture_strings


def export(root):
    from nv_ingest_client.util.vdb.milvus import create_nvingest_schema
    from pymilvus.client.prepare import Prepare

    base = {
        "vector": [0.25, -0.5],
        "source": {"source_name": "Synthetic 雪🌲"},
        "content_metadata": {"page_number": 0},
        "text": "Synthetic indexed 雪🌲",
    }
    cases = []

    def add(name, key, value):
        cases.append((name, [{**base, key: value}]))

    for value in [
        "a\ud800b",
        "🌲\udfff",
        "\ud800\ud900",
        "\ud800x\udfff",
        "\U000f0000\ud800",
        "",
        1,
        True,
        [],
        {},
        None,
    ]:
        add(f"text-{len(cases)}", "text", value)
    for field in ["source", "content_metadata"]:
        for value in [
            {"value": "a\ud800b"},
            {"\udfff": "value"},
            {"value": "\U000f0000\ud800"},
            {"value": 2**64 - 1},
            {"value": 2**64},
            {"value": -(2**63)},
            {"value": -(2**63) - 1},
            {"value": 1e-7},
            {"value": 1e100},
            {"value": -0.0},
            [],
            [1, "雪🌲"],
            1,
            True,
            None,
            "",
            "bad",
            '{ "x": "雪🌲" }',
            '{"x":"\\ud800"}',
            '{"x":"\\udfff"}',
            '{"x":"\\ud83c\\udf32"}',
            '{"x":1,}',
            '{"x":NaN}',
            '{"x":1e309}',
        ]:
            add(f"{field}-{len(cases)}", field, value)
    for value in ["\ud800", {"x": "\udfff"}, 2**64, -(2**63) - 1, None, []]:
        add(f"dynamic-{len(cases)}", "custom", value)
    for depth in [127, 128, 252, 253, 254, 255, 256, 257, 511, 512, 600, 900]:
        value = {"snow": "雪", "number": 1}
        for _ in range(depth):
            value = [value]
        add(f"json-depth-{depth}", "source", value)
    for raw in [
        " ",
        "\n\t",
        "[",
        '{"',
        '"',
        "{]",
        "[1,",
        "[1 2]",
        '{"a" 1}',
        '{"a":}',
        '{"a":01}',
        '{"a":1.}',
        '{"a":1e}',
        '{"a":-}',
        "nul",
        "True",
        "true x",
        '"\\x"',
        '"\\u12"',
        '"\\ud800\\ud800"',
        '"\\ud800x"',
        '"\\udfff"',
        '"a\nb"',
        "\ufeff{}",
        '{"雪🌲":NaN}',
        '{\n"雪": 1,\n}',
        "null",
        "true",
        "false",
        "[1,2]",
        '"Snow 雪🌲"',
        '"\ud800"',
    ]:
        add(f"json-syntax-{len(cases)}", "source", raw)
    for leaf in [{"unit": "\ud800"}, {"integer": 2**64}]:
        deep = leaf
        for _ in range(254):
            deep = [deep]
        add(f"fallback-value-{len(cases)}", "source", deep)
    add("error-before-deep", "source", {"before": "\ud800", "deep": deep})
    add("deep-before-error", "source", {"deep": deep, "after": "\ud800"})
    fields = create_nvingest_schema(dense_dim=2).to_dict()["fields"]
    output = []
    for name, rows in cases:
        try:
            request = Prepare.row_insert_param(
                "private_collection",
                rows,
                "",
                fields_info=fields,
                enable_dynamic=True,
            )
            expected = {
                "base64": base64.b64encode(request.SerializeToString()).decode()
            }
        except Exception as error:
            expected = {"error": type(error).__name__, "message": str(error)}
        # Keep isolated UTF-16 units inside an ASCII-escaped JSON string. The
        # native test decodes each input independently with its marker mapping.
        output.append(
            {"name": name, "rows_json": json.dumps(rows), "expected": expected}
        )
    (root / "tests/fixtures/milvus-serialization.json").write_text(
        json.dumps(
            fixture_strings({"baseline_sha": BASELINE, "cases": output}),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(f"Frozen {len(output)} SDK serialization cases")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
