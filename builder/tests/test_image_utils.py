"""Unit tests for nat_helpers.image_utils shared utilities."""

import asyncio
import json

from nat_helpers.image_utils import fetch_image_from_redis, parse_ref

# ---------------------------------------------------------------------------
# parse_ref
# ---------------------------------------------------------------------------


class TestParseRef:
    def test_none_returns_none(self):
        assert parse_ref(None) is None

    def test_dict_passthrough(self):
        ref = {"imageId": "abc", "sessionId": "xyz"}
        assert parse_ref(ref) is ref

    def test_valid_json_string(self):
        ref_dict = {"imageId": "abc", "sessionId": "xyz"}
        result = parse_ref(json.dumps(ref_dict))
        assert result == ref_dict

    def test_invalid_json_string_returns_none(self):
        assert parse_ref("not-valid-json{{{") is None

    def test_other_type_returns_none(self):
        assert parse_ref(42) is None


# ---------------------------------------------------------------------------
# fetch_image_from_redis — key lookup order
# ---------------------------------------------------------------------------


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class _FakeRedis:
    """Minimal stand-in for redis.Redis that records the keys it was asked for
    and returns a payload only when a specific key matches."""

    def __init__(self, payload_for_key: dict[str, str]):
        self.payload_for_key = payload_for_key
        self.requested_keys: list[str] = []

    def execute_command(self, cmd, key):
        self.requested_keys.append(key)
        return self.payload_for_key.get(key)


class TestFetchImageFromRedis:
    def test_finds_generated_image_via_fallback(self):
        # Simulate a generated-panel output image: only the generated:image:{id}
        # key has a payload. User/session keys are empty.
        payload = json.dumps({"data": "aGVsbG8=", "mimeType": "image/png"})
        redis_client = _FakeRedis({"generated:image:abc123": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "abc123", "sessionId": "generated"},
            )
        )

        assert result == ("aGVsbG8=", "image/png")
        # Confirm we tried generated:image:{id} (the user/session path is
        # skipped when sessionId == 'generated').
        assert "generated:image:abc123" in redis_client.requested_keys

    def test_prefers_user_scope_when_available(self):
        payload_user = json.dumps({"data": "dXNlcg==", "mimeType": "image/png"})
        payload_generated = json.dumps({"data": "Z2Vu", "mimeType": "image/png"})
        redis_client = _FakeRedis(
            {
                "user:alice:image:abc": payload_user,
                "generated:image:abc": payload_generated,
            }
        )

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "abc", "sessionId": "sess1", "userId": "alice"},
            )
        )

        # User-scoped key wins — we should never fall through to generated.
        assert result[0] == "dXNlcg=="
        assert redis_client.requested_keys[0] == "user:alice:image:abc"

    def test_missing_image_returns_error(self):
        redis_client = _FakeRedis({})
        result = _run(
            fetch_image_from_redis(
                redis_client, {"imageId": "nope", "sessionId": "sess1"}
            )
        )
        assert result[0] is None
        assert "not found" in result[1].lower()

    def test_invalid_ref_returns_error(self):
        redis_client = _FakeRedis({})
        result = _run(fetch_image_from_redis(redis_client, None))
        assert result[0] is None

    def test_skips_session_key_for_generated_session(self):
        """sessionId='generated' should NOT trigger the session-scoped lookup;
        that key doesn't exist and would be wasted Redis round-trips."""
        payload = json.dumps({"data": "Z2Vu", "mimeType": "image/png"})
        redis_client = _FakeRedis({"generated:image:xyz": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client, {"imageId": "xyz", "sessionId": "generated"}
            )
        )

        assert result == ("Z2Vu", "image/png")
        assert "image:generated:xyz" not in redis_client.requested_keys
