"""Exercise optional gateway targets and differing Service/container ports."""

import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.requires_helm


def render(*values):
    command = ["helm", "template", "fixture", "helm/daedalus"]
    for value in values:
        command += ["--set", value]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return [item for item in yaml.safe_load_all(result.stdout) if item]


def test_nginx_uses_service_ports_for_both_http_upstreams():
    resources = render(
        "frontend.port=5000",
        "frontend.service.port=8085",
        "backend.default.port=8001",
        "backend.default.service.port=8086",
        "nginx.config.restrictedMode=false",
    )
    config = next(
        r
        for r in resources
        if r["kind"] == "ConfigMap" and "frontend.conf" in r.get("data", {})
    )["data"]["frontend.conf"]
    assert "http://fixture-daedalus-frontend.default.svc.cluster.local:8085" in config
    assert (
        "http://fixture-daedalus-backend-default.default.svc.cluster.local:8086"
        in config
    )
    assert "http://fixture-daedalus-frontend.default.svc.cluster.local:3001" in config
    assert ":3000" not in config
    assert ":8001" not in config


@pytest.mark.parametrize("enabled", [False, True])
def test_standard_nginx_policy_scopes_optional_voice_target(enabled):
    resources = render(
        f"nginx.config.voiceStudioProxy.enabled={str(enabled).lower()}",
        "nginx.config.voiceStudioProxy.serviceNamespace=voice-fixture",
        "nginx.config.voiceStudioProxy.servicePort=8090",
    )
    policy = next(
        r
        for r in resources
        if r["kind"] == "NetworkPolicy" and r["metadata"]["name"].endswith("-nginx")
    )
    voice = [
        rule
        for rule in policy["spec"]["egress"]
        if any(
            peer.get("namespaceSelector", {})
            .get("matchLabels", {})
            .get("kubernetes.io/metadata.name")
            == "voice-fixture"
            for peer in rule["to"]
        )
    ]
    assert voice == (
        [
            {
                "to": [
                    {
                        "namespaceSelector": {
                            "matchLabels": {
                                "kubernetes.io/metadata.name": "voice-fixture"
                            }
                        },
                        "podSelector": {
                            "matchLabels": {
                                "app.kubernetes.io/name": "voice-studio",
                                "app.kubernetes.io/component": "app",
                            }
                        },
                    }
                ],
                "ports": [{"protocol": "TCP", "port": 8090}],
            }
        ]
        if enabled
        else []
    )


@pytest.mark.parametrize("cilium", [False, True])
def test_workloads_and_policies_use_the_port_for_the_actual_destination(cilium):
    resources = render(
        "frontend.port=5000",
        "frontend.service.port=8085",
        "backend.default.port=8001",
        "backend.default.service.port=8086",
        f"backend.networkPolicy.cilium.enabled={str(cilium).lower()}",
        "documentObjectStorage.enabled=true",
        "documentObjectStorage.endpoint=http://object-store:9000",
        "documentObjectStorage.auth.existingSecret=fixture-objects",
    )
    deployments = {
        r["spec"]["template"]["metadata"]["labels"]["app.kubernetes.io/component"]: r
        for r in resources
        if r["kind"] == "Deployment"
    }
    backend_env = deployments["backend-default"]["spec"]["template"]["spec"][
        "containers"
    ][0]["env"]
    assert [
        entry["value"]
        for entry in backend_env
        if entry["name"] == "DAEDALUS_ARTIFACT_PUBLISH_URL"
    ] == [
        "http://fixture-daedalus-frontend.default.svc.cluster.local:8085"
        "/api/internal/sandboxArtifacts"
    ]
    for component in ["frontend", "frontend-stream-worker"]:
        env = {
            e["name"]: e.get("value")
            for e in deployments[component]["spec"]["template"]["spec"]["containers"][
                0
            ]["env"]
        }
        assert env.get("BACKEND_PORT") == "8086"
        assert env.get("BACKEND_POD_PORT") == "8001"
        if component == "frontend":
            assert env.get("PORT") == "5000"
    worker = deployments["autonomous-agent"]
    for container in (
        worker["spec"]["template"]["spec"]["initContainers"]
        + worker["spec"]["template"]["spec"]["containers"]
    ):
        urls = [
            e["value"]
            for e in container.get("env", [])
            if e["name"] == "BACKEND_BASE_URL"
        ]
        assert urls == ["http://fixture-daedalus-backend-default:8086"]
    policy = next(
        r
        for r in resources
        if r["kind"] == ("CiliumNetworkPolicy" if cilium else "NetworkPolicy")
        and r["metadata"]["name"].endswith(
            "-backend-default" + ("-cilium" if cilium else "")
        )
    )
    artifact = [
        rule
        for rule in policy["spec"]["egress"]
        if any(
            (peer if cilium else peer.get("podSelector", {}))
            .get("matchLabels", {})
            .get("app.kubernetes.io/component")
            == "frontend"
            for peer in rule.get("toEndpoints" if cilium else "to", [])
        )
    ]
    ports = artifact[0]["toPorts"][0]["ports"] if cilium else artifact[0]["ports"]
    assert ports == [{"protocol": "TCP", "port": "5000" if cilium else 5000}]


def test_explicit_backend_overrides_remain_single_port_by_default():
    resources = render("frontend.env.overrides.BACKEND_PORT=8123")
    for resource in resources:
        if resource["kind"] != "Deployment":
            continue
        spec = resource["spec"]["template"]
        if spec["metadata"]["labels"]["app.kubernetes.io/component"] not in {
            "frontend",
            "frontend-stream-worker",
        }:
            continue
        env = spec["spec"]["containers"][0]["env"]
        for name in ("BACKEND_PORT", "BACKEND_POD_PORT"):
            assert [entry["value"] for entry in env if entry["name"] == name] == [
                "8123"
            ]
