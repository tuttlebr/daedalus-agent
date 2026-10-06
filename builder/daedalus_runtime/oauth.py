"""User-scoped Google OAuth, with durable grants and legacy-store migration.

The old Redis key derivation is a data compatibility contract only. No toolkit
code is imported. New grants use our versioned format at the same key so the
frontend's presence-only connection check continues to work.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlencode
from weakref import WeakValueDictionary

import httpx
from fastapi import HTTPException

BUCKETS = {
    "gmail": "gmail-mcp-oauth-ro",
    "calendar": "calendar-mcp-oauth-rw",
    "docs": "docs-mcp-oauth-drive",
}
AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # nosec B105


def token_key(service: str, user: str) -> str:
    session = "daedalus-user-" + hashlib.sha256(user.encode()).hexdigest()[:32]
    namespace = uuid.uuid5(uuid.NAMESPACE_DNS, "nemo-agent-toolkit")
    legacy_user = str(uuid.uuid5(namespace, session))
    digest = hashlib.sha256(legacy_user.encode()).hexdigest()
    return f"nat/object_store/{BUCKETS[service]}/tokens/{digest}"


def decode_grant(value: str | bytes) -> dict:
    grant = json.loads(value)
    if grant.get("version") == 2:
        return grant
    # ObjectStoreItem encoded its AuthResult bytes using base64url.
    payload = grant["data"]
    legacy = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    raw = legacy.get("raw", {})
    access = next(
        (item["token"] for item in legacy.get("credentials", []) if "token" in item), ""
    )
    expiry = legacy.get("token_expires_at")
    return {
        "version": 2,
        "access_token": access,
        "refresh_token": raw.get("refresh_token", ""),
        "scope": raw.get("scope", ""),
        "expires_at": datetime.fromisoformat(expiry.replace("Z", "+00:00")).timestamp()
        if expiry
        else 0,
    }


@dataclass
class PendingAuthorization:
    future: asyncio.Future
    created: float


class GoogleOAuth:
    def __init__(self, redis, http: httpx.AsyncClient):
        self.redis = redis
        self.http = http
        self.pending: dict[str, PendingAuthorization] = {}
        self.locks: WeakValueDictionary = WeakValueDictionary()

    @staticmethod
    def service(config: dict) -> str:
        url = str(config.get("server_url", ""))
        for service in BUCKETS:
            if url in {
                f"https://{service}mcp.googleapis.com/mcp",
                f"https://{service}mcp.googleapis.com/mcp/v1",
            }:
                return service
        raise ValueError("Unsupported OAuth resource")

    async def _save_token(
        self, key: str, token: dict, previous: dict | None = None
    ) -> str:
        previous = previous or {}
        access = token.get("access_token")
        if not isinstance(access, str) or not access:
            raise RuntimeError("OAuth response has no access token")
        grant = {
            "version": 2,
            "access_token": access,
            "refresh_token": token.get("refresh_token")
            or previous.get("refresh_token", ""),
            "scope": token.get("scope") or previous.get("scope", ""),
            "expires_at": time.time() + float(token.get("expires_in", 3600)),
        }
        await self.redis.set(key, json.dumps(grant))
        return access

    async def access_token(self, user: str, config: dict, emit=None) -> str | None:
        service = self.service(config)
        key = token_key(service, user)
        async with self.locks.setdefault(key, asyncio.Lock()):
            # Redis serializes refreshes across replicas. Never hold this lock
            # while waiting for a person to complete browser authorization.
            async with self.redis.lock(
                key + "/refresh-lock", timeout=40, blocking_timeout=35
            ):
                raw = await self.redis.get(key)
                saved = decode_grant(raw) if raw else None
                if (
                    saved
                    and saved.get("access_token")
                    and saved.get("expires_at", 0) > time.time() + 60
                ):
                    return saved["access_token"]
                if saved and saved.get("refresh_token"):
                    response = await self.http.post(
                        TOKEN_URL,
                        data={
                            "grant_type": "refresh_token",
                            "refresh_token": saved["refresh_token"],
                            "client_id": config["client_id"],
                            "client_secret": config["client_secret"],
                            "resource": config["server_url"],
                        },
                    )
                    token = response.json()
                    if response.is_success:
                        return await self._save_token(key, token, saved)
                    if (
                        response.status_code == 400
                        and token.get("error") == "invalid_grant"
                    ):
                        await self.redis.delete(key)
                    else:
                        # Preserve offline grants through temporary outages.
                        raise RuntimeError(
                            "Google token refresh is temporarily unavailable"
                        )
            if emit is None:
                return None
            if not all(
                config.get(field)
                for field in ("client_id", "client_secret", "redirect_uri")
            ):
                raise RuntimeError("Google OAuth is not configured")
            if len(self.pending) >= 128:
                raise RuntimeError("OAuth capacity reached")
            state = secrets.token_urlsafe(32)
            verifier = secrets.token_urlsafe(64)
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
                .decode()
                .rstrip("=")
            )
            future = asyncio.get_running_loop().create_future()
            self.pending[state] = PendingAuthorization(future, time.monotonic())
            params = {
                "response_type": "code",
                "client_id": config["client_id"],
                "resource": config["server_url"],
                "redirect_uri": config["redirect_uri"],
                "scope": " ".join(config.get("scopes", [])),
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "access_type": "offline",
                "include_granted_scopes": "true",
                "prompt": "consent",
            }
            try:
                await emit(
                    "oauth_required",
                    {
                        "auth_url": AUTHORIZE_URL + "?" + urlencode(params),
                        "oauth_state": state,
                    },
                )
                code = await asyncio.wait_for(future, timeout=600)
                response = await self.http.post(
                    TOKEN_URL,
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "code_verifier": verifier,
                        "client_id": config["client_id"],
                        "client_secret": config["client_secret"],
                        "resource": config["server_url"],
                        "redirect_uri": config["redirect_uri"],
                    },
                )
                if not response.is_success:
                    raise RuntimeError("Google authorization could not be completed")
                return await self._save_token(key, response.json())
            finally:
                self.pending.pop(state, None)

    def callback(self, state: str, code: str | None, error: str | None = None) -> None:
        pending = self.pending.get(state)
        if (
            pending is None
            or pending.future.done()
            or time.monotonic() - pending.created > 600
        ):
            raise HTTPException(400, "OAuth state is missing, expired, or already used")
        if error or not code:
            pending.future.set_exception(
                RuntimeError("Google authorization was declined")
            )
        else:
            pending.future.set_result(code)

    async def invalidate_access(self, user: str, config: dict, rejected: str) -> None:
        key = token_key(self.service(config), user)
        async with self.redis.lock(
            key + "/refresh-lock", timeout=40, blocking_timeout=35
        ):
            raw = await self.redis.get(key)
            if raw:
                grant = decode_grant(raw)
                if grant.get("access_token") == rejected:
                    grant["expires_at"] = 0
                    await self.redis.set(key, json.dumps(grant))

    async def reset(self, service: str, user: str) -> bool:
        if service not in BUCKETS:
            raise HTTPException(404, "Unknown Google Workspace service")
        key = token_key(service, user)
        lock = self.locks.setdefault(key, asyncio.Lock())
        if lock.locked():
            raise HTTPException(
                409, "Authorization is in use; wait for the current operation to finish"
            )
        async with lock:
            async with self.redis.lock(
                key + "/refresh-lock", timeout=40, blocking_timeout=35
            ):
                return bool(await self.redis.delete(key))

    async def close(self):
        for pending in self.pending.values():
            pending.future.cancel()
