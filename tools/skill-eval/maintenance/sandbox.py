"""Run candidate code offline; the host owns exit status and expected results."""

import json
import subprocess  # nosec B404
import tempfile
import uuid
from pathlib import Path

from common import HERE, relative

EXECUTOR = """import json, subprocess, sys
request = json.load(sys.stdin)
result = subprocess.run(request['argv'], input=request['stdin'], text=True,
    capture_output=True, timeout=15, check=False)
print(json.dumps({'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}))
"""


def runtime():
    """Return the local image ID to run and the identity to record.

    `docker image inspect` reports a store-specific `.Id`: the containerd image
    store returns the pulled index digest, the classic store the platform's
    config digest. The pinned digest names the same content in both, so
    measurements record it while containers run by the local ID.
    """
    image = json.loads((HERE.parent / "runtime.json").read_text())["image"]
    local = subprocess.run(
        ["docker", "image", "inspect", image, "--format", "{{.Id}}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()  # nosec B603 B607
    _, separator, pinned = image.rpartition("@")
    return local, pinned if separator and pinned.startswith("sha256:") else local


def image_identity():
    return runtime()[1]


def command(image, work, name):
    return [
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=256m",
        "--cpus=1",
        "--user=65534:65534",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--env=PYTHONDONTWRITEBYTECODE=1",
        "--mount",
        f"type=bind,source={work},target=/work,readonly",
        "--workdir=/work",
        "--name",
        name,
        "-i",
        image,
    ]


def execute(files, argv, image, stdin=""):
    with tempfile.TemporaryDirectory(prefix="maintenance-task-") as temporary:
        work = Path(temporary)
        work.chmod(0o755)
        for name, content in files.items():
            target = work / relative(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
            target.chmod(0o444)
        name = "maintenance-task-" + uuid.uuid4().hex
        try:
            result = subprocess.run(
                command(image, work, name) + ["python3", "-I", "-c", EXECUTOR],
                input=json.dumps({"argv": argv, "stdin": stdin}),
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )  # nosec B603
            if result.returncode != 0 or result.stderr:
                raise RuntimeError("Container execution failed; measurement not run")
            if len(result.stdout) + len(result.stderr) > 100_000:
                raise ValueError("Task output exceeds evidence budget")
            envelope = json.loads(result.stdout)
            if (
                set(envelope) != {"exit_code", "stdout", "stderr"}
                or type(envelope["exit_code"]) is not int
                or any(
                    not isinstance(envelope[key], str) for key in ["stdout", "stderr"]
                )
            ):
                raise RuntimeError("Invalid trusted executor status channel")
            return envelope
        finally:
            subprocess.run(
                ["docker", "rm", "-f", name],
                capture_output=True,
                timeout=10,
                check=False,
            )  # nosec B603 B607


def probe(files, value, image):
    # Expected outputs and verifier code never enter the candidate workspace.
    code = "import json,sys; from component import handle; print(json.dumps(handle(json.load(sys.stdin))))"
    result = execute(files, ["python3", "-c", code], image, json.dumps(value))
    try:
        output = json.loads(result["stdout"])
    except ValueError:
        output = None
    return result["exit_code"], output
