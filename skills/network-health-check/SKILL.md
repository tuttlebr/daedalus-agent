---
name: network-health-check
description: >-
  Run a read-only UniFi health check for devices, alarms, firmware, controller,
  WAN, LAN, WLAN, and VPN. Use UniFi Network for changes.
metadata:
  author: NVIDIA Corporation and Affiliates <noreply@nvidia.com>
  version: 1.0.0
  tags:
    - unifi
    - network-health
    - diagnostics
    - read-only
---

# Network Health Check

## Purpose

Report the UniFi controller's current health, active alarms, device state,
firmware posture, and WAN-to-VPN subsystem status without changing the network.

## Prerequisites

Before running a health check, verify the MCP server is configured:

- Check that `UNIFI_NETWORK_HOST` is set in the environment.
- If it is not set or the connection fails, stop and direct the user to the `unifi-network-setup` skill to configure the UniFi Network MCP server.
- Use `unifi_tool_index` to confirm available tools. If no UniFi tools are listed, the server is not connected.

## Instructions

1. Call `unifi_batch` once to gather system, health, device, and alarm data in
   parallel:

```
unifi_batch([
  { "tool": "unifi_get_system_info" },
  { "tool": "unifi_get_network_health" },
  { "tool": "unifi_list_devices" },
  { "tool": "unifi_list_alarms" }
])
```

2. Validate each batch result and report any unavailable operation instead of
   guessing its data. Do not call these tools one at a time.

3. Run this follow-up batch only when a device or alarm issue needs more detail:

```
unifi_batch([
  { "tool": "unifi_list_clients" },
  { "tool": "unifi_get_top_clients" }
])
```

4. Use the reference mappings to classify the results, then return the report
   structure below.

## Analyzing Results

Use these reference documents to interpret the data returned by the batch call:

- `references/device-states.md` — maps device `state` integer codes to human-readable status (online, offline, isolated, etc.) and explains what each state means operationally. Do not guess at state codes — consult this reference before classifying device status.
- `references/alarm-types.md` — describes known alarm types, their severity levels, and recommended remediation steps. Consult before classifying alarm severity or suggesting actions.
- `references/health-subsystems.md` — explains the per-subsystem health fields returned by `unifi_get_network_health` (WAN, LAN, WLAN, VPN), how to interpret `status` values, and the recommended diagnostic priority order: **WAN → LAN → WLAN → VPN**.

From the device list, identify:

- **Offline devices** — any device with `state` != 1. Check `references/device-states.md` for the full state code table.
- **Devices needing updates** — check the `upgradeable` field. Report current vs available firmware version.
- **High-load devices** — check CPU/memory utilization if present in device stats.
- **Devices with poor uptime** — recently rebooted devices may indicate instability.

For each active alarm, classify severity using `references/alarm-types.md` and provide a plain-language explanation with remediation steps from that reference.

## Examples

Present findings using this structure:

```
## Network Health Report

**Overall Status:** [Healthy / Warning / Critical]
**Controller:** [version] — uptime [X days]

### Devices ([online]/[total])
- [List any offline or problematic devices with their state code and meaning]
- [List devices needing firmware updates with current and available versions]

### Active Alarms ([count])
- [Summarize each alarm with severity and recommendation]

### Recommendations
1. [Actionable item]
2. [Actionable item]
```

A healthy network gets a brief "all clear" summary. Do not manufacture concerns for quiet periods.

## Tips

- Always use `unifi_batch` for initial data gathering — sequential tool calls are significantly slower.
- If `unifi_get_network_health` shows WAN health issues, that likely explains many downstream problems — lead with that finding and follow the WAN → LAN → WLAN → VPN diagnostic priority from `references/health-subsystems.md`.
- Don't overwhelm the user with raw data. Focus on what is broken or needs attention.
- Consult the reference docs before classifying device state codes or alarm meanings — misclassification leads to bad recommendations.

## Limitations

- Read-only health reporting; use `unifi-network` for approved configuration changes.
- Results reflect the controller's current data and may omit unsupported device metrics.
- The skill does not score firewall policy; use `firewall-auditor` for that task.

## Troubleshooting

| Problem                     | Cause                                        | Response                                                              |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| No UniFi tools appear       | MCP server is disconnected or not configured | Stop and use `unifi-network-setup`.                                   |
| Batch call times out        | Controller or MCP transport is unavailable   | Verify the connection, retry the read once, then report the boundary. |
| One tool in the batch fails | Controller capability differs by version     | Report available sections and identify the missing operation.         |
