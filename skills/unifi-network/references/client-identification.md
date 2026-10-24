# Connected-client and product identification

Use this workflow to answer what a connected device is, where it attaches, and
what to call it. Public product documentation can explain an observed model;
it cannot establish which physical device owns a MAC by itself.

## Retrieve and correlate current evidence

Resolve the site and pagination as described in
[network-tools](network-tools.md). For a single target, normalize a supplied
48-bit MAC to lowercase colon notation, accepting hyphenated or dotted input.
Match the complete address, not just its vendor prefix. An IP or display name
can change or match several records; retain the site's client UUID and MAC.
Use a supported filter when available, otherwise match the paginated results.
Pass the returned UUID, not a MAC or IP, as `clientId` to
`getConnectedClientDetails`.

For an inventory, start with `listConnectedClients`; retrieve details where
needed instead of calling every detail endpoint automatically. Record the site,
observation time, current name, client UUID, MAC, IP, connection type, and
`connectedAt` when returned. Preserve useful extra identity fields from actual
responses, with their field names. Missing information means unavailable,
not that the device lacks a feature. A complete connected-client list is still
not an inventory of offline devices or every physical device in the home.
If a target is absent, say it was not found among currently connected clients
in the checked site. Inspect adopted-device inventory when the target could
be UniFi infrastructure; do not substitute an unrelated client with the same
vendor. An access failure or partial list cannot establish absence.

Join a wired/wireless client's `uplinkDeviceId` to an adopted-device `id` in the
same site. Reuse `listAdoptedDevices` for shared uplinks and fetch
`getAdoptedDeviceDetails` only as needed. Report the upstream name and model as
the attachment point, keeping them separate from the client's product identity.
Unresolved IDs stay unresolved. Use any returned port, SSID, or network ID only
if the client evidence explicitly links it; do not infer membership from the
existence of a Wi-Fi broadcast or network.

An AP called "Office" indicates attachment to that AP, not proof that the
client is in the office. Radio range and roaming cross room boundaries; an
upstream switch may have an unmanaged switch behind it. Separate network
attachment from physical location, and mark room as unknown unless the user or
another correlated source establishes it. Do not infer room from signal level
alone.

## Identify the finished product

Keep these evidence classes distinct:

| Evidence                                                                                          | What it supports                                                                 |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Device label/app or self-reported model, correlated to the client MAC; explicit user confirmation | A confirmed product identity at the specificity actually established             |
| UniFi product fingerprint, model-like hostname, existing alias, DHCP/mDNS/SSDP description        | A candidate identity; labels may be manual, stale, generic, or incorrect         |
| IEEE address-block assignee                                                                       | An interface vendor clue, which may be a chip/module supplier or OEM             |
| AP/switch attachment, SSID, traffic category, or operating system                                 | Context about use or connectivity; insufficient alone to identify a retail model |

The current API's `name` is not guaranteed to be a raw hostname. Preserve the
distinction if a source provides both. For UniFi infrastructure, its own
adopted-device `model` is direct controller evidence about that device.
Several devices can share a hostname, alias, module, or product family. Do not
merge them, or merge wired/wireless/private MACs into one device, without a
verified link. A hub's network MAC does not identify each accessory behind it.

For a globally administered MAC, an IEEE registry lookup can establish the
address-block assignee. Account for MA-L, MA-M, and MA-S assignments with the
longest matching prefix; do not assume every assignment is 24 bits. Keep the
assignee separate from the product brand. If the first octet has its local bit
set (`first_octet & 0x02`), flag a locally administered/private MAC and skip
vendor attribution from its prefix. This is not proof of an unrecognized or
hostile device, and disabling private addressing is not needed for this lookup.

Use additional identity evidence already available through connected sources
or supplied nonsecret exports: controller Device Identification, device-app
inventory, DHCP/DNS records, or existing mDNS/SSDP/LLDP observations. Correlate
them to the same device and observation period. These are possible sources,
not extra UniFi tools. The current integration contract does not expose those
discovery records or a client fingerprint catalog. Do not invent legacy
controller calls or decode a numeric fingerprint ID without its matching
catalog. If richer UI data is needed, identify the specific client/model fields
needed from an export. Inspection does not authorize enabling DPI, installing
a scanner, scanning the LAN, or changing network settings.

## Research and verify the product

Use `perplexity_search_tool` for focused public searches based on an observed
model token, product-like hostname prefix, service description, or candidate
brand/category. Start with the strongest clue; search the block assignee only
as a vendor clue when needed. Use `webscrape_tool` to read a relevant public
vendor product page, support document, manual, or regulatory filing, and cite
the exact URL supporting a model mapping or product specification.

Send only the product clues needed for research. Keep full client MACs, IPs,
serial numbers, personal hostname suffixes, room labels, and inventory exports
out of public searches; a registry lookup needs only an assignment prefix.
`webscrape_tool` fetches public URLs and is not a LAN discovery tool: do not
use it to access private IPs, local hostnames, or controller credentials.

Check whether documentation matches the observed identifier, product family,
and available distinguishing features. A chip vendor's customer list, shared
protocol, or an image resembling UniFi's icon does not prove a specific model.
A public manual confirms what a model is, not that this client is that model.
When sources conflict, retain the conflict and lower the identification
confidence rather than choosing the most specific label.

Report **confirmed** when device-linked evidence or user confirmation establishes
the identity; **likely** when a specific clue and corroborating evidence support
a candidate; **unresolved** when evidence identifies only an interface vendor,
category, or conflicting candidates. State the basis and uncertainty instead
of inventing numerical confidence. A confirmed category or product family
does not imply a confirmed model or hardware revision.

If only an address-block vendor is available, report the product as unknown.
Stop broad model guessing and request the smallest useful missing observation,
such as the device app's model and MAC or a controller identification export for
that client. Continue reporting the supported network attachment and other
clients while that information is missing.

## Propose useful names and return the inventory

Reuse a naming convention already supplied by the user. Otherwise propose
lowercase, hyphen-separated `<room>-<role>-<product>-<index>` names, omitting
unknown segments. For example, a confirmed office printer might become
`office-printer-01`; include a verified product token when useful. Use a stable
suffix to resolve duplicates, not an IP or connection order. For an unresolved
client, a temporary `unknown-<mac-tail>` label can distinguish it without
claiming a product or room; check for suffix collisions. Private MAC rotation
can change that temporary identifier.

For one device, return the supported identification first, then evidence,
attachment, confidence, and proposed name. For an inventory, use a compact table
with current name, MAC/IP, product brand/model, confidence and basis, upstream
AP/switch, known room, and proposed name; include public product links near the
claims they support. State the site/time and material coverage gaps. Separate
interface vendor from product brand when they differ, preserve current names
alongside proposals, and leave missing fields explicitly unknown. Research
alone does not rename clients, set DHCP reservations, change DNS, or persist
inventory facts to memory. Requested writes follow the parent skill's available
capability and runtime authorization boundary.

## Source contracts

- [UniFi client details API](https://developer.ui.com/network/v10.4.57/getconnectedclientdetails)
  documents the pinned integration response. The maintainer snapshot cited in
  [network-tools](network-tools.md) includes its wired/wireless schemas; actual
  connected responses determine what is available on a newer controller.
- [UniFi Traffic and Device Identification](https://help.ui.com/hc/en-us/articles/12570783535383-UniFi-Gateway-Traffic-and-Device-Identification)
  describes manufacturer, model, and OS in the Client Devices UI, with gateway
  and feature prerequisites. UI availability does not imply API exposure.
- [IEEE MAC address registries](https://standards.ieee.org/products-programs/regauth/mac/)
  explain the assignment sizes, and
  [IEEE EUI/OUI/CID guidelines](https://standards.ieee.org/wp-content/uploads/import/documents/tutorials/eui.pdf)
  describe organizational identifiers and local addressing. These establish
  address allocation semantics, not the retail product containing an interface.
