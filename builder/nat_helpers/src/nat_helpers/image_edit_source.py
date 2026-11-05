"""Decode still-image edit inputs consistently for Create and chat."""

import io

from PIL import Image, ImageOps, UnidentifiedImageError

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
_OPENAI_MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024


def _has_transparency(image: Image.Image) -> bool:
    return image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    )


def normalize_edit_source(
    image_bytes: bytes,
) -> tuple[bytes, str, str]:
    """Return a decoded, single-frame Image API upload.

    Stored uploads may be decoder-sensitive JPEG variants such as MPO, animated
    containers, or legacy records whose MIME metadata does not match their
    bytes. Decode the first image, apply EXIF orientation, strip container
    metadata, and re-encode to one of the formats accepted by GPT Image edits.
    PNG sources stay PNG so source/mask format matching remains possible;
    transparency also selects PNG. Other sources become a baseline JPEG.
    """
    if not image_bytes:
        raise ValueError("image file is empty")

    try:
        with Image.open(io.BytesIO(image_bytes)) as opened:
            source_format = str(opened.format or "").upper()
            opened.seek(0)
            normalized = ImageOps.exif_transpose(opened)
            use_png = source_format == "PNG" or _has_transparency(normalized)
            output = io.BytesIO()

            if use_png:
                mode = "RGBA" if _has_transparency(normalized) else "RGB"
                normalized.convert(mode).save(output, format="PNG", optimize=False)
                mime_type = "image/png"
                extension = "png"
            else:
                normalized.convert("RGB").save(
                    output,
                    format="JPEG",
                    quality=95,
                    subsampling=0,
                    progressive=False,
                    optimize=False,
                )
                mime_type = "image/jpeg"
                extension = "jpg"
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ValueError(f"image file could not be decoded: {exc}") from exc

    normalized_bytes = output.getvalue()
    if len(normalized_bytes) >= _OPENAI_MAX_EDIT_IMAGE_BYTES:
        raise ValueError("normalized image must be less than 50MB")
    if mime_type == "image/png" and not normalized_bytes.startswith(_PNG_SIGNATURE):
        raise ValueError("normalization did not produce a valid PNG file")
    if mime_type == "image/jpeg" and not normalized_bytes.startswith(_JPEG_SIGNATURE):
        raise ValueError("normalization did not produce a valid JPEG file")
    return normalized_bytes, mime_type, extension
