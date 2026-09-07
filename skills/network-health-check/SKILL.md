---
name: network-health-check
description: Report current UniFi device and client health from read-only integration-API inventory, details, and statistics. Use unifi-network for changes and unifi-network-setup for connector failures.
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 2.0.0
---

# Network health check

Produce an evidence-backed network status for the requested site. During a
Daily Daedalus briefing, return findings to the calling skill; it owns the
edition's output, cadence, and read-only boundary.

## Collect current evidence

1. Use registered `unifi_mcp_server` leaf tools and their schemas. Reuse
   successful reads from the caller. If needed, call `getInfo` and
   `listSites` to verify access and resolve the site UUID.
2. Call `listAdoptedDevices(siteId=...)`. Page through all devices before
   stating fleet counts. Use `listPendingDevices` only when adoption is relevant.
3. After IDs are known, parallelize `getAdoptedDeviceDetails` and
   `getAdoptedDeviceLatestStatistics` for affected devices. Use
   `listConnectedClients` and `getConnectedClientDetails` when client impact
   or an uplink relationship needs evidence.
4. Inspect configured networks, Wi-Fi broadcasts, or WAN interfaces only to
   explain a specific anomaly. Configuration existence alone does not prove
   traffic health. Recover omitted compacted rows before exact/absence claims.

Load these references only for the returned evidence, using
`agent_skills_tool(operation=load_skill, skill_name=network-health-check,
resource=references/<file>.md)`:

- [device-states](references/device-states.md): integration-API states,
  firmware, uptime, and utilization.
- [health-subsystems](references/health-subsystems.md): WAN, LAN, Wi-Fi, VPN
  evidence and caller-path verification.
- [alarm-types](references/alarm-types.md): unavailable alarm feeds and
  active-versus-historical event handling.

## Interpret and report

Report as-of time, site, observed device states, affected users/paths, and the
smallest useful next check. State the denominator and missing pages for partial
inventories. Distinguish `healthy on checked surfaces`, `degraded`, and
`unavailable/inconclusive`; missing data cannot justify an all-clear.

Only call a device offline when its returned state supports that classification.
Firmware availability is maintenance information, not an outage. Uptime alone
does not prove instability; correlate restarts and impact. Never claim that
there are no alarms or healthy WAN/VPN sessions from tools that do not expose
those observations.

Keep healthy reports short. For a failure, lead with impact and current
evidence, then give an actionable next step. No reboot, adoption, upgrade,
acknowledgement, or configuration call belongs in this health check. Use
[unifi-network](../unifi-network/SKILL.md) for a requested repair and
[unifi-network-setup](../unifi-network-setup/SKILL.md) for access failures.
