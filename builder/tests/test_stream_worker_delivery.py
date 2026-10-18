"""Stream-worker settings must reach the processes that read them, consistently."""

import re
import subprocess
from fnmatch import fnmatchcase
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = (ROOT / "deploy.sh").read_text(encoding="utf-8")


def deploy_keys(group):
    match = re.search(rf"{group}_SECRET_KEYS=\((.*?)\n  \)", DEPLOY, re.S)
    assert match, group
    return match.group(1).split()


def delivered(group, name):
    return any(fnmatchcase(name, pattern) for pattern in deploy_keys(group))


def test_queue_identity_reaches_both_producer_and_consumer():
    # frontend/server/chat/streamQueue.ts: the API enqueues and the worker
    # consumes using the same two names. Delivering them to only one Secret
    # silently splits the queue.
    for name in ("STREAM_WORKER_QUEUE_KEY", "STREAM_WORKER_GROUP"):
        assert delivered("FRONTEND", name) == delivered("STREAM_WORKER", name), name


def test_documented_stream_connect_timeout_reaches_the_worker():
    source = (ROOT / "frontend/server/chat/constants.ts").read_text()
    assert "process.env.STREAM_CONNECT_TIMEOUT_MS" in source
    assert "STREAM_CONNECT_TIMEOUT_MS=" in (ROOT / ".env.template").read_text()
    assert delivered("STREAM_WORKER", "STREAM_CONNECT_TIMEOUT_MS")


def render(*settings):
    command = ["helm", "template", "fixture", "helm/daedalus"]
    for setting in settings:
        command += ["--set", setting]
    output = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    return [document for document in yaml.safe_load_all(output) if document]


def container_env(documents, component):
    workload = next(
        d
        for d in documents
        if d["kind"] == "Deployment"
        and d["spec"]["template"]["metadata"]["labels"].get(
            "app.kubernetes.io/component"
        )
        == component
    )
    env = workload["spec"]["template"]["spec"]["containers"][0]["env"]
    return {item["name"]: item.get("value") for item in env}


@pytest.mark.requires_helm
def test_worker_overrides_are_applied_instead_of_silently_dropped():
    worker = container_env(
        render(
            "frontend.streamWorker.env.overrides.BACKEND_API_PATH=/v1/fixture",
            "frontend.streamWorker.env.overrides.BACKEND_HOST=fixture-backend",
            "frontend.streamWorker.env.overrides.STREAM_CONNECT_TIMEOUT_MS=45000",
        ),
        "frontend-stream-worker",
    )
    assert worker["BACKEND_API_PATH"] == "/v1/fixture"
    assert worker["BACKEND_HOST"] == "fixture-backend"
    assert worker["STREAM_CONNECT_TIMEOUT_MS"] == "45000"


@pytest.mark.requires_helm
def test_chart_managed_queue_identity_can_match_in_both_workloads():
    documents = render(
        "frontend.env.overrides.STREAM_WORKER_QUEUE_KEY=fixture-queue",
        "frontend.streamWorker.env.overrides.STREAM_WORKER_QUEUE_KEY=fixture-queue",
    )
    assert container_env(documents, "frontend")["STREAM_WORKER_QUEUE_KEY"] == (
        "fixture-queue"
    )
    assert container_env(documents, "frontend-stream-worker")[
        "STREAM_WORKER_QUEUE_KEY"
    ] == ("fixture-queue")
