---
name: unifi-network
description: >-
  Manage UniFi devices, clients, WLANs, VPNs, routing, QoS, and traffic through
  MCP. Do not use for connection setup or firewall-rule management.
allowed-tools: unifi_tool_index, unifi_execute, unifi_batch, unifi_batch_status
metadata:
  author: NVIDIA Corporation and Affiliates <noreply@nvidia.com>
  version: 1.0.0
  tags:
    - unifi
    - network-management
    - mcp
    - wifi
---

# UniFi Network MCP Server

## Purpose

You have access to a UniFi Network MCP server that lets you query and manage a UniFi Network Controller. It provides 177 tools covering devices, clients, firewall, VPN, routing, WLANs, Traffic Flows, statistics, and more.

## Prerequisites

- A configured, reachable UniFi Network MCP server.
- Local administrator credentials supplied through MCP configuration, never prompts.
- Explicit user approval of an exact preview before any mutation.

## Instructions

### Tool discovery

The server uses lazy loading, so only these approved meta-tools are registered initially:

- `unifi_tool_index`: discover operations by category, search text, or schema.
- `unifi_execute`: invoke one discovered operation by its exact name.
- `unifi_batch`: run independent discovered read operations in parallel.
- `unifi_batch_status`: check an asynchronous batch job.

Call `unifi_tool_index` to identify the narrow operation, inspect its schema,
then invoke that exact operation with `unifi_execute`. Use `unifi_batch` only
for independent reads. Never invoke an undiscovered operation or pass fields
outside its returned schema.

## Safety Model

The server is "secure by default" because it controls real network infrastructure.

**Read operations** — always available. All `list_*`, `get_*`, and query tools work without special permissions.

**Mutations** — permission-gated with mixed defaults:

- **Enabled by default:** firewall policies, port forwards, traffic routes, QoS rules, VPN clients, ACL rules, vouchers, user groups
- **Disabled by default (high-risk):** networks, WLANs, devices, clients, routes, VPN servers
- **Delete operations** — always disabled by default

If a mutation fails with a permission error, tell the user the env var to set: `UNIFI_POLICY_NETWORK_<CATEGORY>_<ACTION>=true`

**Confirmation flow** — every mutation uses preview-then-confirm:

1. Default call → returns preview of what would change
2. Call with `confirm=true` → executes the mutation

Always preview first. Call with `confirm=true` only after the user explicitly
approves that exact preview.

## Response Format

All tools return: `{"success": true, "data": ...}`, `{"success": false, "error": "..."}`, or `{"success": true, "requires_confirmation": true, "preview": ...}`. Always check `success` first.

**Redacted secrets:** Secret fields — WLAN passphrases (`x_passphrase`), VPN private/preshared keys, whole VPN config blobs (imported WireGuard/OpenVPN config files), and SNMP community strings — come back as `***REDACTED***` by default. Raw values are controlled by process policy (`UNIFI_NETWORK_REDACT_SENSITIVE_FIELDS=false` or global `UNIFI_REDACT_SENSITIVE_FIELDS=false`), not by tool arguments. On an update, send **only** the fields you are changing — to keep a secret unchanged, omit it; never echo `***REDACTED***` back, which is rejected so the placeholder can't overwrite the real secret.

## Device Classification

`unifi_list_devices` returns a `device_category` field that accurately classifies devices:

- `ap` — real access points (excludes USP Smart Power strips that report as `uap` type)
- `switch` — switches
- `gateway` — UDM/USG gateways
- `pdu` — smart power strips, UPS devices
- `wan` — cable internet (UCI) devices

Use `device_category` (not `type`) when counting or filtering devices. The `device_type` filter parameter uses this classification.

Additional enriched fields: `upgradable` (bool), `connection_network` (VLAN name), `uplink` (topology), `load_avg_1`, `mem_pct`, `model_eol`.

## Efficiency Tips

- **Batch reads** — `unifi_batch` for parallel queries (biggest efficiency win)
- **`unifi_lookup_by_ip`** — faster than listing all clients when you know the IP
- **Use filters** — most list tools accept time range, type, and ID parameters
- **`unifi_get_top_clients`** — fastest way to find bandwidth hogs
- **`unifi_get_traffic_flows`** — query historical Insights > Flows records when the user asks who talked to what, which ports/protocols were used, or where traffic went
- **Check health first** — `unifi_get_network_health` for quick "is everything OK?"
- **Device counts** — use `device_category` field, not `type`, for accurate AP/switch/PDU counts

## Authentication

Username and password are **required** (local admin credentials, not Ubiquiti SSO). API key support exists but is **experimental** — limited to read-only operations and a subset of tools.

To configure, run `/unifi-network:unifi-network-setup` or set env vars manually:

```
UNIFI_NETWORK_HOST=192.168.1.1
UNIFI_NETWORK_USERNAME=admin
UNIFI_NETWORK_PASSWORD=your-password
```

## Other UniFi Servers

If the user also has cameras or door access control, other UniFi MCP plugins are available:

- `unifi-protect` — security cameras, NVR, recordings, smart detections
- `unifi-access` — door locks, credentials, visitors, access policies

Cameras and access readers appear as network clients — use `unifi_lookup_by_ip` to cross-reference if troubleshooting connectivity for those devices.

## Examples

For "Which devices need attention?", discover the health and device-list read
operations and batch only those reads. For "Rename this access point", discover
the rename operation, request a preview, show it to the user, and wait for
explicit approval before sending `confirm=true`.

## Limitations

- Use `network-health-check` for health-only reporting and firewall skills for firewall rules.
- API-key authentication is experimental and exposes only a subset of read operations.
- Tool availability and fields can differ by controller and MCP server version.

## Troubleshooting

| Problem                                      | Cause                                      | Response                                                              |
| -------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| No meta-tools are available                  | MCP server is disconnected                 | Stop and use `unifi-network-setup`.                                   |
| Index or execute call has a connection error | Controller or MCP transport is unavailable | Verify the connection, retry one read once, then report the boundary. |
| Operation returns a permission error         | Policy gate is disabled                    | Report the exact policy variable; do not bypass it.                   |
| Response contains `***REDACTED***`           | Secret redaction is working                | Omit the field from updates; never send the placeholder back.         |

## Tool Reference

For the complete list of all 177 tools organized by category with descriptions, tips, and common scenarios, read `references/network-tools.md`.
