"""HTTP transports and redirect handling for caller-influenced public URLs.

URL validation before a request is not sufficient for SSRF protection because
the HTTP client normally performs a second DNS lookup when it opens the socket.
An attacker can return a public address during validation and a private address
during connection.  The transports in this module resolve once, reject the
entire answer set if it contains a non-public address, and connect to one of the
validated IP addresses.  TLS still receives the original hostname from
``httpcore``, preserving SNI and certificate verification.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import Any
from urllib.parse import urljoin

import httpcore
import httpx

from .url_guard import UnsafeURLError, resolve_public_addresses, validate_public_url

_DEFAULT_MAX_REDIRECTS = 10


class _PinnedPublicSyncBackend(httpcore.NetworkBackend):
    def __init__(self, backend: httpcore.NetworkBackend | None = None) -> None:
        self._backend = backend or httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.NetworkStream:
        addresses = resolve_public_addresses(host)
        return self._backend.connect_tcp(
            addresses[0],
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.NetworkStream:
        raise UnsafeURLError("Unix socket HTTP connections are not allowed.")

    def sleep(self, seconds: float) -> None:
        self._backend.sleep(seconds)


class _PinnedPublicAsyncBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, backend: httpcore.AsyncNetworkBackend | None = None) -> None:
        self._backend = backend or httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        addresses = await asyncio.to_thread(resolve_public_addresses, host)
        return await self._backend.connect_tcp(
            addresses[0],
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(
        self, *args: Any, **kwargs: Any
    ) -> httpcore.AsyncNetworkStream:
        raise UnsafeURLError("Unix socket HTTP connections are not allowed.")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class PublicHTTPTransport(httpx.HTTPTransport):
    """A direct HTTP transport that pins connections to validated public IPs."""

    def __init__(
        self,
        *,
        verify: bool = True,
        limits: httpx.Limits = httpx.Limits(),
    ) -> None:
        super().__init__(verify=verify, trust_env=False, limits=limits)
        self._pool = httpcore.ConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=verify, trust_env=False),
            max_connections=limits.max_connections,
            max_keepalive_connections=limits.max_keepalive_connections,
            keepalive_expiry=limits.keepalive_expiry,
            network_backend=_PinnedPublicSyncBackend(),
        )


class PublicAsyncHTTPTransport(httpx.AsyncHTTPTransport):
    """An async transport that pins connections to validated public IPs."""

    def __init__(
        self,
        *,
        verify: bool = True,
        limits: httpx.Limits = httpx.Limits(),
    ) -> None:
        super().__init__(verify=verify, trust_env=False, limits=limits)
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=verify, trust_env=False),
            max_connections=limits.max_connections,
            max_keepalive_connections=limits.max_keepalive_connections,
            keepalive_expiry=limits.keepalive_expiry,
            network_backend=_PinnedPublicAsyncBackend(),
        )


def get_public_response(
    client: httpx.Client,
    url: str,
    *,
    allowed_schemes: Iterable[str] = ("http", "https"),
    max_redirects: int = _DEFAULT_MAX_REDIRECTS,
) -> httpx.Response:
    """Fetch a public URL and validate every redirect before following it."""
    current_url = url
    schemes = tuple(allowed_schemes)
    for _ in range(max_redirects + 1):
        validate_public_url(current_url, allowed_schemes=schemes, check_dns=True)
        response = client.get(current_url)
        if response.is_redirect is not True:
            return response
        location = response.headers.get("location")
        if not location:
            return response
        current_url = urljoin(current_url, location)

    raise UnsafeURLError(
        f"Exceeded maximum of {max_redirects} redirects while fetching '{url}'."
    )


async def get_public_response_async(
    client: httpx.AsyncClient,
    url: str,
    *,
    allowed_schemes: Iterable[str] = ("http", "https"),
    max_redirects: int = _DEFAULT_MAX_REDIRECTS,
) -> httpx.Response:
    """Fetch a public URL and validate every redirect before following it."""
    current_url = url
    schemes = tuple(allowed_schemes)
    for _ in range(max_redirects + 1):
        validate_public_url(current_url, allowed_schemes=schemes, check_dns=True)
        response = await client.get(current_url)
        if response.is_redirect is not True:
            return response
        location = response.headers.get("location")
        if not location:
            return response
        current_url = urljoin(current_url, location)

    raise UnsafeURLError(
        f"Exceeded maximum of {max_redirects} redirects while fetching '{url}'."
    )
