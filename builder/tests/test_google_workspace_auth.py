"""Saved-grant compatibility and isolated OAuth flows without a toolkit."""

import asyncio
import base64
import json
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from daedalus_runtime.oauth import GoogleOAuth, decode_grant, token_key

CONFIG = {
    "server_url": "https://docsmcp.googleapis.com/mcp/v1",
    "client_id": "fixture-client",
    "client_secret": "fixture-secret",
    "redirect_uri": "https://app.test/api/auth/redirect",
    "scopes": ["https://www.googleapis.com/auth/drive"],
}


class Redis:
    def __init__(self):
        self.values = {}
        self.locks = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value):
        self.values[key] = value

    async def delete(self, key):
        return self.values.pop(key, None) is not None

    def lock(self, key, **_kwargs):
        return self.locks.setdefault(key, asyncio.Lock())


def test_legacy_grants_are_decoded_without_changing_identity_or_losing_refresh_token():
    legacy = {
        "credentials": [{"token": "saved-access"}],
        "raw": {"refresh_token": "saved-refresh", "scope": "drive"},
        "token_expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    }
    stored = json.dumps(
        {"data": base64.urlsafe_b64encode(json.dumps(legacy).encode()).decode()}
    )
    grant = decode_grant(stored)
    assert grant["access_token"] == "saved-access"
    assert grant["refresh_token"] == "saved-refresh"
    assert grant["expires_at"] > time.time()
    assert token_key("docs", "alice") != token_key("docs", "bob")
    assert token_key("docs", "alice") != token_key("gmail", "alice")
    assert token_key("docs", "alice").startswith(
        "nat/object_store/docs-mcp-oauth-drive/tokens/"
    )


def test_refresh_preserves_grants_through_transient_failure():
    async def run():
        store = Redis()
        key = token_key("docs", "alice")
        responses = [
            httpx.Response(
                200, json={"access_token": "new-access", "expires_in": 3600}
            ),
            httpx.Response(503, json={"error": "temporarily_unavailable"}),
        ]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: responses.pop(0))
        ) as http:
            oauth = GoogleOAuth(store, http)
            await store.set(
                key,
                json.dumps(
                    {
                        "version": 2,
                        "access_token": "old",
                        "refresh_token": "saved-refresh",
                        "expires_at": 0,
                    }
                ),
            )
            assert await oauth.access_token("alice", CONFIG) == "new-access"
            saved = decode_grant(await store.get(key))
            assert saved["refresh_token"] == "saved-refresh"
            await oauth.invalidate_access("alice", CONFIG, "old")
            assert decode_grant(await store.get(key))["expires_at"] > time.time()
            await oauth.invalidate_access("alice", CONFIG, "new-access")
            before = await store.get(key)
            with pytest.raises(RuntimeError, match="temporarily unavailable"):
                await oauth.access_token("alice", CONFIG)
            assert await store.get(key) == before

    asyncio.run(run())


def test_browser_authorizations_have_independent_one_use_states_and_pkce():
    async def run():
        store = Redis()
        emitted = asyncio.Queue()

        def token_response(request):
            data = parse_qs(request.content.decode())
            assert data["code_verifier"][0]
            return httpx.Response(
                200,
                json={
                    "access_token": "access-" + data["code"][0],
                    "refresh_token": "refresh-" + data["code"][0],
                    "expires_in": 3600,
                },
            )

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(token_response)
        ) as http:
            oauth = GoogleOAuth(store, http)

            async def emit(event, data):
                assert event == "oauth_required"
                await emitted.put(data)

            first = asyncio.create_task(oauth.access_token("alice", CONFIG, emit))
            alice = await emitted.get()
            second = asyncio.create_task(oauth.access_token("bob", CONFIG, emit))
            bob = await emitted.get()
            assert alice["oauth_state"] != bob["oauth_state"]
            params = parse_qs(urlsplit(alice["auth_url"]).query)
            assert params["access_type"] == ["offline"]
            assert params["code_challenge_method"] == ["S256"]
            assert params["include_granted_scopes"] == ["true"]
            oauth.callback(bob["oauth_state"], "bob-code")
            assert await second == "access-bob-code"
            assert not first.done()
            oauth.callback(alice["oauth_state"], "alice-code")
            assert await first == "access-alice-code"
            assert not oauth.pending
            assert await oauth.reset("docs", "alice")
            assert await store.get(token_key("docs", "alice")) is None
            assert await store.get(token_key("docs", "bob")) is not None

    asyncio.run(run())
