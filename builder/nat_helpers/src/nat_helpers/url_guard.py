"""SSRF egress guard for tools that fetch caller-influenced URLs (F-001).

Defense-in-depth alongside the cluster network policy (Cilium). The network
policy blocks RFC1918 and (with the link-local ``except``) the cloud-metadata
range; this guard additionally rejects:

  * non-http(s) schemes (e.g. ``file://``, ``gopher://``) that the network layer
    cannot see — this is what closes local-file reads via a poisoned URL, and
  * literal internal-IP targets (127.0.0.1, 169.254.169.254, RFC1918, ...).

With ``check_dns=True`` it also resolves a hostname and rejects it if any
returned address is non-public. Fetching call sites pair this with the pinned
transports in ``nat_helpers.safe_http`` so the validated result is the address
used for the connection. ``check_dns=False`` is reserved for isolated tests.
"""

import ipaddress
import socket
from urllib.parse import urlparse

_ALLOWED_SCHEMES = frozenset({"http", "https"})


class UnsafeURLError(ValueError):
    """Raised when a URL targets a disallowed scheme or non-public address."""


def _ip_is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local  # 169.254.0.0/16 (cloud metadata), fe80::/10
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def resolve_public_addresses(host: str) -> tuple[str, ...]:
    """Resolve *host* and return only an entirely public address set.

    Mixed public/private DNS answers fail closed. Callers can safely pin a TCP
    connection to the first returned address because every candidate has been
    validated from the same resolution result.
    """
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None

    if literal is not None:
        if not _ip_is_public(host):
            raise UnsafeURLError(f"URL host '{host}' is a non-public address.")
        return (host,)

    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeURLError(f"Could not resolve host '{host}': {exc}") from exc

    addresses = tuple(dict.fromkeys(info[4][0] for info in infos))
    if not addresses:
        raise UnsafeURLError(f"Host '{host}' did not resolve to any address.")
    for ip in addresses:
        if not _ip_is_public(ip):
            raise UnsafeURLError(
                f"URL host '{host}' resolves to a non-public address ({ip})."
            )
    return addresses


def validate_public_url(
    url: str,
    *,
    allowed_schemes=_ALLOWED_SCHEMES,
    check_dns: bool = True,
) -> str:
    """Validate the scheme and target address of a caller-influenced URL.

    Raises ``UnsafeURLError`` for a disallowed scheme, a missing host, a literal
    internal IP, or (when ``check_dns``) a hostname that resolves to any
    non-public address. Returns the URL unchanged when it is safe to fetch.
    """
    if not url or not isinstance(url, str):
        raise UnsafeURLError("No URL supplied.")

    parsed = urlparse(url.strip())
    scheme = (parsed.scheme or "").lower()
    if scheme not in allowed_schemes:
        raise UnsafeURLError(f"URL scheme '{parsed.scheme}' is not allowed.")

    host = parsed.hostname
    if not host:
        raise UnsafeURLError("URL is missing a host.")

    if not check_dns:
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None and not _ip_is_public(host):
            raise UnsafeURLError(f"URL host '{host}' is a non-public address.")
        return url

    resolve_public_addresses(host)
    return url
