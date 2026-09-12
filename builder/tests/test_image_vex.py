"""An applicability record cannot hide a different image, component or CVE."""

import importlib.util
import json
import subprocess
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "image_vex", ROOT / "scripts/image_vex.py"
)
vex = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vex)
STATEMENTS = json.loads((ROOT / "security/image-vex.json").read_text())["statements"]
STATEMENT = STATEMENTS[0]
FINDING = {
    "PkgName": "google.golang.org/grpc",
    "InstalledVersion": "v1.85.0-dev",
    "VulnerabilityID": "CVE-2026-84445",
}


def test_vex_requires_exact_digest_component_target_and_unexpired_advisory():
    def match(
        image=STATEMENT["x-image"],
        target="usr/bin/weed",
        finding=None,
        today=date(2026, 9, 11),
    ):
        return vex.matching_statement(
            STATEMENTS, image, target, finding or FINDING, today
        )

    assert match() is STATEMENT
    assert match(image=STATEMENT["x-image"] + "0") is None
    assert match(target="other/binary") is None
    assert match(finding=dict(FINDING, VulnerabilityID="CVE-2026-12345")) is None
    assert match(finding=dict(FINDING, InstalledVersion="v1.86.0")) is None
    assert match(finding=dict(FINDING, PkgName="unrelated")) is None
    assert match(today=date(2026, 10, 11)) is None
    assert (
        vex.matching_statement(
            STATEMENTS,
            STATEMENT["x-image"],
            "usr/bin/weed",
            FINDING,
            date(2026, 9, 11),
            architecture="riscv64",
        )
        is None
    )


@pytest.mark.parametrize("architecture,machine", [("amd64", 62), ("arm64", 183)])
def test_native_binary_requires_architecture_positive_and_negative_controls(
    tmp_path, architecture, machine
):
    path = tmp_path / "weed"
    header = b"\x7fELF\x02\x01" + bytes(12) + machine.to_bytes(2, "little")
    controls = (
        b"google.golang.org/grpc.NewServer\0google.golang.org/grpc/internal/transport"
    )
    path.write_bytes(header + controls)
    vex.verify_binary_evidence(path, architecture)
    with pytest.raises(ValueError, match="architecture"):
        vex.verify_binary_evidence(
            path, "arm64" if architecture == "amd64" else "amd64"
        )
    path.write_bytes(header + b"uninspectable")
    with pytest.raises(ValueError, match="positive"):
        vex.verify_binary_evidence(path, architecture)
    for symbol in [
        b"google.golang.org/grpc/xds.NewGRPCServer",
        b"google.golang.org/grpc/xds/internal/server",
    ]:
        path.write_bytes(header + controls + b"\0" + symbol)
        with pytest.raises(ValueError, match="xDS"):
            vex.verify_binary_evidence(path, architecture)


def test_native_evidence_copy_failure_cleans_stopped_container(monkeypatch):
    calls = []
    monkeypatch.setattr(vex.shutil, "which", lambda _: "/fixture/bin/docker")

    def run(argv, **kwargs):
        calls.append(argv)
        assert argv[0] == "/fixture/bin/docker"
        assert kwargs["check"] is True
        assert kwargs["shell"] is False
        if argv[1] == "create":
            assert argv[argv.index("--platform") + 1] == "linux/arm64"
            assert "--network" in argv and "none" in argv
            return subprocess.CompletedProcess(argv, 0, stdout="fixture-container\n")
        if argv[1] == "cp":
            raise subprocess.CalledProcessError(1, argv)
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(vex.subprocess, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        vex.verify_native_evidence(STATEMENT["x-image"], "arm64")
    assert calls[-1] == ["/fixture/bin/docker", "rm", "fixture-container"]
    assert not any("run" in call or "start" in call for call in calls)


def test_native_evidence_requires_installed_docker(monkeypatch):
    monkeypatch.setattr(vex.shutil, "which", lambda _: None)
    with pytest.raises(
        FileNotFoundError, match="Required executable not found: docker"
    ):
        vex.verify_native_evidence(STATEMENT["x-image"])


def test_arm64_record_is_independent_and_unknown_architecture_rejected():
    arm = vex.matching_statement(
        STATEMENTS,
        STATEMENT["x-image"],
        "usr/bin/weed",
        FINDING,
        date(2026, 9, 11),
        architecture="arm64",
    )
    assert arm is not None and arm is not STATEMENT
    assert arm["x-architecture"] == "arm64"
    with pytest.raises(ValueError, match="Unsupported"):
        vex.verify_native_evidence(arm["x-image"], "riscv64")
