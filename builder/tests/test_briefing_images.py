"""Article photo fetch, embedding, and graceful omission contracts."""

import asyncio
import base64
import copy
import io
import random
from unittest.mock import AsyncMock

import httpx
import pytest
from nat_helpers import briefing_images as images
from PIL import Image


def png_bytes():
    output = io.BytesIO()
    Image.new("RGB", (32, 24), color="navy").save(output, format="PNG")
    return output.getvalue()


def figure(url="https://photos.example/photo.png", **metadata):
    return {
        "type": "figure",
        "url": url,
        "source_page": "https://news.example/article",
        "credit": "Source Photographer",
        **metadata,
    }


def test_photo_bytes_decode_and_large_photos_get_compact_display_copies():
    small = png_bytes()
    assert base64.b64decode(images._raster_data_url(small).split(",", 1)[1]) == small
    original = Image.frombytes(
        "RGB", (1200, 800), random.Random(42).randbytes(1200 * 800 * 3)
    )
    output = io.BytesIO()
    original.save(output, format="PNG")
    data = images._raster_data_url(output.getvalue())
    payload = base64.b64decode(data.split(",", 1)[1])
    assert len(payload) <= images._MAX_EMBEDDED_BYTES
    with Image.open(io.BytesIO(payload)) as decoded:
        assert decoded.width <= 1024
        assert decoded.height <= 1024


@pytest.mark.parametrize(
    "content",
    [b"<svg/>", b"<html>Not a photograph</html>", b"\x89PNG\r\n\x1a\ninvalid"],
)
def test_invalid_rasters_are_rejected(content):
    with pytest.raises((ValueError, OSError)):
        images._raster_data_url(content)


def test_embedding_reuses_fetches_preserves_source_text_and_does_not_mutate_input(
    monkeypatch,
):
    edition = {
        "lead": {"figure": figure(caption="Source caption, verbatim.")},
        "departments": [
            {
                "stories": [
                    {
                        "headline": "News",
                        "blocks": [
                            {"type": "paragraph", "text": "Reporting survives."},
                            figure(),
                            figure("https://photos.example/broken.png"),
                        ],
                    }
                ]
            }
        ],
    }
    original = copy.deepcopy(edition)
    data = images._raster_data_url(png_bytes())

    async def fetch(url):
        if url.endswith("broken.png"):
            raise TimeoutError("unavailable")
        return data

    fetcher = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(images, "_fetch_photo", fetcher)
    result = asyncio.run(images.embed_article_photos(edition))
    assert edition == original
    assert fetcher.await_count == 2
    assert result["lead"]["figure"]["data_url"] == data
    assert result["lead"]["figure"]["caption"] == "Source caption, verbatim."
    assert result["departments"][0]["stories"][0]["blocks"] == [
        {"type": "paragraph", "text": "Reporting survives."}
    ]


def test_photo_count_and_concurrency_are_bounded(monkeypatch):
    active = maximum = 0

    async def fetch(_url):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0)
        active -= 1
        return images._raster_data_url(png_bytes())

    fetcher = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(images, "_fetch_photo", fetcher)
    edition = {
        "departments": [
            {
                "stories": [
                    {
                        "blocks": [
                            figure(f"https://photos.example/{i}.png") for i in range(8)
                        ]
                    }
                ]
            }
        ]
    }
    result = asyncio.run(images.embed_article_photos(edition))
    assert fetcher.await_count == 6
    assert maximum <= 3
    assert len(result["departments"][0]["stories"][0]["blocks"]) == 6


def test_malformed_editions_reach_canonical_validation_without_photo_fetches(
    monkeypatch,
):
    fetcher = AsyncMock()
    monkeypatch.setattr(images, "_fetch_photo", fetcher)
    edition = {
        "operations_details": 3,
        "departments": [7, {"stories": 4}],
        "lead": "wrong",
    }
    assert asyncio.run(images.embed_article_photos(edition)) == edition
    fetcher.assert_not_awaited()


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/photo.png",
        "http://photos.example/photo.png",
        "https://user:password@photos.example/photo.png",
    ],
)
def test_photo_fetch_rejects_nonpublic_nonhttps_or_credential_urls(url):
    with pytest.raises(ValueError):
        asyncio.run(images._fetch_photo(url))


def test_public_photo_fetch_keeps_caption_work_out_of_network_path(monkeypatch):
    from nat_helpers import url_guard

    monkeypatch.setattr(
        url_guard.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            200, headers={"content-type": "image/png"}, content=png_bytes()
        )

    def transport(**kwargs):
        assert kwargs == {"max_response_bytes": 2_000_000}
        return httpx.MockTransport(respond)

    monkeypatch.setattr(images, "PublicAsyncHTTPTransport", transport)
    data = asyncio.run(images._fetch_photo("https://photos.example/photo.png"))
    assert data.startswith("data:image/png;base64,")
    assert len(calls) == 1
    assert "authorization" not in calls[0].headers
    assert "cookie" not in calls[0].headers


def test_photo_redirect_to_private_address_is_rejected(monkeypatch):
    from nat_helpers import url_guard

    monkeypatch.setattr(
        url_guard.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            302, headers={"location": "https://127.0.0.1/private.png"}
        )

    monkeypatch.setattr(
        images,
        "PublicAsyncHTTPTransport",
        lambda **_kwargs: httpx.MockTransport(respond),
    )
    with pytest.raises(ValueError):
        asyncio.run(images._fetch_photo("https://photos.example/photo.png"))
    assert len(calls) == 1
