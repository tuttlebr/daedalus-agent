"""Behavioral checks for bundled helpers using local fixtures, never live systems."""

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

SKILLS = Path(__file__).resolve().parents[2] / "skills"


def module(skill, filename):
    spec = importlib.util.spec_from_file_location(
        filename, SKILLS / skill / "scripts" / f"{filename}.py"
    )
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[filename] = loaded
    spec.loader.exec_module(loaded)
    return loaded


@pytest.mark.parametrize(
    "body",
    [
        None,
        "proxy OK",
        {},
        {"error": "failure"},
        {"model": "m", "choices": []},
        {
            "model": "m",
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": ""},
                }
            ],
        },
        {
            "model": "other",
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "hi"},
                }
            ],
        },
    ],
)
def test_router_rejects_200_without_a_completion(body, monkeypatch, capsys):
    router = module("dynamo-router-starter", "check_router_health")
    monkeypatch.setattr(sys, "argv", ["check", "--model", "m", "--retries", "1"])
    monkeypatch.setattr(
        router,
        "request_json",
        lambda method, *args, **kwargs: (200, {"data": [{"id": "m"}]})
        if method == "GET"
        else (200, body),
    )
    assert router.main() == router.EXIT_CHAT_FAILED
    assert json.loads(capsys.readouterr().out)["ok"] is False


def test_router_accepts_requested_model_content(monkeypatch, capsys):
    router = module("dynamo-router-starter", "check_router_health")
    body = {
        "model": "m",
        "choices": [
            {
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "hello"},
            }
        ],
    }
    monkeypatch.setattr(sys, "argv", ["check", "--model", "m", "--timeout", "3"])
    monkeypatch.setattr(
        router,
        "request_json",
        lambda method, *args, **kwargs: (200, {"data": [{"id": "m"}]})
        if method == "GET"
        else (200, body),
    )
    assert router.main() == 0
    assert json.loads(capsys.readouterr().out)["ok"]


def test_interconnect_never_claims_an_unperformed_transfer():
    probe = module("dynamo-interconnect-check", "check_interconnect")
    for checks in [
        [],
        [probe.Check("tool", "skipped", "missing")],
        [probe.Check("binary", "ok", "found")],
    ]:
        result = probe.summarize(checks)
        assert result["transfer_validated"] is False
        assert "not validated" in result["verdict"]
    assert (
        probe.summarize([probe.Check("tool", "skipped", "")])["counts"]["skipped"] == 1
    )


def test_recipe_validation_exits_nonzero_for_blockers(tmp_path, monkeypatch, capsys):
    recipe = module("dynamo-recipe-runner", "recipe_tool")
    (tmp_path / "recipes").mkdir()
    (tmp_path / ".git").mkdir()
    (tmp_path / "recipes" / "deploy.yaml").write_text(
        "kind: DynamoGraphDeployment\nspec:\n  storageClassName: <choose-storage>\n"
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["recipe", "validate", "recipes"])
    assert recipe.main() == 1
    assert json.loads(capsys.readouterr().out)["blockers"]


def record(cancelled=False):
    return {
        "metadata": {
            "benchmark_phase": "profiling",
            "was_cancelled": cancelled,
            "request_start_ns": 0,
            "request_end_ns": 1_000_000_000,
        },
        "metrics": {"request_latency": {"value": 1000, "unit": "ms"}},
    }


def test_throughput_reports_incomplete_cancelled_and_malformed_records(tmp_path):
    metrics = module("dynamo-frontend-benchmark", "extract_throughput")
    path = tmp_path / "profile_export.jsonl"
    path.write_text(
        json.dumps(record()) + "\n" + json.dumps(record(True)) + "\n{broken\n"
    )
    result = metrics.analyze(path, expected_count=3)
    assert not result["records_complete"]
    assert (
        result["counts"]["completed"]
        == result["counts"]["cancelled"]
        == result["counts"]["invalid"]
        == 1
    )
    path.write_text(json.dumps(record()) + "\n")
    assert metrics.analyze(path, 1)["records_complete"]
    assert not metrics.analyze(path, 2)["records_complete"]
    assert metrics.analyze(path, 1)["observed_completed_requests_per_second"] == 1


def test_throughput_rejects_ambiguous_run_directory(tmp_path):
    metrics = module("dynamo-frontend-benchmark", "extract_throughput")
    for arm in ["a", "b"]:
        (tmp_path / arm).mkdir()
        (tmp_path / arm / "profile_export.jsonl").write_text("")
    with pytest.raises(ValueError, match="found 2"):
        metrics.find_jsonl(tmp_path)


def test_cleanup_preserves_unrelated_and_reused_pid(tmp_path):
    control = module("dynamo-frontend-benchmark", "process_control")
    task = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True
    )
    unrelated = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True
    )
    path = tmp_path / "process.json"
    try:
        control.record(path, task.pid)
        saved = json.loads(path.read_text())
        bad = dict(saved, start_ticks=str(int(saved["start_ticks"]) + 1))
        path.write_text(json.dumps(bad))
        with pytest.raises(ValueError, match="stale"):
            control.stop(path, grace=0.1)
        assert task.poll() is None and unrelated.poll() is None
        path.write_text(json.dumps(saved))
        control.stop(path, grace=0.1)
        task.wait(timeout=2)
        assert unrelated.poll() is None
        assert not path.exists()
    finally:
        for proc in [task, unrelated]:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=2)


def test_cleanup_stops_surviving_group_children(tmp_path):
    control = module("dynamo-frontend-benchmark", "process_control")
    child_path = tmp_path / "child.pid"
    code = "import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)']); Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
    task = subprocess.Popen(
        [sys.executable, "-c", code, str(child_path)], start_new_session=True
    )
    try:
        for _ in range(100):
            if child_path.exists():
                break
            time.sleep(0.01)
        child = int(child_path.read_text())
        time.sleep(0.1)
        path = tmp_path / "process.json"
        control.record(path, task.pid)
        control.stop(path, grace=0.1)
        task.wait(timeout=2)
        for _ in range(100):
            current = control.identity(child)
            if current is None or current["state"] == "Z":
                break
            time.sleep(0.01)
        assert current is None or current["state"] == "Z"
    finally:
        try:
            os.killpg(task.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        task.wait(timeout=2)


def test_cpu_restore_preserves_original_properties_and_refuses_later_drift(
    tmp_path, monkeypatch
):
    isolation = module("dynamo-frontend-benchmark", "cpu_isolation")
    units = {"system.slice": "2-7", "init.scope": "", "user.slice": "0-7"}
    before = dict(units)
    monkeypatch.setattr(isolation, "get_cpus", lambda unit: units[unit])
    monkeypatch.setattr(
        isolation, "set_cpus", lambda unit, cpus: units.__setitem__(unit, cpus)
    )
    path = tmp_path / "cpu.json"
    isolation.apply(path, "4-7")
    assert units["user.slice"] == before["user.slice"]
    units["system.slice"] = "5-7"
    with pytest.raises(ValueError, match="changed after"):
        isolation.restore(path)
    assert path.exists() and units["init.scope"] == "4-7"
    units["system.slice"] = "4-7"
    isolation.restore(path)
    assert units == before and not path.exists()


def test_bundle_marks_failed_collection_and_redacts_structured_env(
    tmp_path, monkeypatch, capsys
):
    bundle = module("dynamo-troubleshoot", "collect_dynamo_debug_bundle")
    secret = '{"name": "EXAMPLE_TOKEN", "value": "dummy-sensitive-value"}'
    assert "dummy-sensitive-value" not in bundle.redact(secret)
    monkeypatch.setattr(
        bundle,
        "run",
        lambda cmd, timeout: {
            "cmd": cmd,
            "returncode": 1,
            "stdout": "",
            "stderr": "Forbidden",
        },
    )
    monkeypatch.setattr(
        sys, "argv", ["bundle", "--namespace", "example", "--outdir", str(tmp_path)]
    )
    assert bundle.main() == 1
    assert json.loads(capsys.readouterr().out)["collection_complete"] is False


@pytest.fixture
def harness_env(tmp_path):
    """Fake all external services; keep real local process/lock operations."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    env = dict(
        os.environ,
        DYN_REPO=str(tmp_path),
        LOG_DIR=str(tmp_path / "logs"),
        RESULTS_DIR=str(tmp_path / "results"),
        MODEL="fixture/model",
        NUM_WORKERS="2",
        ISOLATE="0",
        PATH=f'{bindir}:{os.environ["PATH"]}',
    )

    def executable(name, body):
        path = bindir / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o700)
        return str(path)

    executable(
        "ss", 'print("LISTEN 0 128 127.0.0.1:2379\\nLISTEN 0 128 127.0.0.1:4222")\n'
    )
    executable("taskset", "import os,sys\nos.execvp(sys.argv[3], sys.argv[3:])\n")
    executable(
        "etcdctl",
        """import os,sys
from pathlib import Path
record = Path(os.environ['LOG_DIR']) / 'workers.process.json'
if os.environ.get('FAIL_ETCD') == 'always' or (record.exists() and os.environ.get('FAIL_ETCD') == 'after_launch'):
    sys.exit(1)
if record.exists():
    print('worker1\\n\\nworker2')
""",
    )
    executable(
        "curl",
        """import json,os,sys
from pathlib import Path
if any(arg.endswith('/v1/models') for arg in sys.argv):
    print(json.dumps({'data': [{'id': os.environ['MODEL']}]}))
else:
    print(Path(os.environ['SSE_FIXTURE']).read_text())
""",
    )
    env["DYN_PY"] = executable("fake-dynamo", "import time\ntime.sleep(60)\n")
    return env


def harness_run(name, env):
    return subprocess.run(
        ["bash", str(SKILLS / "dynamo-frontend-benchmark" / "scripts" / name)],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )


def test_topology_lifecycle_uses_only_recorded_processes(harness_env):
    control = module("dynamo-frontend-benchmark", "process_control")
    env = harness_env
    try:
        started = harness_run("start.sh", env)
        assert started.returncode == 0, started.stdout + started.stderr
        records = list(Path(env["LOG_DIR"]).glob("*.process.json"))
        assert len(records) == 2
        assert all(control.verified(path)[1] is not None for path in records)
        repeated = harness_run("start.sh", env)
        assert repeated.returncode != 0 and "existing process record" in repeated.stdout
        stopped = harness_run("stop.sh", env)
        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert not list(Path(env["LOG_DIR"]).glob("*.process.json"))
    finally:
        for path in Path(env["LOG_DIR"]).glob("*.process.json"):
            control.stop(path, grace=0.1)


def test_topology_cleans_up_after_discovery_failure(harness_env):
    result = harness_run("start.sh", dict(harness_env, FAIL_ETCD="after_launch"))
    assert result.returncode != 0
    assert "[cleanup]" in result.stdout
    assert not list(Path(harness_env["LOG_DIR"]).glob("*.process.json"))


def test_stop_does_not_treat_discovery_failure_as_zero_workers(harness_env):
    result = harness_run("stop.sh", dict(harness_env, FAIL_ETCD="always"))
    assert result.returncode != 0
    assert "could not query worker registrations" in result.stdout


@pytest.mark.parametrize(
    "fault", [None, "no_done", "no_finish", "no_content", "wrong_model", "error"]
)
def test_smoke_requires_a_completed_stream(harness_env, tmp_path, fault):
    event = {
        "model": harness_env["MODEL"],
        "choices": [{"delta": {"content": "hello"}, "finish_reason": "stop"}],
    }
    if fault == "no_finish":
        event["choices"][0]["finish_reason"] = None
    if fault == "no_content":
        event["choices"][0]["delta"]["content"] = ""
    if fault == "wrong_model":
        event["model"] = "unrequested/model"
    if fault == "error":
        event["error"] = "failed"
    stream = "data: " + json.dumps(event) + "\n\n"
    if fault != "no_done":
        stream += "data: [DONE]\n\n"
    fixture = tmp_path / "stream.sse"
    fixture.write_text(stream)
    result = harness_run("smoke.sh", dict(harness_env, SSE_FIXTURE=str(fixture)))
    assert (result.returncode == 0) == (fault is None), result.stdout + result.stderr


def test_bundle_marks_failed_current_logs_but_allows_absent_previous(
    tmp_path, monkeypatch, capsys
):
    bundle = module("dynamo-troubleshoot", "collect_dynamo_debug_bundle")
    monkeypatch.setattr(bundle, "pod_names", lambda *args: ["pod"])
    monkeypatch.setattr(
        bundle, "container_names", lambda *args: [("container", "worker")]
    )
    fail_current = False

    def run(cmd, timeout):
        failure = "logs" in cmd and (fail_current or "--previous" in cmd)
        return {
            "cmd": cmd,
            "returncode": int(failure),
            "stdout": "",
            "stderr": "unavailable" if failure else "",
        }

    monkeypatch.setattr(bundle, "run", run)
    monkeypatch.setattr(
        sys, "argv", ["bundle", "--namespace", "example", "--outdir", str(tmp_path)]
    )
    assert bundle.main() == 0
    capsys.readouterr()
    fail_current = True
    assert bundle.main() == 1
    assert not json.loads(capsys.readouterr().out)["collection_complete"]
