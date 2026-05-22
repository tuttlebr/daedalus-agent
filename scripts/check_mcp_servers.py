#!/usr/bin/env python3
"""Pre-flight checks for MCP servers declared in a NAT config."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess  # nosec B404 - used to invoke `kubectl` for cluster-local preflight checks
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

PROTOCOL_VERSION = "2025-03-26"
CLIENT_INFO = {"name": "daedalus-mcp-preflight", "version": "0.1.0"}
ENV_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}")
PLACEHOLDER_VALUES = {
    "your-domain.example.com",
    "your-user",
    "YOUR_REGISTRY",
    "changeme",
    "placeholder",
}


@dataclass
class McpServer:
    name: str
    url: str
    include: list[str]
    auth_provider_name: str | None
    auth_provider: dict[str, Any] | None


@dataclass
class CheckResult:
    name: str
    url: str
    ok: bool
    detail: str
    tool_count: int = 0


class CheckError(Exception):
    """Expected pre-flight failure."""


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - depends on host env
        raise CheckError(
            "PyYAML is required to parse the NAT config. Install it with "
            "`python3 -m pip install pyyaml` or run from the builder test env."
        ) from exc

    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise CheckError(f"{path} did not parse as a YAML mapping")
    return data


def load_env_file(path: Path | None) -> dict[str, str]:
    values: dict[str, str] = {}
    if path is None or not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue

        key, raw_value = line.split("=", 1)
        key = key.strip()
        value = raw_value.strip()
        if not key:
            continue
        if value and value[0] in {"'", '"'}:
            try:
                parsed = shlex.split(value, comments=False, posix=True)
                value = parsed[0] if parsed else ""
            except ValueError:
                value = value.strip("'\"")
        values[key] = value
    return values


def merged_env(env_file: Path | None) -> dict[str, str]:
    values = load_env_file(env_file)
    values.update(os.environ)
    return values


def resolve_template(value: Any, env: dict[str, str]) -> tuple[str, list[str]]:
    text = "" if value is None else str(value)
    missing: list[str] = []

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        default = match.group(2)
        env_value = env.get(name)
        if env_value:
            return env_value
        if default is not None:
            return default
        missing.append(name)
        return match.group(0)

    return ENV_REF_RE.sub(replace, text), missing


def looks_unset(value: str) -> bool:
    normalized = value.strip()
    if not normalized or "${" in normalized:
        return True
    lowered = normalized.lower()
    return any(token.lower() in lowered for token in PLACEHOLDER_VALUES)


def discover_mcp_servers(
    config: dict[str, Any], env: dict[str, str]
) -> list[McpServer]:
    function_groups = config.get("function_groups", {})
    authentication = config.get("authentication", {})
    servers: list[McpServer] = []

    if not isinstance(function_groups, dict):
        raise CheckError("config.function_groups must be a mapping")

    for name, group in function_groups.items():
        if not isinstance(group, dict) or group.get("_type") != "mcp_client":
            continue
        server_config = group.get("server", {})
        if not isinstance(server_config, dict):
            continue
        if server_config.get("transport") != "streamable-http":
            continue

        url, missing = resolve_template(server_config.get("url", ""), env)
        if missing:
            url = server_config.get("url", "")

        include = group.get("include") or []
        if not isinstance(include, list):
            include = []

        provider_name = server_config.get("auth_provider")
        provider = authentication.get(provider_name) if provider_name else None
        if provider is not None and not isinstance(provider, dict):
            provider = None

        servers.append(
            McpServer(
                name=name,
                url=str(url),
                include=[str(item) for item in include],
                auth_provider_name=str(provider_name) if provider_name else None,
                auth_provider=provider,
            )
        )

    return servers


def auth_headers(
    server: McpServer, env: dict[str, str]
) -> tuple[dict[str, str], list[str]]:
    provider = server.auth_provider
    if not provider:
        return {}, []

    provider_type = provider.get("_type")
    errors: list[str] = []

    if provider_type == "api_key":
        raw_key, missing = resolve_template(provider.get("raw_key", ""), env)
        if missing or looks_unset(raw_key):
            errors.append(
                f"auth provider {server.auth_provider_name} is missing "
                f"{', '.join(missing) if missing else 'raw_key'}"
            )
            return {}, errors

        header_name = str(provider.get("custom_header_name") or "Authorization")
        prefix = str(provider.get("custom_header_prefix") or "").strip()
        header_value = f"{prefix} {raw_key}".strip() if prefix else raw_key
        return {header_name: header_value}, []

    if provider_type == "mcp_oauth2":
        for field in ("client_id", "client_secret", "redirect_uri"):
            resolved, missing = resolve_template(provider.get(field, ""), env)
            if missing or looks_unset(resolved):
                errors.append(
                    f"auth provider {server.auth_provider_name} is missing {field}"
                )
        return {}, errors

    return {}, [
        f"auth provider {server.auth_provider_name} has unsupported type {provider_type}"
    ]


def initialize_payload() -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": CLIENT_INFO,
        },
    }


def initialized_payload() -> dict[str, Any]:
    return {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}


def tools_list_payload() -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}


def parse_mcp_body(body: str) -> dict[str, Any]:
    stripped = body.strip()
    if not stripped:
        return {}

    data_lines: list[str] = []
    for line in stripped.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[len("data:") :].strip())
        elif not line and data_lines:
            break

    if data_lines:
        stripped = "\n".join(data_lines).strip()
    if stripped == "[DONE]":
        return {}

    parsed = json.loads(stripped)
    if not isinstance(parsed, dict):
        raise ValueError("MCP response was not a JSON object")
    return parsed


def summarize_body(body: str) -> str:
    text = " ".join(body.strip().split())
    return text[:300] if text else "<empty body>"


def rpc_post(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout: float,
) -> tuple[int, dict[str, str], str]:
    parsed_url = urlparse(url)
    if parsed_url.scheme not in {"http", "https"}:
        raise CheckError(
            f"unsupported URL scheme '{parsed_url.scheme}'; only http/https are allowed"
        )

    request_headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Protocol-Version": PROTOCOL_VERSION,
        **headers,
    }
    request = Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers=request_headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # nosec B310 - scheme validated above
            body = response.read().decode("utf-8", errors="replace")
            response_headers = {k.lower(): v for k, v in response.headers.items()}
            return response.status, response_headers, body
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise CheckError(f"HTTP {exc.code}: {summarize_body(body)}") from exc
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise CheckError(f"connection failed: {reason}") from exc
    except TimeoutError as exc:
        raise CheckError("connection timed out") from exc


def validate_payload(method: str, payload: dict[str, Any]) -> None:
    if "error" in payload:
        error = payload["error"]
        if isinstance(error, dict):
            message = error.get("message") or error
        else:
            message = error
        raise CheckError(f"{method} returned MCP error: {message}")
    if "result" not in payload:
        raise CheckError(f"{method} response did not include result")


def validate_tools(server: McpServer, payload: dict[str, Any]) -> int:
    validate_payload("tools/list", payload)
    tools = payload.get("result", {}).get("tools")
    if not isinstance(tools, list):
        raise CheckError("tools/list result did not include a tools list")

    tool_names = {
        tool.get("name")
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    }
    missing = sorted(set(server.include) - tool_names)
    if missing:
        raise CheckError(f"missing configured tools: {', '.join(missing)}")
    return len(tool_names)


def check_local(
    server: McpServer, headers: dict[str, str], timeout: float
) -> CheckResult:
    init_status, init_headers, init_body = rpc_post(
        server.url, initialize_payload(), headers, timeout
    )
    if init_status != 200:
        raise CheckError(f"initialize returned HTTP {init_status}")

    init_payload = parse_mcp_body(init_body)
    validate_payload("initialize", init_payload)
    session_id = init_headers.get("mcp-session-id")

    session_headers = dict(headers)
    if session_id:
        session_headers["Mcp-Session-Id"] = session_id
        rpc_post(server.url, initialized_payload(), session_headers, timeout)

    tools_status, _, tools_body = rpc_post(
        server.url, tools_list_payload(), session_headers, timeout
    )
    if tools_status != 200:
        raise CheckError(f"tools/list returned HTTP {tools_status}")
    tool_count = validate_tools(server, parse_mcp_body(tools_body))
    return CheckResult(server.name, server.url, True, "ok", tool_count)


def is_cluster_local_url(url: str) -> bool:
    host = urlparse(url).hostname or ""
    return host.endswith(".svc") or ".svc." in host


def extract_marker(output: str, marker: str) -> str:
    pattern = re.compile(
        rf"__MCP_{marker}_START__\n(.*?)\n__MCP_{marker}_END__", re.DOTALL
    )
    match = pattern.search(output)
    return match.group(1) if match else ""


def check_with_kubectl(
    server: McpServer,
    headers: dict[str, str],
    timeout: float,
    namespace: str,
    image: str,
) -> CheckResult:
    if headers:
        raise CheckError(
            "authenticated cluster-local MCP checks are not supported from kubectl mode"
        )

    pod_name = (
        f"mcp-preflight-{server.name.replace('_', '-')[:35]}-{uuid.uuid4().hex[:6]}"
    )
    timeout_text = str(int(timeout))
    script = f"""
set -u
url={shlex.quote(server.url)}
init_payload={shlex.quote(json.dumps(initialize_payload(), separators=(",", ":")))}
initialized_payload={shlex.quote(json.dumps(initialized_payload(), separators=(",", ":")))}
tools_payload={shlex.quote(json.dumps(tools_list_payload(), separators=(",", ":")))}

post_rpc() {{
  body_file="$1"
  headers_file="$2"
  payload="$3"
  shift 3
  curl -sS -o "$body_file" -D "$headers_file" -w "%{{http_code}}" \
    --max-time {timeout_text} \
    -X POST "$url" \
    -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    -H "Mcp-Protocol-Version: {PROTOCOL_VERSION}" \
    "$@" \
    --data "$payload"
}}

init_body="$(mktemp)"
init_headers="$(mktemp)"
init_status="$(post_rpc "$init_body" "$init_headers" "$init_payload")"
printf '__MCP_INIT_STATUS_START__\\n%s\\n__MCP_INIT_STATUS_END__\\n' "$init_status"
printf '__MCP_INIT_HEADERS_START__\\n'
cat "$init_headers"
printf '__MCP_INIT_HEADERS_END__\\n'
printf '__MCP_INIT_BODY_START__\\n'
cat "$init_body"
printf '\\n__MCP_INIT_BODY_END__\\n'

sid="$(awk 'tolower($1) == "mcp-session-id:" {{ print $2 }}' "$init_headers" | tr -d '\\r' | tail -n 1)"
if [ -n "$sid" ]; then
  notify_body="$(mktemp)"
  notify_headers="$(mktemp)"
  post_rpc "$notify_body" "$notify_headers" "$initialized_payload" -H "Mcp-Session-Id: $sid" >/dev/null || true
fi

tools_body="$(mktemp)"
tools_headers="$(mktemp)"
if [ -n "$sid" ]; then
  tools_status="$(post_rpc "$tools_body" "$tools_headers" "$tools_payload" -H "Mcp-Session-Id: $sid")"
else
  tools_status="$(post_rpc "$tools_body" "$tools_headers" "$tools_payload")"
fi
printf '__MCP_TOOLS_STATUS_START__\\n%s\\n__MCP_TOOLS_STATUS_END__\\n' "$tools_status"
printf '__MCP_TOOLS_BODY_START__\\n'
cat "$tools_body"
printf '\\n__MCP_TOOLS_BODY_END__\\n'
"""

    command = [
        "kubectl",
        "-n",
        namespace,
        "run",
        pod_name,
        "--rm",
        "-i",
        "--quiet",
        "--restart=Never",
        "--image",
        image,
        "--command",
        "--",
        "sh",
        "-ec",
        script,
    ]
    try:
        completed = subprocess.run(  # nosec B603 - fixed kubectl argv; shell script values are locally generated and shlex-quoted
            command,
            text=True,
            capture_output=True,
            timeout=max(timeout + 90, 120),
            check=False,
        )
    except FileNotFoundError as exc:
        raise CheckError("kubectl was not found for cluster-local MCP check") from exc
    except subprocess.TimeoutExpired as exc:
        raise CheckError("kubectl cluster-local MCP check timed out") from exc

    output = completed.stdout
    if completed.returncode != 0:
        message = summarize_body(completed.stderr or completed.stdout)
        raise CheckError(f"kubectl check failed: {message}")

    init_status = extract_marker(output, "INIT_STATUS").strip()
    init_body = extract_marker(output, "INIT_BODY")
    if init_status != "200":
        raise CheckError(f"initialize returned HTTP {init_status or 'unknown'}")
    validate_payload("initialize", parse_mcp_body(init_body))

    tools_status = extract_marker(output, "TOOLS_STATUS").strip()
    tools_body = extract_marker(output, "TOOLS_BODY")
    if tools_status != "200":
        raise CheckError(f"tools/list returned HTTP {tools_status or 'unknown'}")
    tool_count = validate_tools(server, parse_mcp_body(tools_body))
    return CheckResult(server.name, server.url, True, "ok", tool_count)


def check_server(
    server: McpServer,
    env: dict[str, str],
    timeout: float,
    namespace: str | None,
    kubectl_image: str,
) -> CheckResult:
    if looks_unset(server.url):
        return CheckResult(server.name, server.url, False, "server URL is unresolved")

    headers, errors = auth_headers(server, env)
    if errors:
        return CheckResult(server.name, server.url, False, "; ".join(errors))

    try:
        if namespace and is_cluster_local_url(server.url):
            return check_with_kubectl(
                server, headers, timeout, namespace, kubectl_image
            )
        return check_local(server, headers, timeout)
    except (CheckError, json.JSONDecodeError, ValueError) as exc:
        return CheckResult(server.name, server.url, False, str(exc))


def print_results(results: list[CheckResult]) -> None:
    width = max([len(result.name) for result in results] + [10])
    for result in results:
        status = "OK" if result.ok else "FAIL"
        detail = f"{result.tool_count} tools" if result.ok else result.detail
        print(f"{status:<4} {result.name:<{width}} {result.url} ({detail})")

    ok_count = sum(1 for result in results if result.ok)
    print(f"\nMCP preflight: {ok_count}/{len(results)} servers passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check Streamable HTTP MCP servers declared in a NAT YAML config."
    )
    parser.add_argument(
        "--config",
        default="backend/tool-calling-config.yaml",
        type=Path,
        help="NAT tool-calling YAML config to inspect.",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        help="Optional .env file used to resolve ${VAR} placeholders.",
    )
    parser.add_argument(
        "--timeout",
        default=20.0,
        type=float,
        help="Per-request timeout in seconds.",
    )
    parser.add_argument(
        "--kubernetes-namespace",
        help="Namespace for cluster-local checks using a short-lived kubectl curl pod.",
    )
    parser.add_argument(
        "--kubectl-image",
        default="curlimages/curl:8.8.0",
        help="Image used for cluster-local kubectl checks.",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Check only the named MCP function group. May be repeated.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env = merged_env(args.env_file)

    try:
        config = load_yaml(args.config)
        servers = discover_mcp_servers(config, env)
    except CheckError as exc:
        print(f"MCP preflight setup failed: {exc}", file=sys.stderr)
        return 2

    if args.only:
        wanted = set(args.only)
        servers = [server for server in servers if server.name in wanted]

    if not servers:
        print("No streamable-http MCP servers found.")
        return 0

    results = [
        check_server(
            server,
            env,
            args.timeout,
            args.kubernetes_namespace,
            args.kubectl_image,
        )
        for server in servers
    ]
    print_results(results)
    return 0 if all(result.ok for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
