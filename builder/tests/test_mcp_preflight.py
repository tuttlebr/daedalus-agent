"""Tests for MCP server pre-flight config and response handling."""

import importlib.util
import sys
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
    assert deploy.index("Checking MCP server reachability") < deploy.index(
        "Deploying Daedalus via Helm"
    )
