"""Tests for the SSRF egress guard (F-001)."""

import socket
from types import SimpleNamespace

import pytest
from nat_helpers.safe_http import _PinnedPublicSyncBackend, get_public_response
from nat_helpers.url_guard import (
    UnsafeURLError,
    resolve_public_addresses,
    validate_public_url,
)


class TestValidatePublicURL:
    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "gopher://internal/",
            "ftp://example.com/x",
            "",
            "https://",
        ],
    )
    def test_disallowed_scheme_or_missing_host(self, url):
        with pytest.raises(UnsafeURLError):
            validate_public_url(url, check_dns=False)

    @pytest.mark.parametrize(
        "url",
        [
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata
            "http://127.0.0.1:6379/",  # loopback (Redis)
            "http://10.0.0.5/",  # RFC1918
            "http://192.168.1.1/",
            "http://172.16.0.1/",
            "http://[::1]/",  # IPv6 loopback
        ],
    )
    def test_literal_internal_ip_blocked(self, url):
        with pytest.raises(UnsafeURLError):
            validate_public_url(url, check_dns=False)

    def test_public_literal_ip_allowed(self):
        assert (
            validate_public_url("http://8.8.8.8/", check_dns=False) == "http://8.8.8.8/"
        )

    def test_hostname_allowed_without_dns(self):
        # Scheme/literal checks only; the network policy covers the resolved case.
        assert validate_public_url("https://example.com/path", check_dns=False)

    def test_hostname_resolving_internal_blocked(self, monkeypatch):
        def _fake_gai(host, *args, **kwargs):
            return [(socket.AF_INET, None, None, "", ("169.254.169.254", 0))]

        monkeypatch.setattr(socket, "getaddrinfo", _fake_gai)
        with pytest.raises(UnsafeURLError):
            validate_public_url("http://rebind.example/", check_dns=True)

    def test_hostname_resolving_public_allowed(self, monkeypatch):
        def _fake_gai(host, *args, **kwargs):
            return [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))]

        monkeypatch.setattr(socket, "getaddrinfo", _fake_gai)
        assert validate_public_url("https://example.com/", check_dns=True)

    def test_mixed_public_private_dns_answer_fails_closed(self, monkeypatch):
        monkeypatch.setattr(
            socket,
            "getaddrinfo",
            lambda *_args, **_kwargs: [
                (socket.AF_INET, None, None, "", ("93.184.216.34", 0)),
                (socket.AF_INET, None, None, "", ("10.0.0.4", 0)),
            ],
        )

        with pytest.raises(UnsafeURLError, match="non-public"):
            resolve_public_addresses("mixed.example")


class TestPinnedPublicTransport:
    def test_dns_rebinding_between_validation_and_connect_fails_closed(
        self, monkeypatch
    ):
        answers = iter(("93.184.216.34", "127.0.0.1"))

        def _resolve(*_args, **_kwargs):
            return [(socket.AF_INET, None, None, "", (next(answers), 0))]

        class _Backend:
            def connect_tcp(self, *_args, **_kwargs):
                raise AssertionError("a private address must never reach connect_tcp")

        monkeypatch.setattr(socket, "getaddrinfo", _resolve)

        assert validate_public_url("https://rebind.example", check_dns=True)
        with pytest.raises(UnsafeURLError, match="non-public"):
            _PinnedPublicSyncBackend(_Backend()).connect_tcp("rebind.example", 443)

    def test_connection_uses_the_validated_ip_without_second_dns_lookup(
        self, monkeypatch
    ):
        lookups = []

        def _resolve(host, *_args, **_kwargs):
            lookups.append(host)
            return [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))]

        class _Backend:
            def __init__(self):
                self.connected_host = None

            def connect_tcp(self, host, *_args, **_kwargs):
                self.connected_host = host
                return SimpleNamespace()

        monkeypatch.setattr(socket, "getaddrinfo", _resolve)
        backend = _Backend()

        _PinnedPublicSyncBackend(backend).connect_tcp("public.example", 443)

        assert lookups == ["public.example"]
        assert backend.connected_host == "93.184.216.34"

    def test_redirect_target_is_validated_before_fetch(self, monkeypatch):
        class _Client:
            def __init__(self):
                self.urls = []

            def get(self, url):
                self.urls.append(url)
                return SimpleNamespace(
                    is_redirect=True,
                    headers={"location": "http://169.254.169.254/metadata"},
                )

        monkeypatch.setattr(
            socket,
            "getaddrinfo",
            lambda *_args, **_kwargs: [
                (socket.AF_INET, None, None, "", ("93.184.216.34", 0))
            ],
        )
        client = _Client()

        with pytest.raises(UnsafeURLError, match="non-public"):
            get_public_response(client, "https://public.example/start")

        assert client.urls == ["https://public.example/start"]
