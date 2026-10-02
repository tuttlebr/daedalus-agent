"""Embed article-linked raster photos without model analysis or remote HTML assets."""

from __future__ import annotations

import asyncio
import base64
import copy
import io
from typing import Any
from urllib.parse import urlsplit

import httpx

from .safe_http import PublicAsyncHTTPTransport, get_public_response_async
from .url_guard import validate_public_url

_MAX_PHOTOS = 6
_MAX_DOWNLOAD_BYTES = 2_000_000
_MAX_EMBEDDED_BYTES = 74_000
_MAX_PIXELS = 24_000_000


def _raster_data_url(content: bytes) -> str:
    """Decode bounded raster input and make a compact display copy when needed."""
    from PIL import Image, ImageOps

    try:
        opened = Image.open(io.BytesIO(content))
    except Image.DecompressionBombError as exc:
        raise ValueError("Article photo exceeds pixel limit") from exc
    with opened as original:
        if original.format not in {"JPEG", "PNG", "WEBP", "GIF"}:
            raise ValueError("Unsupported article photo format")
        if original.width * original.height > _MAX_PIXELS:
            raise ValueError("Article photo exceeds pixel limit")
        mime = Image.MIME[original.format]
        original.load()
        if len(content) <= _MAX_EMBEDDED_BYTES:
            payload = content
        else:
            photo = ImageOps.exif_transpose(original).convert("RGB")
            photo.thumbnail((1024, 1024))
            for quality in (82, 65, 45):
                output = io.BytesIO()
                photo.save(output, format="JPEG", quality=quality, optimize=True)
                payload = output.getvalue()
                if len(payload) <= _MAX_EMBEDDED_BYTES:
                    break
                photo.thumbnail(
                    (max(1, photo.width * 3 // 4), max(1, photo.height * 3 // 4))
                )
            else:
                raise ValueError("Article photo exceeds embedded size limit")
            mime = "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"


async def _fetch_photo(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Article photo URLs cannot contain credentials")
    validate_public_url(url, allowed_schemes=("https",), check_dns=False)
    async with asyncio.timeout(10):
        async with httpx.AsyncClient(
            transport=PublicAsyncHTTPTransport(max_response_bytes=_MAX_DOWNLOAD_BYTES),
            follow_redirects=False,
            trust_env=False,
            timeout=8,
            headers={"Accept": "image/jpeg,image/png,image/webp,image/gif"},
        ) as client:
            response = await get_public_response_async(
                client, url, allowed_schemes=("https",), max_redirects=3
            )
            response.raise_for_status()
            media_type = (
                response.headers.get("content-type", "").split(";", 1)[0].lower()
            )
            if media_type not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
                raise ValueError("Article photo response is not a supported raster")
            return await asyncio.to_thread(_raster_data_url, response.content)


async def embed_article_photos(edition: dict[str, Any]) -> dict[str, Any]:
    """Fetch supplied article-photo URLs once; a failed photo never loses the story.

    Only source metadata enters the tool call. Image bytes stay in backend-owned
    data through sandbox staging, local recovery, and exact terminal delivery.
    """
    prepared = copy.deepcopy(edition)
    figures: list[dict] = []
    lead = prepared.get("lead")
    if isinstance(lead, dict) and isinstance(lead.get("figure"), dict):
        figures.append(lead["figure"])

    def items(value):
        return value if isinstance(value, list) else []

    stories = []
    for department in items(prepared.get("departments")):
        if isinstance(department, dict):
            stories.extend(items(department.get("stories")))
    stories.extend(items(prepared.get("operations_details")))
    for story in stories:
        if isinstance(story, dict) and isinstance(story.get("blocks"), list):
            figures.extend(
                block
                for block in story["blocks"]
                if isinstance(block, dict) and block.get("type") == "figure"
            )

    selected: dict[str, str | None] = {}
    for figure in figures:
        url = figure.get("url")
        if (
            isinstance(url, str)
            and "data_url" not in figure
            and url not in selected
            and len(selected) < _MAX_PHOTOS
        ):
            selected[url] = None
    if not selected:
        return prepared

    semaphore = asyncio.Semaphore(3)

    async def fetch(url):
        async with semaphore:
            try:
                selected[url] = await _fetch_photo(url)
            except (ValueError, OSError, httpx.HTTPError, TimeoutError):
                # Do not expose signed image URLs or turn a photo failure into
                # an extra model round or a failed news edition.
                pass

    async with asyncio.TaskGroup() as group:
        for url in selected:
            group.create_task(fetch(url))

    omitted: set[int] = set()
    seen: set[str] = set()
    for figure in figures:
        if "data_url" in figure:
            continue
        url = figure.get("url")
        if not isinstance(url, str):
            continue  # Preserve structural mistakes for canonical diagnostics.
        data = selected.get(url)
        if data and url not in seen:
            figure["data_url"] = data
            seen.add(url)
        else:
            omitted.add(id(figure))
    if isinstance(lead, dict) and id(lead.get("figure")) in omitted:
        del lead["figure"]
    for story in stories:
        if isinstance(story, dict) and isinstance(story.get("blocks"), list):
            blocks = story["blocks"]
            story["blocks"] = [block for block in blocks if id(block) not in omitted]
            if blocks and not story["blocks"]:
                story["blocks"] = [
                    {
                        "type": "paragraph",
                        "text": "The source photograph could not be retrieved.",
                    }
                ]
    return prepared
