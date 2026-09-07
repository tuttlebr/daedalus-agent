---
name: unifi-network-setup
description: Configure or diagnose Daedalus's UniFi MCP endpoint, bearer authentication, fixed controller, API key, TLS, and network reachability. Use unifi-network for controller operations.
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 2.0.0
---

# UniFi connection setup

Repair the connection from Daedalus to its existing UniFi integration-API MCP
server. This application uses a remote MCP service; desktop plugin installers
and local controller passwords are not part of this workflow.

## Establish the failing boundary

1. Reuse the endpoint/site context and error already observed. Inspect the
   registered `unifi_mcp_server` schema when available; an absent tool is not
   proof that the controller is down.
2. Attempt one bounded `getInfo` read, then `listSites` when the first succeeds.
   These prove controller access and provide real site UUIDs.
3. Distinguish MCP connection/authentication, controller authentication/TLS,
   controller reachability, and unsupported API/version errors. Do not retry
   unchanged access failures or ask for a token in chat.

For configuration work, inspect these owner surfaces through repository tools
or an available operator checkout:

| Boundary                               | Source of truth                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Daedalus endpoint and MCP bearer token | `UNIFI_MCP_SERVER`, `UNIFI_MCP_TOKEN`; `backend/tool-calling-config.yaml` and deployment Secret wiring |
| Remote server/chart                    | daedalus-context `unifi-network-mcp/` and `helm/unifi-network-mcp-server/`                             |
| Controller integration API             | server-side `UNIFI_BASE_URL`, `UNIFI_API_KEY`; base path `/proxy/network/integration`                  |
| Controller/credential lock             | `UNIFI_FIXED_CONTROLLER=true` in the server deployment                                                 |
| TLS and reachability                   | trusted CA, server egress, Service/EndpointSlices, caller network policy                               |

Never print Secret data, read private environment files into model context, or
put credentials in commands, tool arguments, generated files, or memory.
Operators provision values through the existing Secret-backed deployment path.
Ask only for nonsecret missing context, such as the intended endpoint or site.

## Prepare and verify the repair

Use [devops-engineer](../devops-engineer/SKILL.md) for delivery/configuration
changes and [kubernetes-specialist](../kubernetes-specialist/SKILL.md) for
Service or policy diagnosis. Select the owning repository's documented deploy
command after inspecting it; do not invent a script path or reinstall a desktop
client. Keep TLS verification enabled and configure trust for a private CA.

Prepare the exact endpoint, Secret-reference, or network-policy diff and the
scoped validation before a deployment. Continue within existing authorization;
the runtime handles any required approval. The isolated sandbox cannot edit a
remote release or supply its credentials.

The server's `/livez` and `/readyz` prove local process health.
`/dependencyz` checks the controller; an authenticated `getInfo` tool result
proves the application path. Finish with `listSites`, then hand off to
[unifi-network](../unifi-network/SKILL.md) or
[network-health-check](../network-health-check/SKILL.md) using the confirmed
site. Report source validation, rollout, and successful reads separately.
