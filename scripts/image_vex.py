"""Fail-closed, image-specific applicability evidence for the runtime gate."""

import mmap
import shutil

# inspect stopped Docker containers with shell-free argv
import subprocess  # nosec B404
import tempfile
from datetime import date
from pathlib import Path


def matching_statement(
    statements, image, target, finding, today=None, architecture="amd64"
):
    today = today or date.today()
    for statement in statements:
        if (
            statement.get("status") == "not_affected"
            and statement.get("x-architecture") == architecture
            and statement.get("justification") == "vulnerable_code_not_present"
            and statement.get("x-image") == image
            and statement.get("x-target") == target
            and statement.get("x-package") == finding.get("PkgName")
            and statement.get("x-version") == finding.get("InstalledVersion")
            and statement.get("vulnerability", {}).get("name")
            == finding.get("VulnerabilityID")
            and today < date.fromisoformat(statement["x-expires"])
        ):
            return statement
    return None


def verify_binary_evidence(path, architecture):
    expected_machine = {"amd64": 62, "arm64": 183}.get(architecture)
    if expected_machine is None:
        raise ValueError(f"Unsupported native evidence architecture: {architecture}")
    # Go retains fully qualified function names in its runtime pclntab even
    # for stripped executables. Positive constructor and transport controls
    # must exist; an uninspectable or unexpected executable fails closed.
    with Path(path).open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as binary:
            if (
                binary[:6] != b"\x7fELF\x02\x01"
                or int.from_bytes(binary[18:20], "little") != expected_machine
            ):
                raise ValueError("Native evidence ELF architecture mismatch")
            required = (
                b"google.golang.org/grpc.NewServer",
                b"google.golang.org/grpc/internal/transport",
            )
            absent = (
                b"google.golang.org/grpc/xds.NewGRPCServer",
                b"google.golang.org/grpc/xds/internal/server",
            )
            if any(binary.find(symbol) < 0 for symbol in required):
                raise ValueError("Native evidence is missing positive gRPC controls")
            if any(binary.find(symbol) >= 0 for symbol in absent):
                raise ValueError("Affected xDS server code is linked in the executable")


def verify_native_evidence(image, architecture="amd64"):
    if architecture not in {"amd64", "arm64"}:
        raise ValueError(f"Unsupported native evidence architecture: {architecture}")
    docker = shutil.which("docker")
    if docker is None:
        raise FileNotFoundError("Required executable not found: docker")
    docker = str(Path(docker).resolve())
    # Inspect the exact platform binary without executing image code or
    # depending on host binfmt emulation. The container is never started.
    # resolved Docker; validated image/platform, no shell
    created = subprocess.run(  # nosec B603
        [
            docker,
            "create",
            "--platform",
            f"linux/{architecture}",
            "--network",
            "none",
            "--entrypoint",
            "/bin/true",
            image,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
        shell=False,
    )
    container = created.stdout.strip()
    try:
        with tempfile.TemporaryDirectory(prefix="daedalus-native-evidence-") as temp:
            binary = Path(temp) / "weed"
            # Docker-returned ID, fixed source and private destination
            subprocess.run(  # nosec B603
                [docker, "cp", f"{container}:/usr/bin/weed", str(binary)],
                check=True,
                timeout=60,
                shell=False,
            )
            verify_binary_evidence(binary, architecture)
    finally:
        # remove only the stopped container just created
        subprocess.run(  # nosec B603
            [docker, "rm", container], check=True, timeout=60, shell=False
        )
