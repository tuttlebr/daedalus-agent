# UniFi integration-API operations

Use exact registered `unifi_mcp_server` schemas. The current daedalus-context
server exposes integration-API leaf operations with typed path/query parameters
and mutation bodies. This is a source contract snapshot; runtime discovery
controls availability. There is no lazy index/execute/batch wrapper.

| Need                  | Read operations                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access and site       | `getInfo`, `listSites`                                                                                                                              |
| Adopted devices       | `listAdoptedDevices`, `getAdoptedDeviceDetails`, `getAdoptedDeviceLatestStatistics`                                                                 |
| Adoption inventory    | `listPendingDevices`                                                                                                                                |
| Connected clients     | `listConnectedClients`, `getConnectedClientDetails`                                                                                                 |
| Networks              | `listNetworks`, `getNetworkDetails`, `getNetworkReferences`                                                                                         |
| Wi-Fi                 | `listWifiBroadcasts`, `getWifiBroadcastDetails`                                                                                                     |
| Firewall              | `listFirewallZones`, `getFirewallZone`, `listFirewallPolicies`, `getFirewallPolicy`, `getFirewallPolicyOrdering`                                    |
| ACL                   | `listAclRules`, `getAclRule`, `getAclRuleOrdering`                                                                                                  |
| Switching             | `listSwitchStacks`, `getSwitchStack`, `listMcLagDomains`, `getMcLagDomain`, `listLags`, `getLagDetails`                                             |
| DNS/traffic selectors | `listDnsPolicies`, `getDnsPolicy`, `listTrafficMatchingLists`, `getTrafficMatchingList`                                                             |
| WAN/VPN               | `listWanInterfaces`, `listSiteToSiteVpnTunnels`, `listVpnServers`                                                                                   |
| Other inventories     | `listVouchers`, `getVoucherDetails`, `listRadiusProfiles`, `listDeviceTags`, `listDpiApplicationCategories`, `listDpiApplications`, `listCountries` |

Resolve `siteId` from `listSites`; do not use a legacy site slug such as
`default` in a UUID field. Resolve other path IDs from their list operations.
Paged responses use `data`, `offset`, `limit`, `count`, and `totalCount`.
Advance by returned count and detect a stalled/empty page before totalCount;
report partial results rather than looping indefinitely. Follow each schema's
filter support and limit, reducing pages if the response-size cap is hit.

Mutations are direct actions, including operations such as
`patchFirewallPolicy` with `siteId`, `firewallPolicyId`, and a typed `body`.
Inspect the actual schema and semantics before any requested write. PATCH and
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
