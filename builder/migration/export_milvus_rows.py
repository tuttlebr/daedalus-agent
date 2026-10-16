"""Capture row-order validation and scalar packing in the pinned Milvus SDK."""

import argparse
import base64
import copy
import json
from pathlib import Path

from export_authorization import BASELINE, fixture_strings


def export(root):
    from nv_ingest_client.util.vdb.milvus import create_nvingest_schema
    from pymilvus.client.prepare import Prepare
    from pymilvus.grpc_gen import schema_pb2

    sdk_schema = create_nvingest_schema(dense_dim=2)
    base_fields = sdk_schema.to_dict()["fields"]
    base_schema = Prepare.get_schema_from_collection_schema(
        "private_collection", sdk_schema
    )
    base = {"vector": [0.25, -0.5], "source": {}, "text": "Synthetic 雪🌲"}
    cases = []

    def add(name, rows, *, dynamic=True, extra=None, mutate=None):
        fields = copy.deepcopy(base_fields)
        schema = copy.deepcopy(base_schema)
        schema.enable_dynamic_field = dynamic
        if extra:
            fields.append(extra)
            proto = schema.fields.add(name=extra["name"], data_type=extra["type"])
            proto.nullable = extra.get("nullable", False)
            proto.is_function_output = extra.get("is_function_output", False)
            if "default_value" in extra:
                proto.default_value.CopyFrom(extra["default_value"])
        if mutate:
            mutate(fields, schema)
        try:
            request = Prepare.row_insert_param(
                "private_collection",
                rows,
                "",
                fields_info=fields,
                enable_dynamic=dynamic,
            )
            expected = {
                "base64": base64.b64encode(request.SerializeToString()).decode()
            }
        except Exception as error:
            expected = {"error": type(error).__name__, "message": str(error)}
        cases.append(
            {
                "name": name,
                "rows_json": json.dumps(rows),
                "schema": base64.b64encode(schema.SerializeToString()).decode(),
                "expected": expected,
            }
        )

    for rows in [[], [base], [base, base], [{}], [None], [1], ["abc"], [[]]]:
        add(f"shape-{len(cases)}", rows)
    for field in base:
        add(f"missing-{field}", [{k: v for k, v in base.items() if k != field}])
        add(f"null-{field}", [{**base, field: None}])
    for field, value in [("vector", 1), ("source", "bad"), ("text", 2)]:
        for other, other_value in [
            ("vector", False),
            ("source", "bad"),
            ("text", True),
        ]:
            if other == field:
                continue
            row = {field: value, other: other_value}
            row.update({k: v for k, v in base.items() if k not in row})
            add(f"field-order-{field}-{other}", [row])
            add(
                f"row-order-{field}-{other}",
                [{**base, field: value}, {**base, other: other_value}],
            )
        add(f"invalid-before-missing-{field}", [{field: value}])
    for dynamic in [False, True]:
        for rows in [
            [{**base, "custom": 1}],
            [{"custom": 1, "text": 2}],
            [{**base, "$meta": {}}],
            [{"$meta": {}, "text": 2}],
            [{**base, "pk": 7}],
            [base, {**base, "pk": 7}],
            [{**base, "pk": 7}, base],
            [{**base, "pk": None}],
            [{**base, "pk": True}],
            [{**base, "pk": 1.0}],
            [{**base, "pk": 2**63}],
            [{**base, "pk": "1"}],
            [{**base, "pk": []}],
            [{**base, "pk": {}}],
        ]:
            add(f"dynamic-{dynamic}-{len(cases)}", rows, dynamic=dynamic)
        for rows in [[base], [{**base, "computed": 1}], [{"computed": 1, "text": 2}]]:
            add(
                f"function-{dynamic}-{len(cases)}",
                rows,
                dynamic=dynamic,
                extra={"name": "computed", "type": 5, "is_function_output": True},
            )
    for value in [
        None,
        True,
        False,
        0,
        1,
        1.5,
        "",
        "12",
        {},
        {"1": 2},
        [],
        [1, True],
        [None],
        ["1"],
        [[]],
        [{}],
        [1e100],
        [2**64],
        [10**400],
    ]:
        add(f"vector-{len(cases)}", [{**base, "vector": value}])
    for vectors in [[None, []], [[], None], [[1], [2, 3]], [[1], None], [None, None]]:
        add(f"vector-rows-{len(cases)}", [{**base, "vector": v} for v in vectors])
    for dtype in [1, 2, 3, 4, 5, 10, 11]:
        for value in [
            None,
            False,
            True,
            0,
            -1,
            1.5,
            "1",
            [],
            {},
            2**31,
            2**63,
            -(2**63) - 1,
            10**400,
        ]:
            add(
                f"scalar-{dtype}-{len(cases)}",
                [{**base, "extra": value}],
                extra={"name": "extra", "type": dtype},
            )
    for default in [
        None,
        schema_pb2.ValueField(),
        schema_pb2.ValueField(long_data=0),
        schema_pb2.ValueField(long_data=7),
    ]:
        for nullable in [False, True]:
            extra = {"name": "extra", "type": 5, "nullable": nullable}
            if default is not None:
                extra["default_value"] = default
            for rows in [
                [base],
                [{**base, "extra": None}],
                [{**base, "extra": 1}, base],
            ]:
                add(f"default-{len(cases)}", rows, extra=extra)

    def short_text(fields, schema):
        fields[-1]["params"]["max_length"] = 1
        schema.fields[-1].type_params[0].value = "1"

    for value in ["long", ["long"], {"long": 1}, [1], {}, [], "🌲🌲"]:
        add(f"varchar-{len(cases)}", [{**base, "text": value}], mutate=short_text)

    def nullable(fields, schema):
        for field, proto in zip(fields, schema.fields, strict=True):
            field["nullable"] = True
            proto.nullable = True

    for rows in [[{}], [{"vector": None}], [base, {}]]:
        add(f"nullable-{len(cases)}", rows, mutate=nullable)
    (root / "tests/fixtures/milvus-rows.json").write_text(
        json.dumps(
            fixture_strings({"baseline_sha": BASELINE, "cases": cases}),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(f"Frozen {len(cases)} SDK row validation cases")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
