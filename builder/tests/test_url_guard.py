"""Tests for the SSRF egress guard (F-001)."""

import socket

import pytest
from nat_helpers.url_guard import UnsafeURLError, validate_public_url


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
