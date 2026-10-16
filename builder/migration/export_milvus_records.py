"""Freeze NV-Ingest record cleanup, including mutations and error precedence."""

import argparse
import copy
import json
from pathlib import Path

from export_authorization import BASELINE, fixture_strings


def export(root):
    from nv_ingest_client.util.vdb.milvus import cleanup_records

    base = {
        "document_type": "text",
        "metadata": {
            "content": "Synthetic 雪🌲",
            "embedding": [0.25, -0.5],
            "source_metadata": {"source_name": "synthetic.txt"},
            "content_metadata": {"subtype": "table", "page_number": 1},
            "table_metadata": {
                "table_content": "Table",
                "table_location": [1, 2, 3, 4],
                "table_location_max_dimensions": [100, 200],
            },
            "image_metadata": {
                "caption": "Caption",
                "text": "Page",
                "image_location": [1, 2, 3, 4],
                "image_location_max_dimensions": [100, 200],
            },
            "audio_metadata": {"audio_transcript": "Transcript"},
        },
    }
    values = [None, False, True, 0, 1, 1.5, "", "bad", [], [1], {}, {"key": "value"}]
    cases = []

    def differences(before, after, path=()):
        if before == after and type(before) is type(after):
            return []
        if isinstance(before, dict) and isinstance(after, dict):
            changes = []
            for key, value in before.items():
                if key not in after:
                    changes.append(["remove", [*path, key]])
                else:
                    changes.extend(differences(value, after[key], (*path, key)))
            for key, value in after.items():
                if key not in before:
                    changes.append(["set", [*path, key], value])
            return changes
        return [["set", list(path), after]]

    def compact(value):
        if isinstance(value, list):
            return [compact(item) for item in value]
        if isinstance(value, dict):
            if "document_type" in value or "metadata" in value:
                return {"$entry_delta": differences(base, value)}
            return {key: compact(item) for key, item in value.items()}
        return value

    def add(name, records):
        mutated = copy.deepcopy(records)
        try:
            expected = {"ok": cleanup_records(mutated)}
        except Exception as error:
            expected = {"error": type(error).__name__, "message": str(error)}
        cases.append(
            {
                "name": name,
                "input": compact(records),
                "expected": compact(expected),
                "mutated": compact(mutated),
            }
        )

    for value in values:
        for level in range(3):
            records = copy.deepcopy(value)
            for _ in range(level):
                records = [records]
            add(f"shape-{len(cases)}", records)
    for kind in ["text", "structured", "image", "audio", "unknown", None, 1, [], {}]:
        entry = copy.deepcopy(base)
        entry["document_type"] = kind
        add(f"type-{len(cases)}", [[entry]])
        for field in base["metadata"]:
            for value in values:
                changed = copy.deepcopy(entry)
                changed["metadata"][field] = value
                add(f"field-{len(cases)}", [[changed]])
            changed = copy.deepcopy(entry)
            del changed["metadata"][field]
            add(f"missing-{len(cases)}", [[changed]])
    for field in ["document_type", "metadata"]:
        changed = copy.deepcopy(base)
        del changed[field]
        add(f"outer-missing-{field}", [[changed]])
    for value in values:
        changed = copy.deepcopy(base)
        changed["metadata"] = value
        add(f"metadata-{len(cases)}", [[changed]])
    for kind, field in [
        ("structured", "table_metadata"),
        ("image", "image_metadata"),
        ("audio", "audio_metadata"),
    ]:
        for key in base["metadata"][field]:
            for value in values:
                changed = copy.deepcopy(base)
                changed["document_type"] = kind
                changed["metadata"][field][key] = value
                add(f"nested-{len(cases)}", [[changed]])
            changed = copy.deepcopy(base)
            changed["document_type"] = kind
            del changed["metadata"][field][key]
            add(f"nested-missing-{len(cases)}", [[changed]])
    # Mutations before an error remain visible, and an empty embedding is present.
    for value in values:
        changed = copy.deepcopy(base)
        changed["metadata"]["content_metadata"] = value
        add(f"late-error-{len(cases)}", [[base, changed]])
    parts = [cases[i : i + 300] for i in range(0, len(cases), 300)]
    for part, cases in enumerate(parts):
        (root / f"tests/fixtures/milvus-records-{part}.json").write_text(
            json.dumps(
                fixture_strings(
                    {"baseline_sha": BASELINE, "entry": base, "cases": cases}
                ),
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
    print(
        f"Frozen {sum(map(len, parts))} SDK record cleanup cases in {len(parts)} parts"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
