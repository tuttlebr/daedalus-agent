"""Charter persistence and real worker behavior against disposable Redis."""

import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from autonomous_agent.backend_client import BackendRejectedError
from autonomous_agent.charter import CharterConfig, CharterOutput
from autonomous_agent.scheduling import action
from autonomous_agent.store import RedisStore, WorkerLeaseLost, key, now_ms
from autonomous_agent.worker import run_once

pytestmark = pytest.mark.integration


@pytest.fixture
def store_user():
    store = RedisStore(os.environ["REDIS_URL"])
    user = f"charter-itest-{uuid.uuid4().hex}"
    assert store.acquire_lease(user)
    try:
        yield store, user
    finally:
        for item in store.redis.scan_iter(match=f"autonomy:{user}:*"):
            store.redis.delete(item)
        store.redis.close()


def seed(store, user, kind="cluster_maintenance"):
    item = action(kind, "test", now_ms())
    store.update(
        user, lambda state, _config: state["actions"].update({item["id"]: item})
    )
    return item


def completed():
    return CharterOutput.model_validate(
        {
            "outcome": {
                "status": "completed",
                "summary": "Application recovered.",
                "evidence": [
                    {"description": "Application API and workload checks passed."}
                ],
            }
        }
    )


def test_charter_ignores_retired_configuration_and_pending_research(store_user):
    store, user = store_user
    store.redis.set(
        f"autonomy:{user}:config",
        json.dumps({"enabled": False, "mode": "research_feed"}),
    )
    store.redis.lpush(
        f"autonomy:{user}:queue", json.dumps({"prompt": "PRIVATE_RETIRED_TASK"})
    )
    assert store.get_config(user).enabled
    task = store.prepare(user)
    assert task["kind"] in {
        "calendar_discovery",
        "sports_discovery",
        "cluster_maintenance",
        "evolution",
    }
    assert "PRIVATE_RETIRED_TASK" not in json.dumps(store.get_state(user))


def test_lost_lease_cannot_claim_or_persist_over_successor(store_user):
    store, user = store_user
    item = seed(store, user)
    claimed = store.claim(user, item["id"])
    store.redis.delete(key(user, "lease"))
    successor = RedisStore(os.environ["REDIS_URL"])
    try:
        assert successor.acquire_lease(user)
        successor.prepare(user)
        before = successor.get_state(user)
        with pytest.raises(WorkerLeaseLost):
            store.finish(user, item["id"], claimed["run"]["id"], completed())
        assert successor.get_state(user) == before
        assert before["actions"][item["id"]]["status"] == "uncertain"
        assert before["runs"][0]["status"] == "uncertain"
    finally:
        successor.redis.close()


def test_configuration_change_during_claim_is_rechecked_in_transaction(
    store_user, monkeypatch
):
    store, user = store_user
    item = seed(store, user)
    import autonomous_agent.store as module

    original = module.select_due
    calls = []

    def pause_during_selection(state, config, timestamp):
        selected = original(state, config, timestamp)
        if not calls:
            calls.append(True)
            paused = CharterConfig(enabled=False)
            store.redis.set(key(user, "config"), paused.model_dump_json())
        return selected

    monkeypatch.setattr(module, "select_due", pause_during_selection)
    assert store.claim(user, item["id"]) is None
    assert store.get_state(user)["actions"][item["id"]]["status"] == "pending"


def test_concurrent_claims_dispatch_exactly_once(store_user):
    store, user = store_user
    item = seed(store, user)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: store.claim(user, item["id"]), range(4)))
    assert sum(result is not None for result in results) == 1
    assert len(store.get_state(user)["runs"]) == 1


def test_worker_persists_verified_outcome_without_per_run_feed(store_user):
    store, user = store_user
    item = seed(store, user)

    class Backend:
        def call(self, messages, **kwargs):
            assert store.get_state(user)["actions"][item["id"]]["status"] == "running"
            assert kwargs["charter_task"]["kind"] == "cluster_maintenance"
            assert "Do not delete persistent data" in messages[0]["content"]
            return completed().model_dump_json()

    result = run_once(store=store, user_id=user, task_id=item["id"], backend=Backend())
    assert result["outcome"]["status"] == "completed"
    state = store.get_state(user)
    assert state["actions"][item["id"]]["status"] == "completed"
    assert not state["summaries"]
    assert not store.redis.exists(f"autonomy:{user}:feed")
    assert (
        run_once(store=store, user_id=user, task_id=item["id"], backend=Backend())
        is None
    )


def test_worker_retries_admission_refusal_without_replaying_uncertain_effects(
    store_user,
):
    store, user = store_user
    item = seed(store, user)

    class Backend:
        def call(self, *_args, **_kwargs):
            raise BackendRejectedError(400)

    run_once(store=store, user_id=user, task_id=item["id"], backend=Backend())
    saved = store.get_state(user)["actions"][item["id"]]
    assert saved["status"] == "pending"
    assert saved["dueAt"] > saved["updatedAt"]
    assert saved["outcome"]["status"] == "deferred"
    assert saved["outcome"]["mutationAttempted"] is False


def test_worker_cancel_aborts_stream_and_records_uncertain_effects(store_user):
    store, user = store_user
    item = seed(store, user)
    started = threading.Event()

    class Backend:
        def call(self, _messages, *, execution_id, abort, **_kwargs):
            started.set()
            store.redis.set(key(user, f"cancel:{execution_id}"), "1")
            assert abort.wait(3), "Stop must reach the open backend request"
            return completed().model_dump_json()

    run_once(store=store, user_id=user, task_id=item["id"], backend=Backend())
    assert started.is_set()
    assert store.get_state(user)["actions"][item["id"]]["status"] == "uncertain"


def test_invalid_output_never_leaks_model_text_or_publishes_success(store_user):
    store, user = store_user
    item = seed(store, user)

    class Backend:
        def call(self, *_args, **_kwargs):
            return "PRIVATE MODEL PLANNING"

    run_once(store=store, user_id=user, task_id=item["id"], backend=Backend())
    state = store.get_state(user)
    assert "PRIVATE MODEL" not in json.dumps(state)
    assert state["actions"][item["id"]]["status"] == "uncertain"


def test_corrupt_state_is_not_silently_replaced(store_user):
    store, user = store_user
    raw = '{"version": 1, "important": "retain this"}'
    store.redis.set(key(user, "state"), raw)
    with pytest.raises(ValueError):
        store.prepare(user)
    assert store.redis.get(key(user, "state")) == raw


def test_claim_rechecks_rule_window_after_selection(store_user, monkeypatch):
    from datetime import datetime

    store, user = store_user
    config = CharterConfig.model_validate(
        {
            "responsibilities": {
                "lighting": {
                    "rules": [
                        {
                            "id": "steelers",
                            "title": "Steelers kickoff",
                            "weekdays": [6],
                            "months": [11],
                        }
                    ]
                }
            }
        }
    )
    store.redis.set(key(user, "config"), config.model_dump_json())
    sunday = int(datetime.fromisoformat("2026-11-08T23:59:59-05:00").timestamp() * 1000)
    item = action(
        "sports_discovery", "steelers", sunday, payload={"ruleId": "steelers"}
    )
    store.update(user, lambda state, _: state["actions"].update({item["id"]: item}))
    monkeypatch.setattr("autonomous_agent.store.now_ms", lambda: sunday + 2000)
    assert store.claim(user, item["id"]) is None
    monkeypatch.setattr("autonomous_agent.store.now_ms", lambda: sunday)
    assert store.claim(user, item["id"]) is not None


def test_retired_briefing_cannot_dispatch_or_publish(store_user):
    store, user = store_user
    item = action("daily_summary", "old", now_ms(), payload={"date": "2026-11-09"})
    store.update(
        user, lambda state, _config: state["actions"].update({item["id"]: item})
    )
    assert run_once(store=store, user_id=user, task_id=item["id"]) is None
    store.prepare(user)
    state = store.get_state(user)
    assert state["actions"][item["id"]]["status"] == "cancelled"
    assert state["summaries"] == []
