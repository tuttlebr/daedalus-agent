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

Maintainer evidence: daedalus-context `unifi-network-mcp/src/pkg/unifi/endpoints.go`
and its embedded `network_v10.4.57_openapi.json`. For a changed controller
contract, consult [UniFi's API documentation](https://developer.ui.com/network)
and the actual connected schema before updating this snapshot.
