"""The standalone Redis gate must execute checks under optimized Python too."""

import json
import subprocess
import types
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/test_compose_redis.py"


def fixture_module(optimize=0):
    module = types.ModuleType("compose_redis_fixture")
    module.__file__ = str(SCRIPT)
    exec(
        compile(SCRIPT.read_text(), str(SCRIPT), "exec", optimize=optimize),
        module.__dict__,
    )
    return module


def fake_docker(module, monkeypatch, *, allow_anonymous=False):
    operations, passwords = [], []
    monkeypatch.setattr(module.shutil, "which", lambda _: "/fixture/bin/docker")
    monkeypatch.setattr(module, "cleanup", lambda _: None)

    def run(*argv, **kwargs):
        assert argv[0] == "/fixture/bin/docker"
        if argv[1] == "compose":
            passwords.append(kwargs["env"]["REDIS_PASSWORD"])
            return json.dumps(
                {
                    "services": {
                        "redis": {"entrypoint": ["/fixture-entry"], "command": []}
                    }
                }
            )
        if argv[1] != "run" or argv[argv.index("--entrypoint") + 1] != "redis-cli":
            return "resource"
        operation = argv[argv.index("--user") + 2]
        operations.append(operation)
        if "--env" not in argv:
            return "PONG" if allow_anonymous else "NOAUTH Authentication required"
        return {
            "PING": "PONG",
            "CONFIG": "NOPERM no permission",
            "JSON.SET": "OK",
            "XADD": "123-0",
            "XGROUP": "OK",
            "XREADGROUP": "123-0",
            "JSON.GET": '{"retained":true}',
            "XPENDING": "1\n123-0",
        }[operation]

    monkeypatch.setattr(module, "run", run)
    return operations, passwords


@pytest.mark.parametrize("optimize", [0, 1, 2])
def test_optimized_fixture_keeps_security_operations_and_fresh_passwords(
    monkeypatch, optimize
):
    module = fixture_module(optimize)
    operations, passwords = fake_docker(module, monkeypatch)
    for username in ("default", "daedalus"):
        module.check_user("fixture-image", username)
    assert passwords[0] != passwords[1]
    assert all(" with # ACL characters" in value for value in passwords)
    for operation in (
        "GET",
        "CONFIG",
        "JSON.SET",
        "XGROUP",
        "XREADGROUP",
        "JSON.GET",
        "XPENDING",
    ):
        assert operations.count(operation) == 2


@pytest.mark.parametrize("optimize", [0, 1, 2])
def test_optimized_fixture_rejects_anonymous_access(monkeypatch, optimize, capsys):
    module = fixture_module(optimize)
    fake_docker(module, monkeypatch, allow_anonymous=True)
    with pytest.raises(AssertionError, match="Anonymous GET allowed"):
        module.check_user("fixture-image", "default")
    assert "PASS" not in capsys.readouterr().out


def test_cleanup_attempts_every_resource_then_fails(monkeypatch):
    module = fixture_module()
    commands = [
        ["/fixture/bin/docker", "rm", name] for name in ("server", "volume", "net")
    ]
    seen = []

    def run(argv, **kwargs):
        seen.append(argv)
        assert kwargs["shell"] is False
        assert kwargs["timeout"] == 60
        if argv[-1] == "volume":
            raise subprocess.TimeoutExpired(argv, 60)
        return subprocess.CompletedProcess(argv, 1 if argv[-1] == "server" else 0)

    monkeypatch.setattr(module.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="Fixture cleanup failed"):
        module.cleanup(commands)
    assert seen == commands


def test_partial_setup_failure_remains_primary_when_cleanup_also_fails(monkeypatch):
    module = fixture_module()
    original_cleanup = module.cleanup
    fake_docker(module, monkeypatch)
    monkeypatch.setattr(module, "cleanup", original_cleanup)
    original_run = module.run
    cleaned = []

    def run(*argv, **kwargs):
        if argv[1:3] == ("volume", "create"):
            raise RuntimeError("fixture volume creation failed")
        return original_run(*argv, **kwargs)

    def failed_cleanup(argv, **kwargs):
        cleaned.append(argv)
        return subprocess.CompletedProcess(argv, 1)

    monkeypatch.setattr(module, "run", run)
    monkeypatch.setattr(module.subprocess, "run", failed_cleanup)
    with pytest.raises(RuntimeError, match="fixture volume creation failed") as error:
        module.check_user("fixture-image", "default")
    assert len(cleaned) == 1 and cleaned[0][1:3] == ["network", "rm"]
    assert "Fixture cleanup failed" in error.value.__notes__[0]


def test_fixture_requires_installed_docker(monkeypatch):
    module = fixture_module()
    monkeypatch.setattr(module.shutil, "which", lambda _: None)
    with pytest.raises(
        FileNotFoundError, match="Required executable not found: docker"
    ):
        module.check_user("fixture-image", "default")
