"""Exercise the certificate CLI and its private, usable output bundle."""

import io
import json
import os
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import c2pa
import pytest
import yaml
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

SCRIPT = Path(__file__).parents[2] / "scripts" / "create_content_credentials.py"


def run_script(directory, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--output-dir", str(directory), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_generates_private_valid_bundle_and_refuses_overwrite(tmp_path):
    bundle = tmp_path / "credentials"
    result = run_script(bundle)
    assert result.returncode == 0, result.stderr
    assert "PRIVATE KEY" not in result.stdout + result.stderr
    assert stat.S_IMODE(bundle.stat().st_mode) == 0o700
    files = {path.name: path.read_bytes() for path in bundle.iterdir()}
    assert len(files) == 9
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in bundle.iterdir())
    chain = x509.load_pem_x509_certificates(files["chain.pem"])
    leaf, root = chain
    root.verify_directly_issued_by(root)
    leaf.verify_directly_issued_by(root)
    assert leaf.subject != root.subject
    assert root.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    assert not leaf.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    assert (
        ExtendedKeyUsageOID.EMAIL_PROTECTION
        in leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    )
    key = serialization.load_pem_private_key(files["key.pem"], password=None)
    assert key.public_key() == leaf.public_key()
    report = json.loads(files["verification.json"])
    assert report["creator"] == "Brandon Tuttle"
    assert report["validationState"] == "Valid"
    with c2pa.Reader("image/png", io.BytesIO(files["signed-example.png"])) as reader:
        assert reader.get_validation_state() == "Valid"
    helm = yaml.safe_load(files["helm-values.yaml"])["contentCredentials"]
    assert helm["mode"] == "local"
    assert helm["existingSecret"] == report["kubernetesSecret"]
    assert helm["privateKeyKey"] == "key.pem"
    assert "root-key" not in files["local.env"].decode()
    # The generated environment file is executable shell configuration, even
    # when its containing directory has spaces. Only fixed env names are read.
    loaded = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; printf "%s\\n" "$C2PA_SIGNING_MODE" "$C2PA_CERTIFICATE_FILE" "$C2PA_CREATOR_NAME"',
            "--",
            str(bundle / "local.env"),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert loaded.stdout.splitlines() == [
        "local",
        str(bundle / "chain.pem"),
        "Brandon Tuttle",
    ]
    again = run_script(bundle)
    assert again.returncode != 0
    assert "Refusing to overwrite" in again.stderr
    assert files == {path.name: path.read_bytes() for path in bundle.iterdir()}


def test_custom_creator_and_paths_are_quoted_without_execution(tmp_path):
    bundle = tmp_path / "path with spaces"
    # Keep the O attribute within the X.509 length limit while exercising shell syntax.
    creator = "Dev `echo unsafe` $(echo unsafe) 'quote'"
    result = run_script(
        bundle,
        "--creator",
        creator,
        "--days",
        "7",
        "--secret-name",
        "private-image-signing",
    )
    assert result.returncode == 0, result.stderr
    env = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; printf "%s" "$C2PA_CREATOR_NAME"',
            "--",
            str(bundle / "local.env"),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert env.stdout == creator
    leaf = x509.load_pem_x509_certificate((bundle / "certificate.pem").read_bytes())
    assert (
        leaf.subject.get_attributes_for_oid(NameOID.ORGANIZATION_NAME)[0].value
        == creator
    )
    assert (
        yaml.safe_load((bundle / "helm-values.yaml").read_text())["contentCredentials"][
            "creatorName"
        ]
        == creator
    )


@pytest.mark.parametrize(
    "args",
    [
        ["--days", "0"],
        ["--days", "3651"],
        ["--creator", ""],
        ["--secret-name", "invalid/name"],
    ],
)
def test_invalid_arguments_do_not_create_credentials(tmp_path, args):
    bundle = tmp_path / "invalid"
    assert run_script(bundle, *args).returncode != 0
    assert not bundle.exists()


def test_failed_verification_removes_incomplete_bundle_and_restores_environment(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(SCRIPT.parent))
    import create_content_credentials as script

    monkeypatch.setenv("C2PA_SIGNING_MODE", "off")

    def fail(*args):
        raise RuntimeError("fixture verification failure")

    monkeypatch.setattr(script, "sign_final_image", fail)
    bundle = tmp_path / "failed"
    with pytest.raises(RuntimeError, match="fixture verification failure"):
        script.generate_bundle(bundle)
    assert not bundle.exists()
    assert os.environ["C2PA_SIGNING_MODE"] == "off"


@pytest.fixture
def generator(monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPT.parent))
    import create_content_credentials

    return create_content_credentials


def test_ensure_reuses_valid_credentials_without_rewriting_them(tmp_path, generator):
    bundle = tmp_path / "credentials"
    initial, action = generator.ensure_bundle(bundle)
    assert action == "Created"
    # The root key can be moved offline without causing a new identity.
    (bundle / "root-key.pem").unlink()
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in bundle.iterdir()}
    result = run_script(bundle, "--ensure")
    assert result.returncode == 0, result.stderr
    assert "Reused and verified" in result.stdout
    assert before == {
        p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in bundle.iterdir()
    }
    assert initial == json.loads((bundle / "verification.json").read_text())
    assert not list(tmp_path.glob("credentials.backup-*"))


@pytest.mark.parametrize(
    "broken",
    [
        "expired_leaf",
        "expired_root",
        "future_leaf",
        "missing_key",
        "wrong_key",
        "broken_chain",
    ],
)
def test_ensure_replaces_invalid_bundle_and_preserves_backup(
    tmp_path, generator, broken
):
    bundle = tmp_path / "credentials"
    first = generator.generate_bundle(bundle)
    if broken == "missing_key":
        (bundle / "key.pem").unlink()
    elif broken == "wrong_key":
        (bundle / "key.pem").write_bytes(
            generator._private_key_bytes(ec.generate_private_key(ec.SECP256R1()))
        )
    elif broken == "broken_chain":
        (bundle / "chain.pem").write_bytes(b"not a certificate")
    else:
        leaf, root = x509.load_pem_x509_certificates(
            (bundle / "chain.pem").read_bytes()
        )
        root_key = serialization.load_pem_private_key(
            (bundle / "root-key.pem").read_bytes(), password=None
        )
        instant = datetime.now(timezone.utc) + timedelta(
            days=1 if broken == "future_leaf" else -2
        )
        if broken == "expired_root":
            root = generator._certificate(
                root.subject,
                root.public_key(),
                root.subject,
                root_key,
                instant,
                1,
                ca=True,
            )
        else:
            leaf = generator._certificate(
                leaf.subject,
                leaf.public_key(),
                root.subject,
                root_key,
                instant,
                1,
                ca=False,
            )
        (bundle / "chain.pem").write_bytes(
            leaf.public_bytes(serialization.Encoding.PEM)
            + root.public_bytes(serialization.Encoding.PEM)
        )
    before = {p.name: p.read_bytes() for p in bundle.iterdir()}
    report, action = generator.ensure_bundle(bundle)
    assert action == "Replaced"
    assert report["kubernetesSecret"] != first["kubernetesSecret"]
    assert report == generator.validate_bundle(bundle, "Brandon Tuttle")
    backups = list(tmp_path.glob("credentials.backup-*"))
    assert len(backups) == 1
    assert before == {p.name: p.read_bytes() for p in backups[0].iterdir()}
    assert ".pending-" not in (bundle / "local.env").read_text()
    assert str(bundle / "chain.pem") in (bundle / "local.env").read_text()
    assert not list(tmp_path.glob("*.pending-*"))


def test_ensure_repairs_derived_settings_without_rotating_key(tmp_path, generator):
    bundle = tmp_path / "credentials"
    generator.generate_bundle(bundle)
    key = (bundle / "key.pem").read_bytes()
    (bundle / "helm-values.yaml").write_text("contentCredentials: {mode: off}\n")
    (bundle / "verification.json").write_text("invalid cached report")
    (bundle / "local.env").unlink()
    report, action = generator.ensure_bundle(bundle)
    assert action == "Reused"
    assert (bundle / "key.pem").read_bytes() == key
    assert (
        yaml.safe_load((bundle / "helm-values.yaml").read_text())["contentCredentials"][
            "mode"
        ]
        == "local"
    )
    assert json.loads((bundle / "verification.json").read_text()) == report


@pytest.mark.parametrize("failure", ["generation", "promotion"])
def test_failed_replacement_preserves_existing_bundle(
    tmp_path, generator, monkeypatch, failure
):
    bundle = tmp_path / "credentials"
    generator.generate_bundle(bundle)
    (bundle / "key.pem").write_bytes(b"invalid key")
    before = {p.name: p.read_bytes() for p in bundle.iterdir()}
    if failure == "generation":

        def fail(*args, **kwargs):
            raise RuntimeError("fixture replacement failed")

        monkeypatch.setattr(generator, "generate_bundle", fail)
    else:
        original_rename = Path.rename

        def rename(path, target):
            if ".pending-" in path.name:
                raise RuntimeError("fixture replacement failed")
            return original_rename(path, target)

        monkeypatch.setattr(Path, "rename", rename)
    with pytest.raises(RuntimeError, match="fixture replacement failed"):
        generator.ensure_bundle(bundle)
    assert before == {p.name: p.read_bytes() for p in bundle.iterdir()}
    assert not list(tmp_path.glob("credentials.backup-*"))
    assert not list(tmp_path.glob("*.pending-*"))


def test_ensure_refuses_unrelated_directory(tmp_path, generator):
    bundle = tmp_path / "unrelated"
    bundle.mkdir()
    (bundle / "keep.txt").write_text("keep")
    with pytest.raises(ValueError, match="unrelated nonempty directory"):
        generator.ensure_bundle(bundle)
    assert (bundle / "keep.txt").read_text() == "keep"


def test_concurrent_ensure_creates_only_one_identity(tmp_path):
    bundle = tmp_path / "concurrent"
    command = [sys.executable, str(SCRIPT), "--ensure", "--output-dir", str(bundle)]
    processes = [
        subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        for _ in range(2)
    ]
    outputs = [process.communicate(timeout=30) for process in processes]
    assert all(process.returncode == 0 for process in processes), outputs
    assert sum("Created and verified" in stdout for stdout, _ in outputs) == 1
    assert sum("Reused and verified" in stdout for stdout, _ in outputs) == 1
    assert not list(tmp_path.glob("concurrent.backup-*"))
