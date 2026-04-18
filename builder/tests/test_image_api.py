"""Schema-level tests for the /v1/images/* FastAPI routes."""

import sys
from pathlib import Path

# image_api.py lives at the workspace root inside the Docker image. Make it
# importable from the builder/ test run, too.
_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import pytest  # noqa: E402  (path tweak must precede these imports)
from image_api import EditRequest, GenerateRequest, ImageRef, router  # noqa: E402
from pydantic import ValidationError  # noqa: E402


class TestRouter:
    def test_router_exists(self):
        # FastAPI is mocked in conftest, so we can't introspect routes here —
        # just confirm the module imported and exposed a router object.
        assert router is not None


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

    def test_rejects_invalid_size(self):
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="x", size="2048x2048")


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
