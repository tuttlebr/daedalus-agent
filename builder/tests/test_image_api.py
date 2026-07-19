"""Schema-level tests for the /v1/images/* FastAPI routes."""

import sys
from io import BytesIO
from pathlib import Path

# image_api.py lives at the workspace root inside the Docker image. Make it
# importable from the builder/ test run, too.
_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import nat_helpers.internal_auth as internal_auth  # noqa: E402
import pytest  # noqa: E402  (path tweak must precede these imports)
from image_api import (  # noqa: E402
    EditRequest,
    GenerateRequest,
    ImageRef,
    _mask_validation_error,
    _normalize_edit_source,
    _require_trusted_user,
    router,
)
from PIL import Image  # noqa: E402
from pydantic import ValidationError  # noqa: E402


class _FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _raises_status(monkeypatch, *args):
    """Call _require_trusted_user with fastapi.HTTPException swapped for a real
    exception class (it is a MagicMock under conftest), returning the status.
    The auth helpers now live in nat_helpers.internal_auth (F-019), so patch
    HTTPException there."""
    monkeypatch.setattr(internal_auth, "HTTPException", _FakeHTTPException)
    with pytest.raises(_FakeHTTPException) as exc_info:
        _require_trusted_user(*args)
    return exc_info.value.status_code


class TestRouter:
    def test_router_exists(self):
        # FastAPI is mocked in conftest, so we can't introspect routes here —
        # just confirm the module imported and exposed a router object.
        assert router is not None


class TestInternalAuth:
    def test_fails_closed_when_token_unconfigured(self, monkeypatch):
        # F-003 regression: no internal token + no explicit opt-out must REFUSE
        # (503), never fall through to trusting the caller-supplied x-user-id.
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)
        assert _raises_status(monkeypatch, "alice", None) == 503

    def test_insecure_optout_allows_when_unconfigured(self, monkeypatch):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        assert _require_trusted_user(" alice ") == "alice"

    def test_rejects_missing_user_under_optout(self, monkeypatch):
        monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
        monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")
        assert _raises_status(monkeypatch, None) == 401

    def test_requires_internal_token_when_configured(self, monkeypatch):
        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        assert _raises_status(monkeypatch, "alice", None) == 401

    def test_accepts_matching_internal_token(self, monkeypatch):
        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        assert _require_trusted_user(" alice ", "secret-token") == "alice"

    def test_rejects_missing_user_with_token(self, monkeypatch):
        monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")
        assert _raises_status(monkeypatch, None, "secret-token") == 401


class TestGenerateRequest:
    def test_minimal(self):
        req = GenerateRequest(prompt="a cat")
        assert req.prompt == "a cat"
        assert req.n is None

    def test_full(self):
        req = GenerateRequest(
            prompt="a cat",
            n=2,
            quality="high",
            size="1024x1024",
            output_format="png",
            output_compression=90,
            background="transparent",
            moderation="low",
        )
        dumped = req.model_dump(exclude_none=True)
        assert dumped["n"] == 2
        assert dumped["quality"] == "high"
        assert dumped["background"] == "transparent"

    def test_rejects_empty_prompt(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="")

    def test_rejects_n_out_of_range(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="x", n=11)

    def test_rejects_invalid_quality(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="x", quality="super")

    def test_accepts_high_resolution_size(self):
        req = GenerateRequest(prompt="x", size="2048x2048")
        assert req.size == "2048x2048"

    def test_accepts_streaming_options(self):
        req = GenerateRequest(prompt="x", stream=True, partial_images=2)
        assert req.stream is True
        assert req.partial_images == 2

    def test_rejects_partial_images_out_of_range(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="x", stream=True, partial_images=4)


class TestEditRequest:
    def test_minimal(self):
        req = EditRequest(
            prompt="edit",
            imageRefs=[ImageRef(imageId="a", sessionId="s")],
        )
        assert len(req.imageRefs) == 1
        assert req.imageRefs[0].imageId == "a"

    def test_multi_image(self):
        req = EditRequest(
            prompt="composite",
            imageRefs=[
                ImageRef(imageId="a", sessionId="s"),
                ImageRef(imageId="b", sessionId="s"),
            ],
            input_fidelity="high",
        )
        assert len(req.imageRefs) == 2
        assert req.input_fidelity == "high"

    def test_rejects_empty_imagerefs(self):
        with pytest.raises(ValidationError):
            EditRequest(prompt="x", imageRefs=[])

    def test_mask_accepted(self):
        req = EditRequest(
            prompt="inpaint",
            imageRefs=[ImageRef(imageId="a", sessionId="s")],
            maskRef=ImageRef(imageId="m", sessionId="s"),
        )
        assert req.maskRef is not None
        assert req.maskRef.imageId == "m"

    def test_rejects_invalid_input_fidelity(self):
        with pytest.raises(ValidationError):
            EditRequest(
                prompt="x",
                imageRefs=[ImageRef(imageId="a", sessionId="s")],
                input_fidelity="max",
            )


def _png(width: int, height: int, color_type: int) -> bytes:
    """Build the minimal PNG structure needed by mask-preflight tests."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return len(data).to_bytes(4, "big") + kind + data + b"\0\0\0\0"

    ihdr = (
        width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + bytes([8, color_type, 0, 0, 0])
    )
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


class TestEditMaskPreflight:
    def test_accepts_same_size_png_with_alpha_mask(self):
        source = _png(1024, 768, color_type=2)
        mask = _png(1024, 768, color_type=6)

        assert _mask_validation_error(source, mask) is None

    def test_rejects_mask_without_alpha_channel(self):
        source = _png(1024, 768, color_type=2)
        mask = _png(1024, 768, color_type=2)

        error = _mask_validation_error(source, mask)

        assert error is not None
        assert "alpha channel" in error

    def test_rejects_mask_with_different_dimensions(self):
        source = _png(1024, 768, color_type=2)
        mask = _png(1024, 767, color_type=6)

        error = _mask_validation_error(source, mask)

        assert error is not None
        assert "same dimensions" in error

    def test_rejects_non_png_source_for_mask_edit(self):
        error = _mask_validation_error(b"not a png", _png(1024, 768, 6))

        assert error is not None
        assert "primary input image must be a PNG" in error


class TestEditSourceNormalization:
    def test_flattens_mpo_to_single_frame_jpeg(self):
        first = Image.new("RGB", (8, 6), "red")
        second = Image.new("RGB", (8, 6), "blue")
        source = BytesIO()
        first.save(source, format="MPO", save_all=True, append_images=[second])

        normalized, mime_type, extension = _normalize_edit_source(source.getvalue())

        assert mime_type == "image/jpeg"
        assert extension == "jpg"
        assert normalized.startswith(b"\xff\xd8\xff")
        with Image.open(BytesIO(normalized)) as image:
            assert image.format == "JPEG"
            assert getattr(image, "n_frames", 1) == 1
            assert image.size == (8, 6)
            assert "mp" not in image.info

    def test_preserves_png_alpha_and_dimensions(self):
        source = BytesIO()
        Image.new("RGBA", (5, 7), (10, 20, 30, 40)).save(source, format="PNG")

        normalized, mime_type, extension = _normalize_edit_source(source.getvalue())

        assert mime_type == "image/png"
        assert extension == "png"
        assert normalized.startswith(b"\x89PNG\r\n\x1a\n")
        with Image.open(BytesIO(normalized)) as image:
            assert image.mode == "RGBA"
            assert image.size == (5, 7)

    def test_rejects_undecodable_bytes(self):
        with pytest.raises(ValueError, match="could not be decoded"):
            _normalize_edit_source(b"not an image")
