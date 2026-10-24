# UniFi integration-API operations

Use exact registered `unifi_mcp_server` schemas. The current daedalus-context
server has a larger integration-API catalog, but Daedalus exposes only these
eleven reads through `backend/tool-calling-config.yaml`. Runtime schemas control
arguments and response fields. There is no lazy index/execute/batch wrapper.

| Need               | Read operations                                                                     |
| ------------------ | ----------------------------------------------------------------------------------- |
| Access and site    | `getInfo`, `listSites`                                                              |
| Adopted devices    | `listAdoptedDevices`, `getAdoptedDeviceDetails`, `getAdoptedDeviceLatestStatistics` |
| Adoption inventory | `listPendingDevices`                                                                |
| Connected clients  | `listConnectedClients`, `getConnectedClientDetails`                                 |
| Networks           | `listNetworks`                                                                      |
| Wi-Fi              | `listWifiBroadcasts`                                                                |
| WAN                | `listWanInterfaces`                                                                 |

Resolve `siteId` from `listSites`; do not use a legacy site slug such as
`default` in a UUID field. Resolve other path IDs from their list operations.
Paged responses use `data`, `offset`, `limit`, `count`, and `totalCount`.
Advance by returned count and detect a stalled/empty page before totalCount;
report partial results rather than looping indefinitely. Follow each schema's
filter support and limit, reducing pages if the response-size cap is hit.

Additional controller reads and mutations are unavailable in this application.
Prepare requested changes from supported reads or supplied configuration.
If a separate authorized write capability is provided, inspect its actual
schema and semantics before execution. PATCH and
PUT differ; preserving unspecified fields is not automatic for a replacement.
MCP annotations inform the runtime gate but are not an independent permission
system. There is no application-level preview/confirm parameter on this server.

The integration API does not expose all legacy controller dashboard fields.
Alarm/event history, aggregate network-health scores and historical traffic
flows cannot be promised from these operations. Use provided current fields,
additional genuinely connected sources, or report the missing coverage.

## Client identification coverage

In the pinned v10.4.57 contract, wired/wireless client lists and details provide
`id`, `name`, `macAddress`, `type`, `uplinkDeviceId`, and access information,
with `ipAddress` and `connectedAt` when available. `name` is a display name;
the contract does not identify it as a separately reported DHCP hostname.
VPN/Teleport records do not promise a MAC or local device attachment.

Resolve `uplinkDeviceId` against adopted-device `id` in the same site. Adopted
device responses provide `name`, `model`, MAC/IP and feature information; their
model describes that UniFi device, not the client attached to it.

This contract has no client product/model, OS, fingerprint, DHCP/mDNS evidence,
SSID, client network/VLAN ID, or switch-port field. Listing configured networks
or Wi-Fi broadcasts alone cannot establish a client's membership. Newer live
responses may add fields; use what was actually returned and retain its source.
For evidence collection, product research, and naming, read
[client-identification](client-identification.md).

Maintainer evidence: daedalus-context `unifi-network-mcp/src/pkg/unifi/endpoints.go`
and its embedded `network_v10.4.57_openapi.json`. For a changed controller
contract, consult [UniFi's API documentation](https://developer.ui.com/network)
and the actual connected schema before updating this snapshot.
