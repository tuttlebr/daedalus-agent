"""Export public-address policy and trust roots from the retained Python image.

Run with network disabled. These are offline classification/header fixtures;
the separate transport gate exercises real DNS, TCP and TLS connections.
"""

import argparse
import hashlib
import importlib.metadata
import ipaddress
import json
import random
from pathlib import Path

import certifi
import httpx
from nat_helpers.safe_http import _check_response_size
from nat_helpers.url_guard import _ip_is_public


def export(root):
    policies, addresses = {}, set()
    for version, cls in [(4, ipaddress.IPv4Address), (6, ipaddress.IPv6Address)]:
        bits = 32 if version == 4 else 128
        constants = cls._constants
        groups = {
            "private": constants._private_networks,
            "exceptions": constants._private_networks_exceptions,
            "denied": (
                [
                    ipaddress.ip_network("100.64.0.0/10"),
                    constants._multicast_network,
                    constants._reserved_network,
                ]
                if version == 4
                else [
                    *constants._reserved_networks,
                    constants._sitelocal_network,
                    constants._multicast_network,
                ]
            ),
        }
        policies[str(version)] = {
            key: [str(network) for network in networks]
            for key, networks in groups.items()
        }
        for networks in groups.values():
            for network in networks:
                start, end = (
                    int(network.network_address),
                    int(network.broadcast_address),
                )
                for number in [
                    start - 1,
                    start,
                    start + 1,
                    (start + end) // 2,
                    end,
                    end + 1,
                ]:
                    if 0 <= number < 2**bits:
                        addresses.add(str(cls(number)))
        # Deterministic address samples, never secrets or security tokens.
        rng = random.Random(20261014 + version)  # nosec B311
        addresses.update(str(cls(rng.getrandbits(bits))) for _ in range(64))
    addresses.update(
        [
            "",
            "invalid",
            "8.8.8.8",
            "1.1.1.1",
            "127.1",
            "0177.0.0.1",
            "0x7f000001",
            "2130706433",
            "8.8.8.8%lo",
            " 8.8.8.8",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "::ffff:127.0.0.1",
            "2001:4860::1%lo",
            "2001:4860::1%",
            "2001:4860::1%a%b",
            "fe80::1%lo",
        ]
    )
    pem = Path(certifi.where()).read_bytes()
    distribution = importlib.metadata.distribution("certifi")
    license_file = next(
        path for path in distribution.files if str(path).endswith("/LICENSE")
    )
    resource = {
        "baseline_image": "daedalus:milvus-retry-check",
        "baseline_digest": "sha256:a741ebc7aca8d6654e1892b38f32133ee53940a3ff292e461cd78424c0d0e5e7",
        "certifi_version": distribution.version,
        "certifi_sha256": hashlib.sha256(pem).hexdigest(),
        "address_policy": policies,
    }
    headers = []
    for limit in [1, 16, 2097152]:
        for values in [
            {},
            {"Content-Encoding": "identity"},
            {"Content-Encoding": " IDENTITY "},
            {"Content-Encoding": ""},
            {"Content-Encoding": "gzip"},
            {"Content-Encoding": "identity, identity"},
            {"Content-Encoding": "br"},
            *(
                {"Content-Length": length}
                for length in [
                    "",
                    "0",
                    "1",
                    "16",
                    "17",
                    "2097152",
                    "2097153",
                    "00017",
                    " 17",
                    "+17",
                    "-1",
                    "17.0",
                    "17, 17",
                    "9" * 40,
                ]
            ),
        ]:
            response = httpx.Response(200, headers=values)
            try:
                _check_response_size(response, limit)
                expected = {"ok": True}
            except Exception as error:
                expected = {"error": type(error).__name__, "message": str(error)}
            headers.append(
                {
                    "headers": dict(response.headers),
                    "limit": limit,
                    "expected": expected,
                }
            )
    fixtures = {
        "addresses": [
            {"ip": value, "public": _ip_is_public(value)} for value in sorted(addresses)
        ],
        "headers": headers,
    }
    (root / "resources/public-http.json").write_text(
        json.dumps(resource, indent=2) + "\n"
    )
    (root / "resources/public-ca.pem").write_bytes(pem)
    (root / "notices/certifi.txt").write_bytes(
        distribution.locate_file(license_file).read_bytes()
    )
    (root / "tests/fixtures/public-http.json").write_text(
        json.dumps(fixtures, indent=2) + "\n"
    )
    print({name: len(value) for name, value in fixtures.items()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
