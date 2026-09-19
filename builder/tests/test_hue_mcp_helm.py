"""Validate Hue credential and network access in rendered deployment manifests."""

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).parents[2] / "helm" / "daedalus"
pytestmark = pytest.mark.skipif(not shutil.which("helm"), reason="helm not installed")


@pytest.mark.parametrize("cilium", [True, False])
@pytest.mark.parametrize("namespace,port", [("daedalus", 8000), ("hue", 8800)])
def test_hue_egress_is_scoped_to_configured_namespace_pods_and_port(
    cilium, namespace, port
):
    result = subprocess.run(
        [
            "helm",
            "template",
            "test",
            str(CHART),
            "--set",
            f"backend.networkPolicy.cilium.enabled={str(cilium).lower()}",
            "--set",
            "backend.networkPolicy.enabled=true",
            "--set",
            f"contextServices.hueMcp.namespace={namespace}",
            "--set",
            f"contextServices.hueMcp.port={port}",
            "--set",
            "backend.default.env.createSecret=true",
            "--set-string",
            "backend.default.env.data.HUE_MCP_TOKEN=test-hue-token",
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    resources = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    policy = next(
        doc
        for doc in resources
        if doc["metadata"]["name"]
        == (
            "test-daedalus-backend-default-cilium"
            if cilium
            else "test-daedalus-backend-default"
        )
        and doc["kind"] in {"CiliumNetworkPolicy", "NetworkPolicy"}
    )
    hue_rules = [
        rule for rule in policy["spec"]["egress"] if "hue-mcp-server" in str(rule)
    ]
    if cilium:
        expected = {
            "toEndpoints": [
                {
                    "matchLabels": {
                        "io.kubernetes.pod.namespace": namespace,
                        "app.kubernetes.io/name": "hue-mcp-server",
                    }
                }
            ],
            "toPorts": [{"ports": [{"port": str(port), "protocol": "TCP"}]}],
        }
    else:
        expected = {
            "to": [
                {
                    "namespaceSelector": {
                        "matchLabels": {"kubernetes.io/metadata.name": namespace}
                    },
                    "podSelector": {
                        "matchLabels": {"app.kubernetes.io/name": "hue-mcp-server"}
                    },
                }
            ],
            "ports": [{"protocol": "TCP", "port": port}],
        }
    assert hue_rules == [expected]
    secret = next(
        doc
        for doc in resources
        if doc["kind"] == "Secret"
        and doc["metadata"]["name"] == "test-daedalus-backend-env"
    )
    assert secret["stringData"]["HUE_MCP_TOKEN"] == "test-hue-token"
    # Preflight pods satisfy Hue ingress but must never receive backend traffic.
    probe_labels = {
        "app.kubernetes.io/name": "daedalus",
        "app.kubernetes.io/component": "backend-default",
    }
    for doc in resources:
        if doc["kind"] == "Service" and "backend-default" in doc["metadata"]["name"]:
            assert not all(
                probe_labels.get(k) == v for k, v in doc["spec"]["selector"].items()
            )
