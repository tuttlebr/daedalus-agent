"""Sequential ingestion scripts preserve writes and bound native read differences."""

import base64
import copy
import importlib
import json
from pathlib import Path

import pytest


@pytest.fixture
def sequential(monkeypatch):
    root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(root / "migration"))
    expand = importlib.import_module("profile_import_check").expand
    helper = importlib.import_module("ingestion_check").sequential_ingestion_scripts
    oracle = expand(
        json.loads(
            (root / "runtime/tests/fixtures/milvus-index-sequential.json").read_text()
        )
    )
    return helper, oracle


def test_native_sequence_adds_only_readiness_and_insert_schema_reads(sequential):
    helper, oracle = sequential
    original = copy.deepcopy(oracle)
    baseline = helper(oracle, False, 3)
    native = helper(oracle, True, 3)
    assert native[0] == baseline[0]
    for index in (1, 2):
        stage = native[index]
        assert [
            (call["method"], call["body"].get("collection_name")) for call in stage
        ] == [
            ("ShowCollections", None),
            ("DescribeCollection", "private_collection"),
            ("GetVersion", None),
            ("DescribeCollection", "private_collection"),
            ("DescribeIndex", "private_collection"),
            ("GetLoadingProgress", "private_collection"),
            ("DescribeCollection", "meta"),
            ("DescribeCollection", "meta"),
            ("Insert", "meta"),
            ("GetVersion", None),
            ("DescribeCollection", "private_collection"),
            ("DescribeCollection", "private_collection"),
            ("DescribeIndex", "private_collection"),
            ("DescribeIndex", "private_collection"),
            ("DescribeCollection", "private_collection"),
            ("Insert", "private_collection"),
            ("Flush", None),
            ("GetFlushState", "private_collection"),
            ("DescribeIndex", "private_collection"),
        ]
        # Removing just the four named additions restores the entire capture,
        # including every mutation, payload, response and authorization header.
        additions = {4, 5, 7, 14}
        assert [call for i, call in enumerate(stage) if i not in additions] == baseline[
            index
        ]
        assert stage[4]["metadata"]["dbname"] == ""
        assert stage[4]["response"]["index_descriptions"][0]["indexed_rows"] == str(
            index
        )
        assert stage[5]["response"]["progress"] == "100"
        for position in (7, 14):
            assert stage[position]["metadata"] == stage[position + 1]["metadata"]
            assert (
                stage[position]["response"]["schema"]["name"]
                == stage[position + 1]["body"]["collection_name"]
            )
    assert oracle == original
    native[0][0]["body"]["unexpected"] = True
    assert helper(oracle, True, 1) == [baseline[0]]


def test_capture_projection_preserves_wire_data_and_rejects_unexplained_drift(
    sequential,
):
    helper, oracle = sequential
    baseline = helper(oracle, False, 3)
    for captured, script in zip(oracle["cases"], baseline, strict=True):
        expected = copy.deepcopy(
            [call for call in captured["calls"] if call["method"] != "Connect"]
        )
        for call in expected:
            assert call["metadata"]["authorization"] == "dTpw"
            call["metadata"]["authorization"] = base64.b64encode(
                b"synthetic-user:synthetic-password"
            ).decode()
        assert script == expected
    for count in (0, 4):
        with pytest.raises(AssertionError, match="Uncaptured"):
            helper(oracle, True, count)
    changed = copy.deepcopy(oracle)
    changed["cases"][1]["expected"]["rows"]["meta"] = 1
    with pytest.raises(AssertionError, match="prior document state"):
        helper(changed, True, 3)
    changed = copy.deepcopy(oracle)
    changed["cases"][1]["calls"][1]["metadata"]["authorization"] = "unexpected"
    with pytest.raises(AssertionError, match="synthetic credentials"):
        helper(changed, True, 3)
