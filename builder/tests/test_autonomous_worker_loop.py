"""The charter loop retries infrastructure failures without logging private data."""

import threading
from unittest.mock import Mock

import pytest
from autonomous_agent import worker


@pytest.mark.parametrize("first", [False, ConnectionError("PRIVATE_ERROR")])
def test_loop_recovers_transient_lease_failure(monkeypatch, capsys, first):
    store = Mock()
    store.acquire_lease.side_effect = [first, True]
    stop = threading.Event()
    monkeypatch.setattr(stop, "wait", Mock(return_value=False))
    monkeypatch.setattr(worker, "SHUTDOWN", stop)
    monkeypatch.setattr(worker, "RedisStore", lambda: store)
    monkeypatch.setattr(worker.signal, "signal", Mock())
    monkeypatch.setenv("AUTONOMOUS_USER_ID", "user")

    def prepare(_user):
        stop.set()
        return None

    store.prepare.side_effect = prepare
    assert worker.main() == 0
    assert store.acquire_lease.call_count == 2
    store.release_lease.assert_called_once_with("user")
    assert "PRIVATE" not in capsys.readouterr().out


def test_worker_requires_connected_identity_before_accessing_redis(monkeypatch):
    monkeypatch.delenv("AUTONOMOUS_USER_ID", raising=False)
    factory = Mock()
    monkeypatch.setattr(worker, "RedisStore", factory)
    monkeypatch.setattr(worker.signal, "signal", Mock())
    with pytest.raises(ValueError, match="connected user"):
        worker.main()
    factory.assert_not_called()
