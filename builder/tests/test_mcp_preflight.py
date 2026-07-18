"""Tests for MCP server pre-flight config and response handling."""

import importlib.util
import json
import sys
import types
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_mcp_servers.py"
DEPLOY = Path(__file__).resolve().parents[2] / "deploy.sh"
SPEC = importlib.util.spec_from_file_location("check_mcp_servers", SCRIPT)
check_mcp_servers = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = check_mcp_servers
SPEC.loader.exec_module(check_mcp_servers)


def test_discovers_streamable_http_mcp_servers_and_resolves_env():
    config = {
        "authentication": {
            "github_mcp_server": {
                "_type": "api_key",
                "custom_header_name": "Authorization",
                "custom_header_prefix": "Bearer",
                "raw_key": "${GITHUB_PAT}",
            }
        },
        "function_groups": {
            "github_mcp_server": {
                "_type": "mcp_client",
                "include": ["search_code"],
                "server": {
                    "auth_provider": "github_mcp_server",
                    "transport": "streamable-http",
                    "url": "https://example.com/mcp",
                },
            },
            "stdio_mcp_server": {
                "_type": "mcp_client",
                "server": {"transport": "stdio", "url": "ignored"},
            },
        },
    }

    servers = check_mcp_servers.discover_mcp_servers(config, {"GITHUB_PAT": "token"})
    headers, errors = check_mcp_servers.auth_headers(
        servers[0], {"GITHUB_PAT": "token"}
    )

    assert [server.name for server in servers] == ["github_mcp_server"]
    assert servers[0].include == ["search_code"]
    assert headers == {"Authorization": "Bearer token"}
    assert errors == []


def test_oauth_auth_validation_reports_missing_client_secret():
    server = check_mcp_servers.McpServer(
        name="gmail_mcp_server",
        url="https://gmailmcp.googleapis.com/mcp/v1",
        include=["search_threads"],
        auth_provider_name="gmail_mcp_server",
        auth_provider={
            "_type": "mcp_oauth2",
            "client_id": "${GOOGLE_MCP_CLIENT_ID}",
            "client_secret": "${GOOGLE_MCP_CLIENT_SECRET}",
            "redirect_uri": "https://example.com/auth/redirect",
        },
    )

    _, errors = check_mcp_servers.auth_headers(
        server,
        {
            "GOOGLE_MCP_CLIENT_ID": "client-id",
            "GOOGLE_MCP_CLIENT_SECRET": "",
        },
    )

    assert errors == ["auth provider gmail_mcp_server is missing client_secret"]


def test_parse_mcp_body_supports_event_stream_json():
    body = (
        "event: message\n"
        'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"searchDocs"}]}}\n\n'
    )

    parsed = check_mcp_servers.parse_mcp_body(body)

    assert parsed["result"]["tools"][0]["name"] == "searchDocs"


def test_validate_tools_requires_configured_include_names():
    server = check_mcp_servers.McpServer(
        name="docs_mcp_server",
        url="https://docs.example.com/_mcp/server",
        include=["searchDocs", "missingTool"],
        auth_provider_name=None,
        auth_provider=None,
    )
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "result": {"tools": [{"name": "searchDocs"}]},
    }

    try:
        check_mcp_servers.validate_tools(server, payload)
    except check_mcp_servers.CheckError as exc:
        assert "missingTool" in str(exc)
    else:
        raise AssertionError("missing configured tool should fail validation")


def test_deploy_runs_mcp_preflight_before_helm():
    deploy = DEPLOY.read_text(encoding="utf-8")

    assert "scripts/check_mcp_servers.py" in deploy
    assert "--skip-mcp-preflight" in deploy
    assert '--kubernetes-secret "$RELEASE-backend-env"' in deploy
    assert deploy.index("Checking MCP server reachability") < deploy.index(
        "Deploying Daedalus via Helm"
    )


def test_authenticated_cluster_probe_uses_secret_without_putting_key_in_argv(
    monkeypatch,
):
    server = check_mcp_servers.McpServer(
        name="k8s_mcp_server",
        url="http://kubernetes-mcp.kubernetes-mcp.svc.cluster.local:8080/mcp",
        include=["getClusterSummary"],
        auth_provider_name="k8s_mcp_server",
        auth_provider={
            "_type": "api_key",
            "custom_header_name": "Authorization",
            "custom_header_prefix": "Bearer",
            "raw_key": "${KUBERNETES_MCP_TOKEN}",
        },
    )
    init_body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "test"}}
    )
    tools_body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "result": {"tools": [{"name": "getClusterSummary"}]},
        }
    )
    output = (
        "__MCP_INIT_STATUS_START__\n200\n__MCP_INIT_STATUS_END__\n"
        f"__MCP_INIT_BODY_START__\n{init_body}\n__MCP_INIT_BODY_END__\n"
        "__MCP_TOOLS_STATUS_START__\n200\n__MCP_TOOLS_STATUS_END__\n"
        f"__MCP_TOOLS_BODY_START__\n{tools_body}\n__MCP_TOOLS_BODY_END__\n"
    )
    captured = {}

    def fake_run(command, **_kwargs):
        captured["command"] = command
        return types.SimpleNamespace(returncode=0, stdout=output, stderr="")

    monkeypatch.setattr(check_mcp_servers.subprocess, "run", fake_run)

    result = check_mcp_servers.check_with_kubectl(
        server,
        {"Authorization": "Bearer actual-secret-value"},
        20,
        "daedalus",
        "curlimages/curl:8.8.0",
        "daedalus-backend-env",
    )

    command = captured["command"]
    rendered = " ".join(command)
    overrides = json.loads(command[command.index("--overrides") + 1])
    script = command[-1]
    assert result.ok is True
    assert result.tool_count == 1
    assert "actual-secret-value" not in rendered
    assert "KUBERNETES_MCP_TOKEN" in script
    assert overrides["spec"]["containers"][0]["envFrom"] == [
        {"secretRef": {"name": "daedalus-backend-env"}}
    ]


def test_authenticated_cluster_probe_requires_kubernetes_secret():
    server = check_mcp_servers.McpServer(
        name="unifi_mcp_server",
        url="http://unifi-mcp.unifi.svc.cluster.local:8080/mcp",
        include=["listSites"],
        auth_provider_name="unifi_mcp_server",
        auth_provider={"_type": "api_key", "raw_key": "${UNIFI_MCP_TOKEN}"},
    )

    try:
        check_mcp_servers.check_with_kubectl(
            server,
            {"Authorization": "Bearer secret"},
            20,
            "daedalus",
            "curlimages/curl:8.8.0",
            None,
        )
    except check_mcp_servers.CheckError as exc:
        assert "--kubernetes-secret" in str(exc)
    else:
        raise AssertionError("authenticated probe should require a Secret")
