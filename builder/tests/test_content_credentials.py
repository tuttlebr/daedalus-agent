"""Real SDK signing/verification; keys are ephemeral, private test fixtures."""

import asyncio
import base64
import io
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import c2pa
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from nat_helpers.content_credentials import (
    ContentCredentialsError,
    SigningConfig,
    sign_final_image,
)
from nat_helpers.image_utils import store_image_in_redis
from PIL import Image


@pytest.fixture
def credentials(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / "scripts"))
    from create_content_credentials import generate_bundle

    bundle = tmp_path / "credentials"
    generate_bundle(bundle)
    monkeypatch.setenv("C2PA_SIGNING_MODE", "local")
    monkeypatch.setenv("C2PA_CERTIFICATE_FILE", str(bundle / "chain.pem"))
    monkeypatch.setenv("C2PA_PRIVATE_KEY_FILE", str(bundle / "key.pem"))
    monkeypatch.setenv("C2PA_SIGNING_ALGORITHM", "es256")
    monkeypatch.setenv("C2PA_CREATOR_NAME", "Brandon Tuttle")
    return bundle


def image_bytes(fmt="png"):
    image = Image.new(
        "RGB" if fmt == "jpeg" else "RGBA",
        (32, 32),
        (12, 45, 90) if fmt == "jpeg" else (12, 45, 90, 123),
    )
    stream = io.BytesIO()
    image.save(stream, format=fmt)
    return stream.getvalue()


def read_manifest(data, mime="image/png"):
    with c2pa.Context.from_dict(
        {"verify": {"remote_manifest_fetch": False}}
    ) as context:
        with c2pa.Reader(mime, io.BytesIO(data), context=context) as reader:
            return json.loads(reader.json()), reader.get_validation_state()


@pytest.mark.parametrize("fmt", ["png", "jpeg", "webp"])
def test_real_signing_preserves_pixels_and_embeds_public_attribution(credentials, fmt):
    original = image_bytes(fmt)
    signed = base64.b64decode(
        sign_final_image(base64.b64encode(original).decode(), f"image/{fmt}")
    )
    store, state = read_manifest(signed, f"image/{fmt}")
    assert state == "Valid"  # Integrity is valid; this test signer is not trusted.
    manifest = store["manifests"][store["active_manifest"]]
    assert manifest["claim_generator_info"][0]["name"] == "Daedalus"
    assertions = {a["label"]: a["data"] for a in manifest["assertions"]}
    assert assertions["cawg.metadata"]["dc:creator"] == ["Brandon Tuttle"]
    assert assertions["cawg.metadata"]["Iptc4xmpExt:DigitalSourceType"].endswith(
        "/trainedAlgorithmicMedia"
    )
    assert assertions["c2pa.actions.v2"]["actions"][0]["action"] == "c2pa.created"
    with Image.open(io.BytesIO(original)) as before, Image.open(
        io.BytesIO(signed)
    ) as after:
        assert before.size == after.size
        assert before.mode == after.mode
        assert before.tobytes() == after.tobytes()


def test_tampered_pixels_invalidate_credentials(credentials):
    signed = bytearray(
        base64.b64decode(
            sign_final_image(base64.b64encode(image_bytes()).decode(), "image/png")
        )
    )
    offset = signed.index(b"IDAT") + 8
    signed[offset] ^= 1
    store, state = read_manifest(bytes(signed))
    assert state == "Invalid"
    assert "assertion.dataHash.mismatch" in json.dumps(store)


def test_preserves_embedded_provider_manifest(credentials):
    original = sign_final_image(base64.b64encode(image_bytes()).decode(), "image/png")
    provider, _ = read_manifest(base64.b64decode(original))
    signed = sign_final_image(original, "image/png")
    store, state = read_manifest(base64.b64decode(signed))
    assert state == "Valid"
    assert provider["active_manifest"] in store["manifests"]
    assert store["active_manifest"] != provider["active_manifest"]
    active = store["manifests"][store["active_manifest"]]
    assert active["ingredients"][0]["relationship"] == "parentOf"


def test_storage_signs_finals_but_leaves_partials_and_private_context_out(credentials):
    redis = MagicMock()
    original = base64.b64encode(image_bytes()).decode()

    async def run():
        for partial in (True, False):
            await store_image_in_redis(
                redis,
                original,
                "image/png",
                "private prompt",
                user_id="private account",
                session_id="private session",
                image_context={"prompt": "private prompt", "refs": ["private input"]},
                is_partial=partial,
            )

    asyncio.run(run())
    records = [
        json.loads(call.args[-1]) for call in redis.execute_command.call_args_list
    ]
    assert records[0]["data"] == original
    assert records[1]["data"] != original
    manifest, state = read_manifest(base64.b64decode(records[1]["data"]))
    assert state == "Valid"
    assert "private" not in json.dumps(manifest)
    assert records[1]["userId"] == "private account"


def test_signing_failure_never_writes_final_to_redis(credentials):
    redis = MagicMock()
    with pytest.raises(ContentCredentialsError, match="not published"):
        asyncio.run(
            store_image_in_redis(redis, "invalid image", "image/png", "private prompt")
        )
    redis.execute_command.assert_not_called()


def test_off_preserves_existing_behavior(monkeypatch):
    monkeypatch.setenv("C2PA_SIGNING_MODE", "off")
    assert sign_final_image("opaque original", "image/png") == "opaque original"


def test_misconfiguration_fails_closed(monkeypatch):
    monkeypatch.setenv("C2PA_SIGNING_MODE", "typo")
    with pytest.raises(ContentCredentialsError):
        sign_final_image("opaque original", "image/png")
    monkeypatch.setenv("C2PA_SIGNING_MODE", "local")
    monkeypatch.setenv("C2PA_CERTIFICATE_FILE", "/missing-certificate")
    with pytest.raises(ContentCredentialsError):
        sign_final_image("opaque original", "image/png")


def test_wrong_private_key_cannot_publish(credentials):
    wrong_key = ec.generate_private_key(ec.SECP256R1())
    Path(SigningConfig.from_env().private_key).write_bytes(
        wrong_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    with pytest.raises(ContentCredentialsError, match="not published"):
        sign_final_image(base64.b64encode(image_bytes()).decode(), "image/png")


@pytest.mark.parametrize("operation", ["generate", "edit"])
@pytest.mark.parametrize("streaming", [False, True])
def test_missing_configuration_rejects_before_provider_call(
    monkeypatch, operation, streaming
):
    from nat_helpers import openai_images

    monkeypatch.setenv("C2PA_SIGNING_MODE", "local")
    monkeypatch.setenv("C2PA_CERTIFICATE_FILE", "/missing-certificate")
    client = MagicMock()
    client.images.generate = AsyncMock()
    client.images.edit = AsyncMock()
    fn = getattr(
        openai_images, ("stream_" if streaming else "") + operation + "_images"
    )
    kwargs = {"model": "gpt-image-2.5-sunburst", "prompt": "test"}
    if operation == "edit":
        kwargs["image"] = ("image.png", image_bytes(), "image/png")

    async def run():
        if streaming:
            return [item async for item in fn(client, **kwargs)]
        return await fn(client, **kwargs)

    with pytest.raises(ContentCredentialsError):
        asyncio.run(run())
    client.images.generate.assert_not_called()
    client.images.edit.assert_not_called()


@pytest.mark.parametrize("operation", ["generate", "edit"])
def test_chat_generate_and_edit_deliver_signed_finals(
    credentials, monkeypatch, operation
):
    import visual_media.visual_media_function as visual
    from nat_helpers.openai_images import ImageResult

    original = base64.b64encode(image_bytes()).decode()
    redis = MagicMock()
    monkeypatch.setattr(visual.redis, "from_url", lambda *a, **kw: redis)
    monkeypatch.setattr(
        visual, "resolve_authenticated_user_id", lambda *_: "private account"
    )
    monkeypatch.setattr(visual.AsyncOpenAI.return_value, "close", AsyncMock())
    monkeypatch.setattr(
        visual,
        "generate_images" if operation == "generate" else "edit_images",
        AsyncMock(return_value=[ImageResult(original), ImageResult(original)]),
    )
    monkeypatch.setattr(
        visual,
        "fetch_image_from_redis",
        AsyncMock(return_value=(original, "image/png")),
    )
    monkeypatch.setattr(visual, "fetch_image_context", AsyncMock(return_value=None))

    async def run():
        tool = visual.visual_media_function(
            visual.VisualMediaFunctionConfig(
                generation_api_key="test", edit_api_key="test"
            ),
            MagicMock(),
        )
        info = await tool.__anext__()
        try:
            return await info.fn(
                operation=operation,
                prompt="private prompt",
                guidance="exact",
                imageRef={"imageId": "private input"},
            )
        finally:
            await tool.aclose()

    response = asyncio.run(run())
    assert response.count("/api/generated-image/") == 2
    for call in redis.execute_command.call_args_list:
        record = json.loads(call.args[-1])
        manifest, state = read_manifest(base64.b64decode(record["data"]))
        assert state == "Valid"
        assert "private" not in json.dumps(manifest)


@pytest.fixture
def image_api(monkeypatch):
    # Load real route functions with a passthrough router rather than the global
    # conftest's MagicMock decorators. The C2PA SDK and storage code stay real.
    import importlib.util
    import sys

    monkeypatch.setattr(
        sys.modules["fastapi"].APIRouter.return_value,
        "post",
        lambda *a, **kw: lambda fn: fn,
    )
    spec = importlib.util.spec_from_file_location(
        "image_api_credentials_test", Path(__file__).parents[1] / "image_api.py"
    )
    api = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, api)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "OpenAIError", type("ProviderError", (Exception,), {}))
    monkeypatch.setattr(
        api,
        "HTTPException",
        type(
            "HttpError",
            (Exception,),
            {
                "__init__": lambda self, status_code, detail: Exception.__init__(
                    self, status_code, detail
                )
            },
        ),
    )
    monkeypatch.setattr(api, "_require_trusted_user", lambda *a: "private account")
    monkeypatch.setattr(
        api, "_config_for", lambda *a: ("gpt-image-2.5-sunburst", "test", None)
    )
    monkeypatch.setattr(api, "_get_client", lambda *a: MagicMock())
    return api


@pytest.mark.parametrize("operation", ["generate", "edit"])
@pytest.mark.parametrize("broken", [False, True])
def test_create_routes_sign_finals_and_report_signing_failure(
    credentials, monkeypatch, image_api, operation, broken
):
    from nat_helpers.openai_images import ImageResult

    api = image_api
    redis = MagicMock()
    monkeypatch.setattr(api, "_get_redis", lambda: redis)
    original = base64.b64encode(image_bytes()).decode()
    monkeypatch.setattr(
        api,
        "generate_images" if operation == "generate" else "edit_images",
        AsyncMock(return_value=[ImageResult("broken" if broken else original)]),
    )
    monkeypatch.setattr(
        api, "fetch_image_from_redis", AsyncMock(return_value=(original, "image/png"))
    )
    monkeypatch.setattr(api, "fetch_image_context", AsyncMock(return_value=None))
    request = (
        api.GenerateRequest(prompt="private prompt", guidance="exact")
        if operation == "generate"
        else api.EditRequest(
            prompt="private prompt",
            guidance="exact",
            imageRefs=[api.ImageRef(imageId="private input")],
        )
    )
    if broken:
        with pytest.raises(api.HTTPException) as exc:
            asyncio.run(getattr(api, operation)(request))
        assert exc.value.args[0] == 503
        redis.execute_command.assert_not_called()
        return
    response = asyncio.run(getattr(api, operation)(request))
    assert len(response.imageIds) == 1
    record = json.loads(redis.execute_command.call_args.args[-1])
    store, state = read_manifest(base64.b64decode(record["data"]))
    assert state == "Valid"
    assert "private" not in json.dumps(store)


@pytest.mark.parametrize("source", ["image_panel_generate", "image_panel_edit"])
@pytest.mark.parametrize("ending", ["completed", "truncated", "bad_final"])
def test_create_stream_only_publishes_signed_completed_images(
    credentials, monkeypatch, image_api, source, ending
):
    from nat_helpers.openai_images import ImageResult, ImageStreamEvent

    api = image_api
    original = base64.b64encode(image_bytes()).decode()
    redis = MagicMock()
    monkeypatch.setattr(api, "_get_redis", lambda: redis)

    async def events():
        yield ImageStreamEvent(ImageResult(original), partial=True)
        if ending != "truncated":
            yield ImageStreamEvent(
                ImageResult(original if ending == "completed" else "broken"),
                partial=False,
            )

    async def run():
        return [
            event
            async for event in api._stream_stored_images(
                events(),
                prompt="private prompt",
                source=source,
                user_id="private account",
                session_id="private session",
                model="gpt-image-2.5-sunburst",
            )
        ]

    response = "".join(asyncio.run(run()))
    records = [
        json.loads(call.args[-1]) for call in redis.execute_command.call_args_list
    ]
    assert records[0]["data"] == original
    if ending == "completed":
        assert "event: completed" in response
        assert len(records) == 2
        _, state = read_manifest(base64.b64decode(records[1]["data"]))
        assert state == "Valid"
    else:
        assert "event: error" in response
        assert "event: completed" not in response
        assert len(records) == 1
