"""Unit tests for nat_helpers.image_utils shared utilities."""

import asyncio
import json

import redis
from nat_helpers.image_utils import (
    fetch_image_from_redis,
    fetch_vtt_from_redis,
    parse_ref,
    parse_stored_vtt,
    store_image_in_redis,
)


class _FakeRedisError(Exception):
    pass


redis.RedisError = _FakeRedisError

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


class _FailingRedis:
    def execute_command(self, *args):
        raise redis.RedisError("write failed")

    def expire(self, *args):
        return True


class _WritableRedis:
    def __init__(self):
        self.commands: list[tuple] = []
        self.expirations: list[tuple] = []

    def execute_command(self, *args):
        self.commands.append(args)
        return "OK"

    def expire(self, *args):
        self.expirations.append(args)
        return True


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

    def test_expected_user_id_rejects_mismatched_ref_user(self):
        redis_client = _FakeRedis({})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "abc", "sessionId": "sess1", "userId": "alice"},
                expected_user_id="bob",
            )
        )

        assert result[0] is None
        assert "different authenticated user" in result[1]
        assert redis_client.requested_keys == []

    def test_expected_user_id_drives_user_key_lookup(self):
        payload = json.dumps({"data": "Ym9i", "mimeType": "image/png"})
        redis_client = _FakeRedis({"user:bob:image:abc": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "abc", "sessionId": "sess1"},
                expected_user_id="bob",
            )
        )

        assert result == ("Ym9i", "image/png")
        assert redis_client.requested_keys[0] == "user:bob:image:abc"

    def test_prefers_vlm_normalized_payload_when_available(self):
        payload = json.dumps(
            {
                "data": "b3JpZw==",
                "mimeType": "image/jpeg",
                "vlmData": "bm9ybQ==",
                "vlmMimeType": "image/png",
            }
        )
        redis_client = _FakeRedis({"image:sess1:abc": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {
                    "imageId": "abc",
                    "sessionId": "sess1",
                    "mimeType": "image/jpeg",
                },
            )
        )

        assert result == ("bm9ybQ==", "image/png")

    def test_can_request_original_bytes_instead_of_vlm_derivative(self):
        """Image-edit callers must not receive the flattened VLM JPEG."""
        payload = json.dumps(
            {
                "data": "b3JpZ2luYWw=",
                "mimeType": "image/png",
                "vlmData": "bm9ybQ==",
                "vlmMimeType": "image/jpeg",
            }
        )
        redis_client = _FakeRedis({"image:sess1:abc": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {
                    "imageId": "abc",
                    "sessionId": "sess1",
                    # The stored record remains authoritative for a
                    # multipart Image API upload.
                    "mimeType": "image/jpeg",
                },
                prefer_vlm_data=False,
            )
        )

        assert result == ("b3JpZ2luYWw=", "image/png")

    def test_prefers_image_api_edit_derivative_when_requested(self):
        payload = json.dumps(
            {
                "data": "b3JpZ2luYWw=",
                "mimeType": "image/jpeg",
                "editData": "c2luZ2xlLWZyYW1l",
                "editMimeType": "image/png",
                "vlmData": "cmVzaXplZA==",
                "vlmMimeType": "image/jpeg",
            }
        )
        redis_client = _FakeRedis({"image:sess1:abc": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "abc", "sessionId": "sess1"},
                prefer_vlm_data=False,
                prefer_edit_data=True,
            )
        )

        assert result == ("c2luZ2xlLWZyYW1l", "image/png")

    def test_edit_derivative_falls_back_to_original_for_legacy_records(self):
        payload = json.dumps(
            {
                "data": "bGVnYWN5",
                "mimeType": "image/jpeg",
                "vlmData": "cmVzaXplZA==",
                "vlmMimeType": "image/jpeg",
            }
        )
        redis_client = _FakeRedis({"image:sess1:abc": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "abc", "sessionId": "sess1"},
                prefer_vlm_data=False,
                prefer_edit_data=True,
            )
        )

        assert result == ("bGVnYWN5", "image/jpeg")

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

    def test_generated_image_rejects_different_owner(self):
        payload = json.dumps(
            {"data": "Z2Vu", "mimeType": "image/png", "userId": "alice"}
        )
        redis_client = _FakeRedis({"generated:image:xyz": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "xyz", "sessionId": "generated"},
                expected_user_id="bob",
            )
        )

        assert result[0] is None
        assert "different authenticated user" in result[1]

    def test_owned_generated_image_denied_when_no_expected_user(self):
        # F-006: an owned generated image must fail closed when the caller
        # presents no authenticated user (e.g. an imageRef carrying only an
        # imageId, expected_user_id=None) — otherwise it leaks cross-user.
        payload = json.dumps(
            {"data": "Z2Vu", "mimeType": "image/png", "userId": "alice"}
        )
        redis_client = _FakeRedis({"generated:image:xyz": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "xyz", "sessionId": "generated"},
            )
        )

        assert result[0] is None
        assert "different authenticated user" in result[1]

    def test_owned_generated_image_allowed_for_matching_user(self):
        # F-006: the legitimate path (trusted user id matching the owner) still
        # succeeds.
        payload = json.dumps(
            {"data": "Z2Vu", "mimeType": "image/png", "userId": "alice"}
        )
        redis_client = _FakeRedis({"generated:image:xyz": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "xyz", "sessionId": "generated"},
                expected_user_id="alice",
            )
        )

        assert result == ("Z2Vu", "image/png")

    def test_unowned_generated_image_is_capability_scoped(self):
        # F-006: an unowned generated image (no stored userId) stays readable
        # via its unguessable id — the panel-generate-without-owner / reuse flow.
        payload = json.dumps({"data": "Z2Vu", "mimeType": "image/png"})
        redis_client = _FakeRedis({"generated:image:xyz": payload})

        result = _run(
            fetch_image_from_redis(
                redis_client,
                {"imageId": "xyz", "sessionId": "generated"},
            )
        )

        assert result == ("Z2Vu", "image/png")


class TestStoreImageInRedis:
    def test_stores_owner_metadata_when_provided(self):
        redis_client = _WritableRedis()

        image_id = _run(
            store_image_in_redis(
                redis_client,
                "aGVsbG8=",
                "image/png",
                "prompt",
                user_id="alice",
                session_id="session-1",
            )
        )

        assert image_id
        command = redis_client.commands[0]
        assert command[0] == "JSON.SET"
        payload = json.loads(command[3])
        assert payload["userId"] == "alice"
        assert payload["sessionId"] == "session-1"

    def test_raises_when_redis_write_fails(self):
        try:
            _run(
                store_image_in_redis(
                    _FailingRedis(),
                    "aGVsbG8=",
                    "image/png",
                    "prompt",
                )
            )
        except redis.RedisError as exc:
            assert "write failed" in str(exc)
        else:
            raise AssertionError("expected RedisError")


# ---------------------------------------------------------------------------
# parse_stored_vtt — pure validation/ownership of a stored transcript record
# ---------------------------------------------------------------------------


def _vtt_record(**overrides) -> dict:
    record = {
        "id": "abc123",
        "data": "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alice>Hi</v>",
        "mimeType": "text/vtt",
        "filename": "meeting.vtt",
        "size": 42,
        "createdAt": 1,
        "sessionId": "sess-1",
        "userId": "brandon",
    }
    record.update(overrides)
    return record


class TestParseStoredVtt:
    def test_none_returns_not_found_error(self):
        text, err = parse_stored_vtt(None, "brandon")
        assert text is None
        assert "not found" in err.lower()

    def test_owner_match_returns_transcript(self):
        text, err = parse_stored_vtt(json.dumps(_vtt_record()), "brandon")
        assert err is None
        assert "WEBVTT" in text

    def test_redisjson_list_shape_is_unwrapped(self):
        # JSON.GET key $ returns a single-element list.
        text, err = parse_stored_vtt(json.dumps([_vtt_record()]), "brandon")
        assert err is None
        assert "WEBVTT" in text

    def test_owner_mismatch_is_rejected(self):
        text, err = parse_stored_vtt(json.dumps(_vtt_record()), "someone_else")
        assert text is None
        assert "different authenticated user" in err

    def test_owned_record_requires_matching_user(self):
        # An owned transcript cannot be read with no authenticated user.
        text, err = parse_stored_vtt(json.dumps(_vtt_record()), None)
        assert text is None
        assert "different authenticated user" in err

    def test_unowned_record_is_capability_scoped(self):
        # No stored userId -> the unguessable key itself is the capability.
        record = _vtt_record()
        record.pop("userId")
        text, err = parse_stored_vtt(json.dumps(record), "anyone")
        assert err is None
        assert "WEBVTT" in text

    def test_empty_data_is_rejected(self):
        text, err = parse_stored_vtt(json.dumps(_vtt_record(data="")), "brandon")
        assert text is None
        assert "empty" in err.lower()

    def test_invalid_json_is_reported(self):
        text, err = parse_stored_vtt("not-json{{{", "brandon")
        assert text is None
        assert "parse" in err.lower()

    def test_non_object_is_malformed(self):
        text, err = parse_stored_vtt("5", "brandon")
        assert text is None
        assert "malformed" in err.lower()


# ---------------------------------------------------------------------------
# fetch_vtt_from_redis — key construction + ownership delegation
# ---------------------------------------------------------------------------


class TestFetchVttFromRedis:
    def test_missing_ids_returns_error(self):
        text, err = _run(fetch_vtt_from_redis(_FakeRedis({}), None, "abc", "brandon"))
        assert text is None
        assert "required" in err

        text, err = _run(fetch_vtt_from_redis(_FakeRedis({}), "sess", None, "brandon"))
        assert text is None
        assert "required" in err

    def test_fetches_session_scoped_key(self):
        key = "vtt:sess-1:abc123"
        fake = _FakeRedis({key: json.dumps(_vtt_record())})
        text, err = _run(fetch_vtt_from_redis(fake, "sess-1", "abc123", "brandon"))
        assert err is None
        assert "WEBVTT" in text
        assert fake.requested_keys == [key]

    def test_not_found_returns_error(self):
        text, err = _run(
            fetch_vtt_from_redis(_FakeRedis({}), "sess-1", "missing", "brandon")
        )
        assert text is None
        assert "not found" in err.lower()

    def test_redis_error_is_handled(self):
        text, err = _run(
            fetch_vtt_from_redis(_FailingRedis(), "sess-1", "abc123", "brandon")
        )
        assert text is None
        assert "unavailable" in err.lower()
