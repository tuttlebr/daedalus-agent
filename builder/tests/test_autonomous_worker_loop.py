"""Exercise the worker's real loop at the Redis and process boundaries."""

from unittest.mock import Mock

import pytest
from autonomous_agent import worker


@pytest.mark.parametrize("first_acquisition", [ConnectionError("offline"), False])
def test_worker_retries_lease_acquisition_before_processing(
    monkeypatch, first_acquisition
):
    store = Mock()
    store.acquire_lease.side_effect = [first_acquisition, True]
    store.reclaim_processing.return_value = 0
    store.maybe_enqueue_scheduled.return_value = None
    store.refresh_lease.return_value = True

    def stop_when_queue_is_reached(*_args, **_kwargs):
        monkeypatch.setattr(worker, "STOP", True)
        return None

    store.dequeue.side_effect = stop_when_queue_is_reached
    sleep = Mock()
    monkeypatch.setattr(worker, "STOP", False)
    monkeypatch.setattr(worker, "RedisStore", lambda: store)
    monkeypatch.setattr(worker, "make_backend", Mock())
    monkeypatch.setattr(worker, "start_queue_monitor", Mock())
    monkeypatch.setattr(worker.signal, "signal", Mock())
    monkeypatch.setattr(worker.time, "sleep", sleep)
    monkeypatch.setenv("AUTONOMOUS_USER_ID", "recovery-user")
    monkeypatch.setenv("AUTONOMY_WORKER_POLL_INTERVAL", "10")
    monkeypatch.setenv("AUTONOMY_WORKER_LEASE_TTL", "60")

    assert worker.main() == 0

    assert store.acquire_lease.call_count == 2
    sleep.assert_called_once_with(10)
    store.reclaim_processing.assert_called_once_with("recovery-user")
    store.dequeue.assert_called_once_with("recovery-user", timeout=10)
    store.refresh_lease.assert_called_once_with("recovery-user", ttl_seconds=60)
    store.release_lease.assert_called_once_with("recovery-user")


@pytest.mark.parametrize(
    ("poll_interval", "lease_ttl", "message"),
    [
        ("0", "60", "POLL_INTERVAL must be greater than zero"),
        ("-1", "60", "POLL_INTERVAL must be greater than zero"),
        ("60", "60", "LEASE_TTL must be greater than"),
        ("90", "60", "LEASE_TTL must be greater than"),
        ("fast", "60", "POLL_INTERVAL must be an integer"),
        ("10", "1m", "LEASE_TTL must be an integer"),
    ],
)
def test_worker_rejects_polling_that_cannot_keep_its_lease(
    monkeypatch, poll_interval, lease_ttl, message
):
    # A zero BRPOPLPUSH timeout blocks forever, and a poll at least as long as
    # the lease lets an idle worker lose ownership on every cycle.
    store_factory = Mock(
        side_effect=AssertionError("worker connected before validating timing")
    )
    monkeypatch.setattr(worker, "RedisStore", store_factory)
    monkeypatch.setattr(worker.signal, "signal", Mock())
    monkeypatch.setenv("AUTONOMY_WORKER_POLL_INTERVAL", poll_interval)
    monkeypatch.setenv("AUTONOMY_WORKER_LEASE_TTL", lease_ttl)

    with pytest.raises(ValueError, match=message):
        worker.main()

    store_factory.assert_not_called()


@pytest.mark.parametrize("failed_acquisition", [False, True])
def test_worker_logs_exclude_request_content_and_raw_errors(
    monkeypatch, capsys, failed_acquisition
):
    store = Mock()
    store.acquire_lease.side_effect = (
        [ConnectionError("PRIVATE_ERROR_DETAILS"), True]
        if failed_acquisition
        else [True]
    )
    store.reclaim_processing.return_value = 0
    store.maybe_enqueue_scheduled.return_value = None
    store.queue_length.return_value = 0
    store.dequeue.return_value = {
        "id": "request-123",
        "trigger": "manual",
        "prompt": "PRIVATE_PROMPT",
        "requestedBy": "PRIVATE_REQUESTER",
    }
    monkeypatch.setattr(worker, "STOP", False)
    monkeypatch.setattr(worker, "RedisStore", lambda: store)
    monkeypatch.setattr(worker, "make_backend", Mock())
    monkeypatch.setattr(worker, "start_queue_monitor", Mock())
    monkeypatch.setattr(worker.signal, "signal", Mock())
    monkeypatch.setattr(worker.time, "sleep", Mock())
    monkeypatch.setattr(
        worker,
        "run_with_lease_heartbeat",
        Mock(
            return_value={"id": "run-123", "status": "failed", "error": "PRIVATE_ERROR"}
        ),
    )
    monkeypatch.setenv("AUTONOMOUS_USER_ID", "PRIVATE_USER")
    monkeypatch.setenv("AUTONOMY_RUN_ONCE", "true")
    monkeypatch.setenv("AUTONOMY_WORKER_POLL_INTERVAL", "10")
    monkeypatch.setenv("AUTONOMY_WORKER_LEASE_TTL", "60")

    assert worker.main() == 0

    output = capsys.readouterr().out
    assert "PRIVATE" not in output
    assert "request-123" in output
    assert "run-123" in output
    assert "status=failed" in output
    store.complete.assert_called_once_with("PRIVATE_USER")
