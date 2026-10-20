"""Read-only preflights never consume or impersonate the strict writer script."""

import importlib
from pathlib import Path

import pytest


@pytest.fixture
def probe_scripts(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "migration"))
    return importlib.import_module("milvus_probe").ProbeScripts


def test_overlapping_probes_keep_exact_calls_bound_to_their_sessions(probe_scripts):
    scripts = [
        [{"method": "ShowCollections", "response_base64": "fresh"}],
        [
            {"method": "ShowCollections", "response_base64": "created"},
            {"method": "DescribeCollection", "body": {"collection_name": "owned"}},
        ],
        [
            {"method": "ShowCollections", "response_base64": "created"},
            {"method": "DescribeCollection", "body": {"collection_name": "owned"}},
        ],
    ]
    probes = probe_scripts(scripts)
    assert probes.remaining == 5
    assert probes.claim("ShowCollections", "first") == scripts[0][0]
    assert probes.claim("ShowCollections", "second") == scripts[1][0]
    assert probes.claim("ShowCollections", "third") == scripts[2][0]
    assert probes.remaining == 2
    # A separate writer or unclaimed session must stay on the writer path.
    assert probes.claim("DescribeCollection", "writer") is None
    assert probes.claim("Insert", "writer") is None
    assert probes.remaining == 2
    assert probes.claim("DescribeCollection", "third") == scripts[2][1]
    assert probes.claim("DescribeCollection", "second") == scripts[1][1]
    assert probes.remaining == 0
    assert probes.claim("ShowCollections", "extra")["method"] == "<unexpected probe>"
    assert len(scripts[1]) == 2


def test_probe_cannot_restart_or_turn_into_a_write(probe_scripts):
    scripts = [[{"method": "ShowCollections"}, {"method": "DescribeCollection"}]]
    probes = probe_scripts(scripts)
    assert probes.claim("ShowCollections", "owner") == scripts[0][0]
    assert probes.claim("ShowCollections", "owner")["method"] == "<unexpected probe>"
    assert probes.remaining == 1
    # The RPC validator receives the exact expected read and rejects the write;
    # claiming a probe never makes arbitrary requests match their own method.
    assert probes.claim("Insert", "owner")["method"] == "DescribeCollection"


@pytest.mark.parametrize("methods", [[], ["Insert"], ["ShowCollections", "Insert"]])
def test_probe_configuration_rejects_mutations(probe_scripts, methods):
    with pytest.raises(ValueError, match="Preflight must only"):
        probe_scripts([[{"method": method} for method in methods]])
