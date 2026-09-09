"""Compare actual URL validation with a frozen, independently derived oracle."""

import gzip
import json
import socket
from pathlib import Path

import pytest
from nat_helpers.url_guard import UnsafeURLError, resolve_public_addresses

REFERENCE = json.loads(
    gzip.decompress(
        (
            Path(__file__).resolve().parents[2]
            / "test-fixtures"
            / "code-audit-independent-20260909.json.gz"
        ).read_bytes()
    )
)


@pytest.mark.parametrize(
    "case", REFERENCE["addresses"]["classifications"], ids=lambda row: row["address"]
)
def test_independent_address_classification(case):
    if case["allowed"]:
        assert resolve_public_addresses(case["address"]) == (case["address"],)
    else:
        with pytest.raises(UnsafeURLError):
            resolve_public_addresses(case["address"])


@pytest.mark.parametrize("case", REFERENCE["addresses"]["dns_answers"])
def test_independent_dns_answer_set(case, monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (
                socket.AF_INET6 if ":" in address else socket.AF_INET,
                None,
                None,
                "",
                (address, 0),
            )
            for address in case["addresses"]
        ],
    )
    if case["allowed"]:
        assert resolve_public_addresses("independent.invalid") == tuple(
            case["addresses"]
        )
    else:
        with pytest.raises(UnsafeURLError):
            resolve_public_addresses("independent.invalid")
