---
name: unifi-network
description: Query or change UniFi Network devices, clients, Wi-Fi, networks, firewall, routing, and VPN through the connected integration-API MCP. Use network-health-check for a health report and unifi-network-setup for connection failures.
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 2.0.0
---

# UniFi Network

Use the registered `unifi_mcp_server` leaf tools. Daedalus connects to the
integration-API server maintained in daedalus-context. It does not use the
legacy plugin's lazy index/execute/batch interface.

## Resolve the target

1. Inspect the exposed tool schemas. Use their exact names and fields, including
   any host prefix. `getInfo` verifies an authenticated controller read.
2. Use `listSites` and retain the returned site UUID. Reuse a confirmed site;
   ask only if several sites match and the request does not identify one.
3. Carry `siteId` through every scoped call. Resolve device, client, network,
   Wi-Fi, and policy IDs from current responses; names, MACs, and UUIDs are
   different identifiers.
4. Read [network-tools](references/network-tools.md) through
   `agent_skills_tool(operation=load_skill, skill_name=unifi-network,
resource=references/network-tools.md)` for the operation families.

## Read efficiently

Start with the narrowest useful list or detail call. Page lists using the
returned offset/count/total contract and the schema's limit. Apply only
supported filters. Parallelize independent reads after their site/IDs are known.
A capped page, failed call, or compacted result cannot establish an exact count
or absence; retrieve missing rows with `tool_output_retriever_tool` when needed.

The response body is the integration API's JSON, with MCP errors on failures.
Check the actual response; do not require a legacy `success` envelope.
Use the schema's state, feature, interface, and firmware fields. Do not invent
device categories, traffic-flow history, alarms, or dashboard summaries that
this server does not expose.

For a health report, hand off to
[network-health-check](../network-health-check/SKILL.md) with the site and
completed reads. For a connector failure, use
[unifi-network-setup](../unifi-network-setup/SKILL.md).

## Make a requested change

Read the current target and the exact mutation schema first. Build a concrete
change with its affected IDs, requested fields, and a verification read. Honor
the user's existing authorization and Daedalus's runtime approval gate.
Calling a mutation is an execution attempt, not a preview: this server does
not supply the old plugin's `confirm=true` protocol or category policy flags.

For PATCH, send only intended fields. For PUT, preserve required unchanged
fields according to its full replacement schema. Never copy a redacted secret
placeholder into a write. If a required secret is unavailable, report the
specific configuration boundary rather than fetching credentials into chat.

After execution, read the changed object and check the requested behavior.
If the write times out, inspect current state before considering a retry.
Return the verified result or the concrete proposal and unexecuted step.

## Authentication and limits

Daedalus supplies the MCP bearer token; the server supplies the controller's
integration API key. In fixed-controller mode, connection overrides are absent
and rejected. Do not ask for credentials or pass `apiKey`, `baseUrl`, or TLS
overrides as a workaround. A 401/403 is an access failure, not network health
evidence. Report the failing boundary once.

Supported operations depend on the connected server and controller version.
Firewall work belongs here when its operations are advertised; no separate
firewall skill is installed. Advice and health checks do not authorize network
changes.
