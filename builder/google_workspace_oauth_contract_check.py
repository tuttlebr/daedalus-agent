"""Offline behavioral checks against the actual pinned NAT/Authlib runtime.

Only the HTTPS token endpoint is replaced. The provider, HTTP auth adapter,
OAuth request encoding, secret types and persisted token serialization are real.
Run directly or as part of runtime_contract_check.py during the image build.
"""

import asyncio
import secrets
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx
import mcp_patches
from authlib.integrations.httpx_client import AsyncOAuth2Client
from nat.authentication.oauth2.oauth2_auth_code_flow_provider import (
    OAuth2AuthCodeFlowProvider,
)
from nat.authentication.oauth2.oauth2_auth_code_flow_provider_config import (
    OAuth2AuthCodeFlowProviderConfig,
)
from nat.authentication.token_storage import InMemoryTokenStorage
from nat.builder.context import Context
from nat.data_models.authentication import (
    AuthenticatedContext,
    AuthResult,
    BearerTokenCred,
)
from nat.plugins.mcp.client.client_base import AuthAdapter
from pydantic import SecretStr


def _require(condition):
    """Keep build gates active even when Python is run with optimization."""
    if not condition:
        raise RuntimeError("Google Workspace OAuth runtime contract failed")


async def check_google_workspace_oauth():
    client_secret = secrets.token_urlsafe(24)
    mcp_patches._patch_google_workspace_oauth_authorization_parameters()
    mcp_patches._patch_google_workspace_oauth_refresh()
    mcp_patches._patch_mcp_auth_context_propagation()
    endpoint_responses = []
    requests = []
    consents = []

    def token_endpoint(request):
        _require(str(request.url) == "https://oauth2.googleapis.com/token")
        form = parse_qs(request.content.decode())
        _require(form["grant_type"] == ["refresh_token"])
        _require(form["client_secret"] == [client_secret])
        _require("authorization" not in request.headers)
        requests.append(form)
        response = endpoint_responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return httpx.Response(response[0], json=response[1])

    def client(**kwargs):
        return AsyncOAuth2Client(
            **kwargs, transport=httpx.MockTransport(token_endpoint)
        )

    async def consent(config, _method):
        _require(config.authorization_kwargs["access_type"] == "offline")
        _require(config.authorization_kwargs["prompt"] == "consent")
        consents.append(config.authorization_kwargs["resource"])
        return AuthenticatedContext(
            headers={"Authorization": "Bearer consent-access"},
            metadata={
                "expires_at": datetime.now(UTC) + timedelta(hours=1),
                "raw_token": {"refresh_token": "consent-refresh"},
            },
        )

    def provider(service, storage):
        return OAuth2AuthCodeFlowProvider(
            # OAuth method identifiers are not passwords (Bandit B106).
            OAuth2AuthCodeFlowProviderConfig(  # nosec B106
                client_id="contract-client",
                client_secret=client_secret,
                authorization_url="https://accounts.google.com/o/oauth2/v2/auth",
                token_url=mcp_patches._GOOGLE_OAUTH_TOKEN_URL,
                token_endpoint_auth_method="client_secret_post",
                redirect_uri="https://example.test/auth/redirect",
                authorization_kwargs={
                    "resource": f"https://{service}mcp.googleapis.com/mcp"
                },
            ),
            token_storage=storage,
        )

    def saved(refresh="saved-refresh", expired=True):
        return AuthResult(
            credentials=[BearerTokenCred(token=SecretStr("old-access"))],
            token_expires_at=datetime.now(UTC) + timedelta(hours=-1 if expired else 1),
            raw={"refresh_token": refresh, "scope": "contract-scope"}
            if refresh
            else {},
        )

    with (
        patch("authlib.integrations.httpx_client.AsyncOAuth2Client", client),
        Context.scope(user_auth_callback=consent),
    ):
        for service in ("gmail", "calendar", "docs"):
            storage = InMemoryTokenStorage()
            await storage.store("alice", saved())
            await storage.store("bob", saved("bob-refresh"))
            # Reconstruct the provider twice, simulating a backend restart with
            # the same durable, serialized token store. Google omits refresh_token.
            for generation in range(2):
                current = provider(service, storage)
                endpoint_responses.append(
                    (
                        200,
                        {
                            "access_token": f"new-{generation}",
                            "expires_in": 3600,
                            "token_type": "Bearer",
                        },
                    )
                )
                refreshed = await current.authenticate(user_id="alice")
                _require(refreshed.raw["refresh_token"] == "saved-refresh")
                _require(refreshed.raw["scope"] == "contract-scope")
                count = len(requests)
                _require(await current.authenticate(user_id="alice") == refreshed)
                _require(len(requests) == count)
                await storage.store(
                    "alice",
                    refreshed.model_copy(
                        update={"token_expires_at": datetime.fromtimestamp(0, UTC)}
                    ),
                )
            _require(
                (await storage.retrieve("bob")).raw["refresh_token"] == "bob-refresh"
            )
            _require(not consents)

            # The real AuthAdapter must silently recover a rejected access token
            # even when an interactive callback has not been bound to the client.
            await storage.store("alice", saved(expired=False))
            adapter = AuthAdapter(current, "alice")
            request = httpx.Request(
                "POST",
                f"https://{service}mcp.googleapis.com/mcp/v1",
                headers={"Authorization": "Bearer old-access"},
            )
            endpoint_responses.append(
                (
                    200,
                    {
                        "access_token": "rotated-access",
                        "expires_in": 3600,
                        "refresh_token": "rotated-refresh",
                    },
                )
            )
            resource_requests = []

            def protected_resource(req):
                resource_requests.append(req.headers["Authorization"])
                return httpx.Response(
                    200
                    if req.headers["Authorization"] == "Bearer rotated-access"
                    else 401
                )

            async with httpx.AsyncClient(
                auth=adapter, transport=httpx.MockTransport(protected_resource)
            ) as resource_client:
                _require((await resource_client.post(request.url)).status_code == 200)
            _require(
                resource_requests == ["Bearer old-access", "Bearer rotated-access"]
            )
            _require(
                (await storage.retrieve("alice")).raw["refresh_token"]
                == "rotated-refresh"
            )
            # A delayed rejection for the old token cannot invalidate the new one.
            _require(
                not await mcp_patches._invalidate_rejected_mcp_oauth_token(
                    adapter, request=request
                )
            )
            _require(not consents)

        # Temporary token endpoint outages must neither delete the offline grant
        # nor call the browser callback. Verify retry exhaustion and recovery.
        current = provider("gmail", InMemoryTokenStorage())
        await current._token_storage.store("alice", saved())
        for response in (
            (503, {"error": "temporarily_unavailable"}),
            (429, {}),
            httpx.ConnectError("contract outage"),
        ):
            endpoint_responses.extend([response, response])
            try:
                await current.authenticate(user_id="alice")
            except RuntimeError as exc:
                _require("temporarily unavailable" in str(exc))
            else:
                raise AssertionError("Outage did not fail the call")
            _require(
                (await current._token_storage.retrieve("alice")).raw["refresh_token"]
                == "saved-refresh"
            )
            _require(not consents)
        endpoint_responses.append(
            (200, {"access_token": "recovered", "expires_in": 3600})
        )
        _require(
            (await current.authenticate(user_id="alice"))
            .credentials[0]
            .token.get_secret_value()
            == "recovered"
        )

        await current._token_storage.store("alice", saved())
        endpoint_responses.append(
            (
                400,
                {
                    "error": "invalid_client",
                    "error_description": "do-not-log-contract-secret",
                },
            )
        )
        try:
            await current.authenticate(user_id="alice")
        except RuntimeError as exc:
            _require("client configuration" in str(exc))
            _require("do-not-log" not in str(exc))
        else:
            raise AssertionError("Invalid client did not fail the call")
        _require(not consents)

        payload = mcp_patches._mcp_tool_error_payload(
            RuntimeError(
                "Google Workspace token refresh was rejected; check the OAuth client configuration"
            ),
            server_name="gmail_mcp_server",
            tool_name="list_messages",
        )
        _require("mcp_user_authentication_required" not in payload)
        _require("google_workspace_refresh_failed" in payload)

        # Exercise the complete HTTP auth flow during an outage. The first
        # anonymous 401 is allowed by NAT, but the retry must preserve the
        # refresh error and must not cause an interactive consent callback.
        endpoint_responses.extend([(503, {})] * 4)
        adapter = AuthAdapter(current, "alice")
        async with httpx.AsyncClient(
            auth=adapter,
            transport=httpx.MockTransport(lambda _req: httpx.Response(401)),
        ) as resource_client:
            try:
                await resource_client.post("https://gmailmcp.googleapis.com/mcp/v1")
            except RuntimeError as exc:
                payload = mcp_patches._mcp_tool_error_payload(
                    exc, server_name="gmail_mcp_server", tool_name="list_messages"
                )
                _require("google_workspace_refresh_unavailable" in payload)
                _require("mcp_user_authentication_required" not in payload)
            else:
                raise AssertionError("Token outage did not propagate through HTTP auth")
        _require(not consents)
        _require(
            (await current._token_storage.retrieve("alice")).raw["refresh_token"]
            == "saved-refresh"
        )

        # Only an absent offline grant or Google's definitive invalid_grant
        # response requires fresh consent; cancellation and outages do not.
        endpoint_responses.append((400, {"error": "invalid_grant"}))
        await current.authenticate(user_id="alice")
        _require(len(consents) == 1)
        await current._token_storage.store("alice", saved(refresh=""))
        await current.authenticate(user_id="alice")
        _require(len(consents) == 2)
        _require(not endpoint_responses)

    print(
        "Google OAuth runtime contract passed: offline consent, repeated refresh, rotation, restart reuse, user isolation, 401 recovery, outages, and revoked grants"
    )


if __name__ == "__main__":
    asyncio.run(check_google_workspace_oauth())
