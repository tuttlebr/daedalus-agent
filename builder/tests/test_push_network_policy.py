"""Render both policy modes; push grants must remain opt-in and scoped."""

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(shutil.which("helm") is None, reason="Helm is required")


def render(*values, succeeds=True):
    command = ["helm", "template", "fixture", "helm/daedalus"]
    for value in values:
        command += ["--set", value]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if not succeeds:
        assert result.returncode != 0
        return result.stderr
    assert result.returncode == 0, result.stderr
    return [item for item in yaml.safe_load_all(result.stdout) if item]


def test_push_is_disabled_in_both_senders_by_default():
    resources = render()
    for component in ("frontend", "frontend-stream-worker"):
        workload = next(
            r
            for r in resources
            if r["kind"] == "Deployment"
            and r["spec"]["template"]["metadata"]["labels"].get(
                "app.kubernetes.io/component"
            )
            == component
        )
        env = workload["spec"]["template"]["spec"]["containers"][0]["env"]
        assert (
            next(e["value"] for e in env if e["name"] == "PUSH_NOTIFICATIONS_ENABLED")
            == "false"
        )


def test_standard_push_requires_explicit_ranges_and_only_opens_443():
    enabled = "frontend.streamWorker.pushNotifications.enabled=true"
    assert "explicit provider CIDRs" in render(enabled, succeeds=False)
    assert "unrestricted" in render(
        enabled,
        "frontend.streamWorker.pushNotifications.cidrs[0]=0.0.0.0/0",
        succeeds=False,
    )
    resources = render(
        enabled, "frontend.streamWorker.pushNotifications.cidrs[0]=203.0.113.8/32"
    )
    policy = next(
        r
        for r in resources
        if r["kind"] == "NetworkPolicy"
        and r["metadata"]["name"].endswith("-frontend-stream-worker")
    )
    grants = [
        e
        for e in policy["spec"]["egress"]
        if any("ipBlock" in peer for peer in e["to"])
    ]
    assert grants == [
        {
            "to": [{"ipBlock": {"cidr": "203.0.113.8/32"}}],
            "ports": [{"protocol": "TCP", "port": 443}],
        }
    ]


def test_cilium_push_names_match_supported_application_providers():
    resources = render(
        "backend.networkPolicy.cilium.enabled=true",
        "frontend.streamWorker.pushNotifications.enabled=true",
    )
    policy = next(
        r
        for r in resources
        if r["kind"] == "CiliumNetworkPolicy"
        and r["metadata"]["name"].endswith("-frontend-stream-worker-cilium")
    )
    grants = [e for e in policy["spec"]["egress"] if "toFQDNs" in e]
    assert grants == [
        {
            "toFQDNs": [
                {"matchName": "fcm.googleapis.com"},
                {"matchName": "updates.push.services.mozilla.com"},
                {"matchPattern": "*.push.apple.com"},
            ],
            "toPorts": [{"ports": [{"port": "443", "protocol": "TCP"}]}],
        }
    ]
