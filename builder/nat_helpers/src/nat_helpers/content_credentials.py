"""Embed C2PA Content Credentials in final model outputs before publication.

Only an explicit allowlist of public metadata enters the manifest. Request
prompts, account identifiers, input images, and ImageContext never enter it.
Signing uses a locally generated development certificate chain and private key.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"
_ALGORITHMS = {"es256", "es384", "es512", "ps256", "ps384", "ps512"}


class ContentCredentialsError(RuntimeError):
    """Safe to expose to the caller; never contains signing material."""


@dataclass(frozen=True)
class SigningConfig:
    mode: str
    certificate: str = ""
    private_key: str = ""
    algorithm: str = "es256"
    creator: str = "Brandon Tuttle"

    @classmethod
    def from_env(cls) -> SigningConfig:
        mode = os.getenv("C2PA_SIGNING_MODE", "off").strip().lower()
        if mode == "off":
            return cls(mode=mode)
        if mode != "local":
            raise ContentCredentialsError("Invalid C2PA_SIGNING_MODE configuration.")
        config = cls(
            mode=mode,
            certificate=os.getenv("C2PA_CERTIFICATE_FILE", "").strip(),
            private_key=os.getenv("C2PA_PRIVATE_KEY_FILE", "").strip(),
            algorithm=os.getenv("C2PA_SIGNING_ALGORITHM", "es256").strip().lower(),
            creator=os.getenv("C2PA_CREATOR_NAME", "Brandon Tuttle").strip(),
        )
        if config.algorithm not in _ALGORITHMS or not config.creator:
            raise ContentCredentialsError("Invalid C2PA signing algorithm or creator.")
        required = [config.certificate, config.private_key]
        if not all(path and Path(path).is_file() for path in required):
            raise ContentCredentialsError("C2PA signing credential files are missing.")
        return config


def check_signing_configuration() -> None:
    """Reject missing configuration before paying for an image request."""
    SigningConfig.from_env()


@contextmanager
def _signer(config: SigningConfig):
    import c2pa

    with c2pa.Signer.from_info(
        c2pa.C2paSignerInfo(
            alg=getattr(c2pa.C2paSigningAlg, config.algorithm.upper()),
            sign_cert=Path(config.certificate).read_bytes(),
            private_key=Path(config.private_key).read_bytes(),
            ta_url=None,
        )
    ) as signer:
        yield signer


def _manifest(config: SigningConfig) -> dict:
    return {
        "claim_generator_info": [{"name": "Daedalus"}],
        "title": "AI-generated image",
        "assertions": [
            {
                "label": "cawg.metadata",
                "data": {
                    "@context": {
                        "dc": "http://purl.org/dc/elements/1.1/",
                        "Iptc4xmpExt": "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
                    },
                    "dc:creator": [config.creator],
                    "Iptc4xmpExt:DigitalSourceType": _SOURCE_TYPE,
                },
            }
        ],
    }


def sign_final_image(b64_data: str, mime_type: str) -> str:
    """Return the signed original bytes as base64, or unchanged bytes when off.

    Run in a worker thread. Each operation owns its SDK context and signer;
    there are no global native settings or reusable single-use builders.
    Signing or validation failure never falls back to unsigned publication.
    """
    config = SigningConfig.from_env()
    if config.mode == "off":
        return b64_data
    try:
        import c2pa

        if mime_type not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("Unsupported final image format")
        source = base64.b64decode(b64_data, validate=True)
        settings = {
            "core": {
                "decode_identity_assertions": False,
                "allowed_network_hosts": [],
                "max_decompressed_manifest_size_in_mb": 64,
            },
            "builder": {"thumbnail": {"enabled": False}},
            "verify": {
                "remote_manifest_fetch": False,
                "ocsp_fetch": False,
                "verify_after_sign": True,
            },
        }
        with c2pa.Context.from_dict(settings) as context, _signer(config) as signer:
            # Preserve an embedded provider manifest as the parent of a metadata
            # update. Never replace upstream provenance with a fresh history.
            try:
                with c2pa.Reader(
                    mime_type, io.BytesIO(source), context=context
                ) as reader:
                    has_manifest = bool(
                        json.loads(reader.json()).get("active_manifest")
                    )
            except c2pa.C2paError.ManifestNotFound:
                has_manifest = False

            with c2pa.Builder(_manifest(config), context=context) as builder:
                if has_manifest:
                    builder.set_intent(c2pa.C2paBuilderIntent.UPDATE)
                else:
                    builder.set_intent(
                        c2pa.C2paBuilderIntent.CREATE,
                        c2pa.C2paDigitalSourceType.TRAINED_ALGORITHMIC_MEDIA,
                    )
                output = io.BytesIO()
                builder.sign(signer, mime_type, io.BytesIO(source), output)
            signed = output.getvalue()
            # Read the actual asset again to verify its content binding. Trust
            # is evaluated by external validators using their own trust lists;
            # a test certificate may be Valid without being Trusted.
            with c2pa.Reader(mime_type, io.BytesIO(signed), context=context) as reader:
                if reader.get_validation_state() not in {"Valid", "Trusted"}:
                    raise ValueError("Signed asset failed C2PA validation")
            return base64.b64encode(signed).decode("ascii")
    except Exception as exc:
        logger.error("Final image C2PA signing failed (%s)", type(exc).__name__)
        raise ContentCredentialsError(
            "Content Credentials signing failed; the final image was not published."
        ) from None
