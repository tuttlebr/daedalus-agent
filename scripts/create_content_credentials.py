#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["c2pa-python==0.37.10", "cryptography>=50,<51", "pillow>=12.2,<13"]
# ///
"""Create and verify a private C2PA development certificate bundle.

Usage: uv run scripts/create_content_credentials.py
Creates local files only. --ensure reuses valid credentials or preserves the
old bundle in a backup before replacing it. Never changes a deployment.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import io
import json
import os
import re
import shlex
import shutil
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import c2pa
from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from PIL import Image

REPOSITORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY / "builder" / "nat_helpers" / "src"))
from nat_helpers.content_credentials import (  # noqa: E402
    ContentCredentialsError,
    sign_final_image,
)


def _write_private(path: Path, data: bytes) -> None:
    # Restrict access at creation, including when the caller has a permissive umask.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)


def _private_key_bytes(key) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def _settings(directory: Path, creator: str) -> dict[str, str]:
    return {
        "C2PA_SIGNING_MODE": "local",
        "C2PA_CREATOR_NAME": creator,
        "C2PA_CERTIFICATE_FILE": str(directory / "chain.pem"),
        "C2PA_PRIVATE_KEY_FILE": str(directory / "key.pem"),
        "C2PA_SIGNING_ALGORITHM": "es256",
    }


def _report(certificate, root, creator, secret_name=None) -> dict:
    fingerprint = certificate.fingerprint(hashes.SHA256()).hex()
    return {
        "creator": creator,
        "algorithm": "es256",
        "certificateExpiresAt": certificate.not_valid_after_utc.isoformat(),
        "rootExpiresAt": root.not_valid_after_utc.isoformat(),
        "signerFingerprintSha256": fingerprint,
        "validationState": "Valid",
        "publicTrust": "unrecognized issuer (private development CA)",
        "kubernetesSecret": secret_name or f"daedalus-c2pa-{fingerprint[:12]}",
    }


def _write_configuration(
    directory: Path, report: dict, *, target: Path | None = None
) -> None:
    settings = _settings(target or directory, report["creator"])
    env = "".join(
        f"export {name}={shlex.quote(value)}\n" for name, value in settings.items()
    )
    # JSON quoted scalars are also valid YAML; creator text cannot inject YAML.
    helm = "contentCredentials:\n" + "".join(
        f"  {name}: {json.dumps(value)}\n"
        for name, value in {
            "mode": "local",
            "creatorName": report["creator"],
            "signingAlgorithm": "es256",
            "existingSecret": report["kubernetesSecret"],
            "certificateKey": "chain.pem",
            "privateKeyKey": "key.pem",
        }.items()
    )
    for name, data in {
        "local.env": env.encode(),
        "helm-values.yaml": helm.encode(),
        "verification.json": (json.dumps(report, indent=2) + "\n").encode(),
    }.items():
        path = directory / name
        if path.is_file() and not path.is_symlink() and path.read_bytes() == data:
            continue
        temporary = directory / f".{name}-{uuid.uuid4().hex}"
        try:
            _write_private(temporary, data)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def _certificate(subject, public_key, root_name, root_key, now, days, *, ca):
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(root_name)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=days))
        .add_extension(
            x509.BasicConstraints(ca=ca, path_length=0 if ca else None), True
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=ca,
                crl_sign=ca,
                encipher_only=False,
                decipher_only=False,
            ),
            True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(public_key), False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()),
            False,
        )
    )
    if not ca:
        # C2PA accepts this EKU for a private development signing certificate.
        builder = builder.add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), False
        )
    return builder.sign(root_key, hashes.SHA256())


@contextmanager
def _signing_environment(values):
    previous = {name: os.environ.get(name) for name in values}
    try:
        os.environ.update(values)
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _verify_bundle(settings: dict[str, str], creator: str) -> bytes:
    original = io.BytesIO()
    Image.new("RGBA", (64, 64), (24, 110, 150, 128)).save(original, format="PNG")
    with _signing_environment(settings):
        signed = base64.b64decode(
            sign_final_image(
                base64.b64encode(original.getvalue()).decode(), "image/png"
            )
        )
    with c2pa.Context.from_dict(
        {
            "core": {"allowed_network_hosts": [], "decode_identity_assertions": False},
            "verify": {"remote_manifest_fetch": False, "ocsp_fetch": False},
        }
    ) as context, c2pa.Reader(
        "image/png", io.BytesIO(signed), context=context
    ) as reader:
        if reader.get_validation_state() != "Valid":
            raise ValueError("Development image signature did not validate")
        store = json.loads(reader.json())
        active = store["manifests"][store["active_manifest"]]
        metadata = next(
            a["data"] for a in active["assertions"] if a["label"] == "cawg.metadata"
        )
        if metadata["dc:creator"] != [creator]:
            raise ValueError("Development image creator did not match")
    with Image.open(original) as before, Image.open(io.BytesIO(signed)) as after:
        if (
            before.mode != after.mode
            or before.size != after.size
            or before.tobytes() != after.tobytes()
        ):
            raise ValueError("Signing changed the sample image pixels")
    return signed


def _validate_options(creator: str, days: int, secret_name: str | None) -> str:
    creator = creator.strip()
    if not creator or len(creator) > 64 or not creator.isprintable():
        raise ValueError("Creator must contain 1-64 printable characters")
    if not 1 <= days <= 3650:
        raise ValueError("Certificate lifetime must be between 1 and 3650 days")
    if secret_name is not None and (
        len(secret_name) > 63
        or not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", secret_name)
    ):
        raise ValueError(
            "Secret name must be a lowercase DNS label of at most 63 characters"
        )
    return creator


def _output_path(output_dir: Path) -> Path:
    if output_dir.expanduser().is_symlink():
        raise ValueError("Credential directory must not be a symbolic link")
    output_dir = output_dir.expanduser().resolve()
    if output_dir.is_relative_to(REPOSITORY):
        raise ValueError("Store the credential bundle outside the repository")
    return output_dir


def generate_bundle(
    output_dir: Path,
    *,
    creator: str = "Brandon Tuttle",
    days: int = 365,
    secret_name: str | None = None,
) -> dict:
    """Generate unique ES256 root/signing keys and verify the application path."""
    creator = _validate_options(creator, days, secret_name)
    output_dir = _output_path(output_dir)
    output_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Refuse any existing directory, even if empty, to preserve existing identities.
    output_dir.mkdir(mode=0o700)
    try:
        now = datetime.now(timezone.utc)
        root_key = ec.generate_private_key(ec.SECP256R1())
        signing_key = ec.generate_private_key(ec.SECP256R1())
        root_name = x509.Name(
            [
                x509.NameAttribute(NameOID.COMMON_NAME, "Daedalus development root CA"),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, creator),
            ]
        )
        signer_name = x509.Name(
            [
                x509.NameAttribute(NameOID.COMMON_NAME, "Daedalus image signing"),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, creator),
            ]
        )
        root = _certificate(
            root_name, root_key.public_key(), root_name, root_key, now, 3650, ca=True
        )
        certificate = _certificate(
            signer_name,
            signing_key.public_key(),
            root_name,
            root_key,
            now,
            days,
            ca=False,
        )
        root_pem = root.public_bytes(serialization.Encoding.PEM)
        signer_pem = certificate.public_bytes(serialization.Encoding.PEM)
        for name, data in {
            "root-key.pem": _private_key_bytes(root_key),
            "root-ca.pem": root_pem,
            "certificate.pem": signer_pem,
            "chain.pem": signer_pem + root_pem,
            "key.pem": _private_key_bytes(signing_key),
        }.items():
            _write_private(output_dir / name, data)
        signed = _verify_bundle(_settings(output_dir, creator), creator)
        report = _report(certificate, root, creator, secret_name)
        _write_configuration(output_dir, report)
        _write_private(output_dir / "signed-example.png", signed)
        return report
    except BaseException:
        # This invocation created the directory and owns its unfinished bundle.
        shutil.rmtree(output_dir)
        raise


def validate_bundle(
    directory: Path, creator: str, secret_name: str | None = None
) -> dict:
    """Validate actual certificates and sign anew; never trust a cached report."""
    certificate, root = x509.load_pem_x509_certificates(
        (directory / "chain.pem").read_bytes()
    )
    now = datetime.now(timezone.utc)
    for item in (certificate, root):
        if not item.not_valid_before_utc <= now < item.not_valid_after_utc:
            raise ValueError("Certificate is expired or not yet valid")
    root.verify_directly_issued_by(root)
    certificate.verify_directly_issued_by(root)
    if not root.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
        raise ValueError("Root certificate is not a CA")
    if certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
        raise ValueError("Signing certificate must be a leaf")
    organizations = certificate.subject.get_attributes_for_oid(
        NameOID.ORGANIZATION_NAME
    )
    if len(organizations) != 1 or organizations[0].value != creator:
        raise ValueError("Certificate creator does not match")
    key = serialization.load_pem_private_key(
        (directory / "key.pem").read_bytes(), password=None
    )
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(
        key.curve, ec.SECP256R1
    ):
        raise ValueError("Signing key must use ES256")
    if key.public_key() != certificate.public_key():
        raise ValueError("Signing key does not match certificate")
    # The application SDK verifies the key pair, algorithm, EKU and signed asset.
    _verify_bundle(_settings(directory, creator), creator)
    return _report(certificate, root, creator, secret_name)


def ensure_bundle(
    output_dir: Path,
    *,
    creator: str = "Brandon Tuttle",
    days: int = 365,
    secret_name: str | None = None,
) -> tuple[dict, str]:
    """Reuse a working bundle, or verify a replacement before retiring the old one."""
    creator = _validate_options(creator, days, secret_name)
    output_dir = _output_path(output_dir)
    output_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = output_dir.parent / f".{output_dir.name}.lock"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as handle:
        # Serialize check/rotation across repeated or concurrent deployments.
        fcntl.flock(handle, fcntl.LOCK_EX)
        if output_dir.exists():
            if not output_dir.is_dir() or output_dir.is_symlink():
                raise ValueError("Credential location must be a directory")
            names = {path.name for path in output_dir.iterdir()}
            if names and not names.intersection(
                {"chain.pem", "key.pem", "verification.json"}
            ):
                raise ValueError("Refusing to replace an unrelated nonempty directory")
            try:
                report = validate_bundle(output_dir, creator, secret_name)
            except (
                FileNotFoundError,
                ValueError,
                TypeError,
                InvalidSignature,
                UnsupportedAlgorithm,
                x509.ExtensionNotFound,
                ContentCredentialsError,
            ):
                print(
                    "Existing credentials are missing or invalid; preparing a replacement"
                )
            else:
                # Repair only derived settings if missing/stale; keys are untouched.
                _write_configuration(output_dir, report)
                return report, "Reused"

        pending = output_dir.parent / f".{output_dir.name}.pending-{uuid.uuid4().hex}"
        backup = None
        try:
            report = generate_bundle(
                pending, creator=creator, days=days, secret_name=secret_name
            )
            _write_configuration(pending, report, target=output_dir)
            if output_dir.exists():
                backup = (
                    output_dir.parent / f"{output_dir.name}.backup-{uuid.uuid4().hex}"
                )
                output_dir.rename(backup)
            try:
                pending.rename(output_dir)
            except BaseException:
                if backup is not None:
                    backup.rename(output_dir)
                raise
        finally:
            if pending.exists():
                shutil.rmtree(pending)
        if backup is not None:
            print(f"Previous credential bundle preserved at {backup}")
        return report, "Replaced" if backup else "Created"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.home() / ".config/daedalus/content-credentials",
    )
    parser.add_argument("--creator", default="Brandon Tuttle")
    parser.add_argument(
        "--ensure",
        action="store_true",
        help="Reuse valid credentials; create or replace missing/invalid credentials with a backup",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=365,
        help="Signing certificate lifetime (default: 365 days)",
    )
    parser.add_argument(
        "--secret-name",
        help="Name for the generated Helm values; default includes certificate fingerprint",
    )
    args = parser.parse_args(argv)
    try:
        options = dict(
            creator=args.creator, days=args.days, secret_name=args.secret_name
        )
        if args.ensure:
            report, action = ensure_bundle(args.output_dir, **options)
        else:
            report = generate_bundle(args.output_dir, **options)
            action = "Created"
    except FileExistsError:
        parser.exit(
            1,
            "Refusing to overwrite an existing credential directory. Choose a new --output-dir.\n",
        )
    except (OSError, ValueError, RuntimeError) as exc:
        parser.exit(1, f"Credential generation failed: {exc}\n")
    directory = args.output_dir.expanduser().resolve()
    print(f"{action} and verified credentials in {directory}")
    print(f"Creator: {report['creator']}; expires: {report['certificateExpiresAt']}")
    print(
        "Sample signature: Valid; public issuer: unrecognized (private development CA)"
    )
    print(f"Local settings: {directory / 'local.env'}")
    print(f"Helm settings: {directory / 'helm-values.yaml'}")
    print(f"Kubernetes Secret name: {report['kubernetesSecret']}")
    print(
        "Use only chain.pem and key.pem in the backend Secret. Keep root-key.pem offline."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
