"""Request-local budgets shared by Create and chat image editing."""

import base64
import binascii
import json

MAX_IMAGE_INPUTS = 16
MAX_IMAGE_INPUT_BYTES = 50 * 1024 * 1024
MAX_IMAGE_REQUEST_BYTES = 64 * 1024 * 1024


def image_reference_key(ref: dict) -> str:
    # Keep every field: different ownership/session assertions must still go
    # through storage authorization. Never cache this across requests/users.
    return json.dumps(ref, sort_keys=True, separators=(",", ":"))


class ImageInputBudget:
    def __init__(self):
        self.decoded_bytes = 0
        self.multipart_bytes = 0

    def decode(self, value: str) -> bytes:
        remaining = min(
            MAX_IMAGE_INPUT_BYTES - 1,
            MAX_IMAGE_REQUEST_BYTES - self.decoded_bytes,
        )
        if not isinstance(value, str) or len(value) > 4 * ((remaining + 2) // 3):
            raise ValueError(
                "image inputs exceed the 64 MiB request or 50 MiB file budget"
            )
        try:
            decoded = base64.b64decode(value, validate=True)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise ValueError("image input is not valid base64") from exc
        if len(decoded) > remaining:
            raise ValueError(
                "image inputs exceed the 64 MiB request or 50 MiB file budget"
            )
        self.decoded_bytes += len(decoded)
        return decoded

    def add_part(self, value: bytes) -> None:
        # Charge repeated references too: caching bounds decoding but the
        # provider still receives each requested multipart part, in order.
        if self.multipart_bytes + len(value) > MAX_IMAGE_REQUEST_BYTES:
            raise ValueError("image inputs exceed the 64 MiB multipart request budget")
        self.multipart_bytes += len(value)
