"""Run the real deployment script with isolated credentials and external CLI fakes."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPOSITORY = Path(__file__).parents[2]

# No fake can contact a registry or cluster. Only Helm's local template renderer
# and the real certificate generator run through to their implementations.
FAKE_TOOL = r"""
import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
def record(value):
    with open(os.environ["DEPLOY_TEST_LOG"], "a") as output:
        output.write(json.dumps(value) + "\n")
record({"tool": tool, "args": args})
if tool == "uv":
    if os.environ.get("DEPLOY_TEST_FAIL") == "credentials":
        raise SystemExit(9)
    raise SystemExit(subprocess.call([sys.executable, *args[1:]]))
if tool == "docker":
    if "config" in args:
        print(json.dumps({"services": {service: {"image": "example/" + service + ":test"} for service in ("backend", "frontend", "redis")}}))
    elif "imagetools" in args:
        print("sha256:" + "a" * 64)
elif tool == "helm":
    if args[0] == "template":
        raise SystemExit(subprocess.call([os.environ["DEPLOY_TEST_HELM"], *args]))
    if args[0] == "status":
        print('{"version": 1}')
elif tool == "kubectl":
    if "apply" in args:
        payload = json.load(sys.stdin)
        if payload["kind"] == "Secret":
            if os.environ.get("DEPLOY_TEST_FAIL") == "secret":
                raise SystemExit(8)
            record({"tool": "installed-secret", "name": payload["metadata"]["name"], "namespace": payload["metadata"]["namespace"], "keys": {key: hashlib.sha256(base64.b64decode(value)).hexdigest() for key, value in payload["data"].items()}})
    elif "create" in args and "secret" in args:
        data = {}
        for arg in args:
            if arg.startswith("--from-file="):
                key, path = arg[len("--from-file="):].split("=", 1)
                data[key] = base64.b64encode(Path(path).read_bytes()).decode()
        print(json.dumps({"kind": "Secret", "metadata": {"name": args[args.index("generic") + 1], "namespace": args[args.index("-n") + 1]}, "data": data}))
    elif "create" in args and "namespace" in args:
        print('{"kind": "Namespace"}')
"""


@pytest.fixture
def deploy_fixture(tmp_path):
    helm = shutil.which("helm")
    if not helm:
        pytest.skip("helm not installed")
    commands = tmp_path / "bin"
    commands.mkdir()
    for tool in ("uv", "docker", "helm", "kubectl", "trivy"):
        path = commands / tool
        path.write_text(f"#!{sys.executable}\n" + FAKE_TOOL)
        path.chmod(0o700)
    values = tmp_path / "deployment values.yaml"
    values.write_text(
        "documentObjectStorage: {enabled: false}\ncontentCredentials: {mode: off}\n"
    )
    log = tmp_path / "commands.jsonl"
    bundle = tmp_path / "image credentials"
    env = dict(os.environ)
    env.update(
        PATH=f"{commands}:{env['PATH']}",
        DEPLOY_TEST_LOG=str(log),
        DEPLOY_TEST_HELM=helm,
        CONTENT_CREDENTIALS_DIR=str(bundle),
        RELEASE_EVIDENCE_FILE=str(tmp_path / "release.json"),
    )
    command = [
        "bash",
        str(REPOSITORY / "deploy.sh"),
        "--allow-dirty-source",
        "--allow-unsigned-images",
        "--skip-tls",
        "--skip-mcp-preflight",
        "--skip-rag-preflight",
        "--skip-rag-secret-sync",
        "--skip-document-storage-preflight",
        "--namespace",
        "unit-test-images",
        "--release",
        "test-images",
        "--env-file",
        str(tmp_path / "missing.env"),
        "--values",
        str(values),
    ]

    def run(*extra, fail=""):
        log.write_text("")
        result = subprocess.run(
            command + list(extra),
            env={**env, "DEPLOY_TEST_FAIL": fail},
            text=True,
            capture_output=True,
            timeout=30,
        )
        records = [json.loads(line) for line in log.read_text().splitlines()]
        assert "PRIVATE KEY" not in result.stdout + result.stderr
        return result, records

    return run, bundle, values


def test_deploy_installs_only_signing_material_reuses_then_rotates(deploy_fixture):
    run, bundle, values = deploy_fixture
    first_key = None
    first_secret = None
    for iteration in range(3):
        if iteration == 2:
            (bundle / "key.pem").write_bytes(b"broken key")
        result, records = run()
        assert result.returncode == 0, result.stdout + result.stderr
        installed = next(item for item in records if item["tool"] == "installed-secret")
        assert installed["namespace"] == "unit-test-images"
        assert installed["keys"] == {
            name: hashlib.sha256((bundle / name).read_bytes()).hexdigest()
            for name in ("chain.pem", "key.pem")
        }
        report = json.loads((bundle / "verification.json").read_text())
        assert installed["name"] == report["kubernetesSecret"]
        upgrade = next(
            item
            for item in records
            if item["tool"] == "helm" and item["args"][0] == "upgrade"
        )
        assert records.index(installed) < records.index(upgrade)
        assert upgrade["args"].index(str(values)) < upgrade["args"].index(
            str(bundle / "helm-values.yaml")
        )
        templates = [
            item
            for item in records
            if item["tool"] == "helm" and item["args"][0] == "template"
        ]
        assert templates and all(
            str(bundle / "helm-values.yaml") in item["args"] for item in templates
        )
        if iteration == 0:
            first_key = (bundle / "key.pem").read_bytes()
            first_secret = installed["name"]
        elif iteration == 1:
            assert "Reused and verified" in result.stdout
            assert (bundle / "key.pem").read_bytes() == first_key
            assert installed["name"] == first_secret
        else:
            assert "Replaced and verified" in result.stdout
            assert (bundle / "key.pem").read_bytes() != first_key
            assert installed["name"] != first_secret


def test_deploy_dry_run_does_not_generate_or_install_credentials(deploy_fixture):
    run, bundle, _ = deploy_fixture
    result, records = run("--dry-run")
    assert result.returncode == 0, result.stdout + result.stderr
    assert not bundle.exists()
    assert {item["tool"] for item in records} == {"helm"}
    assert "contentCredentials.mode=local" in result.stdout
    assert "daedalus-c2pa-dry-run" in result.stdout


@pytest.mark.parametrize("failure", ["credentials", "secret"])
def test_failed_credential_preparation_or_install_stops_deployment(
    deploy_fixture, failure
):
    run, _, _ = deploy_fixture
    result, records = run(fail=failure)
    assert result.returncode != 0
    assert not any(
        item["tool"] == "helm" and item["args"][0] == "upgrade" for item in records
    )
    if failure == "credentials":
        assert {item["tool"] for item in records} == {"uv"}
