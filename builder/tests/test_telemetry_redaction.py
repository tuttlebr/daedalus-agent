"""Unit contract for credentials excluded from NAT request metadata."""

import sys
import types

from entrypoint import _patch_request_metadata_redaction


def test_request_attribute_serialization_drops_headers_and_cookies(monkeypatch):
    class RequestAttributes:
        def to_dict(self):
            return {
                "method": "POST",
                "headers": {"authorization": "Bearer secret"},
                "cookies": {"nat-session": "secret"},
            }

    nat = types.ModuleType("nat")
    runtime = types.ModuleType("nat.runtime")
    user_metadata = types.ModuleType("nat.runtime.user_metadata")
    user_metadata.RequestAttributes = RequestAttributes
    monkeypatch.setitem(sys.modules, "nat", nat)
    monkeypatch.setitem(sys.modules, "nat.runtime", runtime)
    monkeypatch.setitem(sys.modules, "nat.runtime.user_metadata", user_metadata)

    _patch_request_metadata_redaction()

    assert RequestAttributes().to_dict() == {"method": "POST"}
