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
        print(json.dumps({"services": {service: {"image": "example/" + service + ":test"} for service in ("backend", "frontend", "redis", "nginx-helm")}}))
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
            elif arg.startswith("--from-env-file="):
                for line in Path(arg.split("=", 1)[1]).read_text().splitlines():
                    key, value = line.split("=", 1)
                    data[key] = base64.b64encode(value.encode()).decode()
        print(json.dumps({"kind": "Secret", "metadata": {"name": args[args.index("generic") + 1], "namespace": args[args.index("-n") + 1]}, "data": data}))
    elif "create" in args and "namespace" in args:
        print('{"kind": "Namespace"}')
"""


pytestmark = pytest.mark.requires_helm


@pytest.fixture
def deploy_fixture(tmp_path):
    helm = shutil.which("helm")
    assert helm, "the requires_helm gate must run before this fixture"
    commands = tmp_path / "bin"
    commands.mkdir()
    for tool in ("uv", "docker", "helm", "kubectl", "trivy", "cosign", "gh"):
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

    def run(*extra, fail="", omit=(), extra_env=None):
        log.write_text("")
        result = subprocess.run(
            [arg for arg in command if arg not in omit] + list(extra),
            env={**env, "DEPLOY_TEST_FAIL": fail, **(extra_env or {})},
            text=True,
            capture_output=True,
            timeout=30,
        )
        records = [json.loads(line) for line in log.read_text().splitlines()]
        assert "PRIVATE KEY" not in result.stdout + result.stderr
        return result, records

    return run, bundle, values


@pytest.mark.parametrize("padding", ["", " \t"])
def test_deploy_passes_hue_token_only_to_backend(deploy_fixture, tmp_path, padding):
    run, _, _ = deploy_fixture
    env_file = tmp_path / "hue.env"
    token = "unit-test-hue-credential"
    password_hash = "$2b$12$" + "a" * 53
    env_file.write_text(
        f"DAEDALUS_MEMORY_MODE={padding}'disabled'{padding}\n"
        f"HUE_MCP_TOKEN={padding}'{token}'{padding}\n"
        f"AUTH_USERNAME={padding}test-user{padding}\n"
        f"AUTH_PASSWORD_HASH={padding}'{password_hash}'{padding}\n"
        f"DOCUMENT_OBJECT_ACCESS_KEY={padding}'test-access'{padding}\n"
        f"DOCUMENT_OBJECT_SECRET_KEY={padding}'test-secret'{padding}\n"
    )
    result, records = run("--env-file", str(env_file))
    assert result.returncode == 0, result.stdout + result.stderr
    secrets = {
        item["name"]: item["keys"]
        for item in records
        if item["tool"] == "installed-secret"
    }
    assert (
        secrets["test-images-backend-env"]["HUE_MCP_TOKEN"]
        == hashlib.sha256(token.encode()).hexdigest()
    )
    assert all(
        "HUE_MCP_TOKEN" not in keys
        for name, keys in secrets.items()
        if name != "test-images-backend-env"
    )
    assert (
        secrets["test-images-frontend-env"]["AUTH_PASSWORD_HASH"]
        == hashlib.sha256(password_hash.encode()).hexdigest()
    )
    assert (
        secrets["test-images-frontend-env"]["AUTH_USERNAME"]
        == hashlib.sha256(b"test-user").hexdigest()
    )
    assert secrets["test-images-document-objects"] == {
        "DOCUMENT_OBJECT_ACCESS_KEY": hashlib.sha256(b"test-access").hexdigest(),
        "DOCUMENT_OBJECT_SECRET_KEY": hashlib.sha256(b"test-secret").hexdigest(),
    }
    assert token not in result.stdout + result.stderr + json.dumps(records)


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


RELEASE_IMAGES = {
    "backend": "backend",
    "frontend": "frontend",
    "redis": "redis",
    "nginx-helm": "nginx",
}


def _helm_upgrade(records):
    return next(
        item
        for item in records
        if item["tool"] == "helm" and item["args"][0] == "upgrade"
    )


def test_local_build_publishes_scans_and_deploys_every_release_image(
    deploy_fixture, tmp_path
):
    run, _, _ = deploy_fixture
    result, records = run()
    assert result.returncode == 0, result.stdout + result.stderr
    docker = [item["args"] for item in records if item["tool"] == "docker"]
    for verb in ("build", "push"):
        command = next(args for args in docker if verb in args)
        assert command[:3] == ["compose", "--profile", "release"]
        assert command[-4:] == list(RELEASE_IMAGES)
    digest = "sha256:" + "a" * 64
    scanned = [item["args"][-1] for item in records if item["tool"] == "trivy"]
    assert scanned == [f"example/{name}@{digest}" for name in RELEASE_IMAGES]
    upgrade = _helm_upgrade(records)["args"]
    for name, key in RELEASE_IMAGES.items():
        assert f"images.{key}.repository=example/{name}" in upgrade
        assert f"images.{key}.digest={digest}" in upgrade
    evidence = json.loads((tmp_path / "release.json").read_text())
    assert evidence["images"] == {
        name: f"example/{name}@{digest}" for name in RELEASE_IMAGES
    }


def _release_metadata(tmp_path, images):
    commit = subprocess.check_output(
        ["git", "-C", str(REPOSITORY), "rev-parse", "HEAD"], text=True
    ).strip()
    roles = list(images)
    metadata = {
        "schemaVersion": 1,
        "commit": commit,
        "source": {"repository": "owner/daedalus", "ref": "refs/heads/main"},
        "ci": {
            "headSha": commit,
            "event": "push",
            "branch": "main",
            "conclusion": "success",
        },
        "images": images,
        "security": {"scans": dict.fromkeys(roles, "passed")},
        "signatures": dict.fromkeys(roles, "signed"),
        "attestations": dict.fromkeys(roles, "published"),
    }
    path = tmp_path / "release-metadata.json"
    path.write_text(json.dumps(metadata))
    (tmp_path / "release-metadata.json.sig").write_text("fixture signature")
    return path


def _prebuilt(run, metadata):
    return run(
        "--skip-build",
        "--release-metadata",
        str(metadata),
        omit=("--allow-unsigned-images",),
        extra_env={
            "RELEASE_METADATA_PUBLIC_KEY": "fixture.pub",
            "COSIGN_PUBLIC_KEY": "fixture.pub",
        },
    )


def test_prebuilt_release_deploys_the_signed_helm_nginx_image(deploy_fixture, tmp_path):
    run, _, _ = deploy_fixture
    digest = "sha256:" + "a" * 64
    images = {name: f"ghcr.io/owner/daedalus@{digest}" for name in RELEASE_IMAGES}
    result, records = _prebuilt(run, _release_metadata(tmp_path, images))
    assert result.returncode == 0, result.stdout + result.stderr
    assert not any(
        "build" in item["args"] or "push" in item["args"]
        for item in records
        if item["tool"] == "docker"
    )
    verified = [
        item["args"][-1]
        for item in records
        if item["tool"] == "cosign" and item["args"][0] == "verify"
    ]
    assert verified == list(images.values())
    attested = [item["args"][2] for item in records if item["tool"] == "gh"]
    assert attested == ["oci://" + ref for ref in images.values()]
    upgrade = _helm_upgrade(records)["args"]
    assert "images.nginx.repository=ghcr.io/owner/daedalus" in upgrade
    assert f"images.nginx.digest={digest}" in upgrade


def test_prebuilt_release_without_helm_nginx_fails_before_deploying(
    deploy_fixture, tmp_path
):
    run, _, _ = deploy_fixture
    digest = "sha256:" + "a" * 64
    images = {
        name: f"ghcr.io/owner/daedalus@{digest}"
        for name in ("backend", "frontend", "redis")
    }
    result, records = _prebuilt(run, _release_metadata(tmp_path, images))
    assert result.returncode != 0
    assert "release metadata lacks the nginx-helm image" in result.stderr
    assert "Rerun the release workflow for this commit" in result.stderr
    assert not any(item["tool"] in {"kubectl", "gh"} for item in records)
    assert not any(
        item["tool"] == "helm" and item["args"][0] == "upgrade" for item in records
    )
