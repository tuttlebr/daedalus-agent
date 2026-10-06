"""The supervisor fails closed if its compiled controller is missing."""

import entrypoint
import pytest


def test_missing_rust_runtime_fails_before_starting_python(monkeypatch, tmp_path):
    monkeypatch.setenv("DAEDALUS_RUNTIME_BINARY", str(tmp_path / "missing"))
    started = []
    monkeypatch.setattr(
        entrypoint.subprocess, "Popen", lambda *args, **kwargs: started.append(args)
    )
    with pytest.raises(RuntimeError, match="binary is missing"):
        entrypoint.main()
    assert started == []
