---
name: use-hue-api
description: Inspect and control Philips Hue lighting through the connected Hue MCP, with verified targets, RGB/xy conversion, and bounded readback. Also provides self-contained CLIP API v2 REST guidance for an explicitly supplied operator environment.
---

# Use the Hue CLIP API

This document can be used on its own. The connection requirements, resource-method
map, common request shapes, color formulas, and verification workflow are inline.
No repository checkout, helper script, companion document, or HTML export is
required. Live operations still need the user's authorized bridge or MCP
connection and credentials. The public source links at the end are provenance,
not prerequisites for the workflows described here.

The operation map reflects the supplied Hue resource contract reviewed on
2026-09-19: 155 REST operations across 45 service types. A documented operation
does not prove support on a particular bridge model, firmware, or device.

## Daedalus integration

In Daedalus, use the registered `hue_mcp_server` leaf tools and their schemas.
The runtime supplies the service token, handles the approval boundary, and
derives user context; do not initialize a second client, read a key, pair the
bridge, or route around the gate through sandbox HTTP requests. Read operations
are available without mutation approval; writes follow the existing runtime
gate and the user's established scope. Background runs retain their read-only,
non-interactive restrictions.

Prefer a convenience lighting call when it expresses the requested change;
use native tools for Hue fields or resources it cannot represent. Load no
maintenance JSON for an ordinary lighting request. Recover relevant omitted
compacted inventory rows with `tool_output_retriever_tool` before claiming
complete membership or absence. Direct REST guidance below applies only when
the user separately supplies an authorized operator execution environment.

## Choose the transport and credentials

Use the transport the user has authorized. For direct REST, use the operator's
HTTPS bridge origin with the base path `/clip/v2`, then append a resource route.
For example, `GET https://{bridge}/clip/v2/resource/light`. If `HUE_BRIDGE_URL`
contains only the origin, append `/clip/v2` once. Authenticate with the
`hue-application-key` header; JSON bodies use `Content-Type: application/json`.

Obtain the key from the configured secret source, commonly `HUE_APPLICATION_KEY`
or `HUE_APPLICATION_KEY_FILE`. Read file-based secrets locally. Keep keys out of
conversation text, URLs, shell arguments, and logs. Parse any environment file as
data rather than sourcing it as shell code; explicit environment settings should
win. If credentials or trust material are absent, have the operator provision
those through their authorized Hue setup flow. A lighting request does not
implicitly request discovery or re-pairing.

Verify both the CA chain and bridge identity. `HUE_CA_BUNDLE_FILE` may provide
vendor trust, and `HUE_BRIDGE_ID` may provide the expected TLS identity when
connecting by IP. Configure the TLS client to validate that server name as well
as the chain; for HTTPX, an SSL context plus the request extension
`{"sni_hostname": bridge_id}` implements that distinction. Use bounded timeouts,
keep credential-bearing requests on the configured origin, and do not disable
TLS verification or follow a redirect to another origin to work around a failure.

For the Hue MCP server, use its configured `/mcp` Streamable HTTP endpoint and
`Authorization: Bearer <service token>`. The MCP token is separate from the Hue
application key. Use an MCP client to initialize and discover `tools/list`, or
inspect the tool definitions already exposed by the host. Follow each discovered
`inputSchema`; do not assume every installation exposes the complete catalog.
Use HTTPS or an authenticated loopback tunnel for remote operator access. Native
clients omit `Origin`; browser origins must be explicitly permitted by the server.

## Map REST operations to native MCP tools

The Hue MCP server described here exposes the 155 native operations plus eleven
convenience tools. Native calls retain Hue field names and shapes:

| REST operation                 | Native MCP tool          | Arguments                                                          |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `GET /resource`                | `hue_list_resource`      | Optional `type` comma-separated filter; optional `limit`, `cursor` |
| `GET /resource/{type}`         | `hue_list_{type}`        | Optional `limit`, `cursor`                                         |
| `GET /resource/{type}/{id}`    | `hue_get_{type}`         | `resource_id`                                                      |
| `POST /resource/{type}`        | `hue_create_{type}`      | `body`; optional `read_back`                                       |
| `PUT /resource/{type}/{id}`    | `hue_update_{type}`      | `resource_id`, `body`; optional `read_back`                        |
| `DELETE /resource/{type}/{id}` | `hue_delete_{type}`      | `resource_id`; optional `read_back`                                |
| `PUT /resource/light`          | `hue_update_batch_light` | Array `body`; optional `read_back`                                 |

Replace `{type}` with an actual service type below. Native collection results
contain `data.resources`, `data.returned_count`, and `data.next_cursor`. Follow
`next_cursor` until null when complete coverage matters, retaining the same tool
and filters; `limit` defaults to 50 and accepts 1–200. These are MCP snapshot
pagination controls, not Hue REST query parameters. Raw `GET /resource` supports
`?type=light,room,zone,scene`; do not invent pagination parameters for the bridge.

Native writes default `read_back` to true. `body` is the raw Hue object, except
batch light PUT which uses an array. A tool's `observation_only` readback does not
mean its requested fields matched or its physical action completed.

### Resource-method map

Every resource type in the table supports both collection GET and item GET.
“Yes” marks additional supported methods; “—” means no such operation in this
contract. `POST` and batch `PUT` use the collection path; item `PUT` and `DELETE`
use the item path. Together with `GET /resource`, this yields 91 GET, 42 PUT,
10 POST, and 12 DELETE operations.

| Resource type                 | POST collection | PUT item | DELETE item | PUT collection |
| ----------------------------- | --------------- | -------- | ----------- | -------------- |
| `behavior_instance`           | Yes             | Yes      | Yes         | —              |
| `behavior_script`             | —               | —        | —           | —              |
| `behavior_script_formula`     | Yes             | —        | Yes         | —              |
| `bell_button`                 | —               | Yes      | —           | —              |
| `bridge`                      | —               | Yes      | —           | —              |
| `bridge_home`                 | —               | —        | —           | —              |
| `button`                      | —               | Yes      | —           | —              |
| `camera_motion`               | —               | Yes      | —           | —              |
| `clip`                        | —               | Yes      | —           | —              |
| `contact`                     | —               | Yes      | —           | —              |
| `convenience_area_motion`     | —               | Yes      | —           | —              |
| `device`                      | —               | Yes      | Yes         | —              |
| `device_power`                | —               | Yes      | —           | —              |
| `device_software_update`      | —               | Yes      | —           | —              |
| `entertainment`               | —               | Yes      | —           | —              |
| `entertainment_configuration` | Yes             | Yes      | Yes         | —              |
| `geofence_client`             | Yes             | Yes      | Yes         | —              |
| `geolocation`                 | —               | Yes      | —           | —              |
| `grouped_light`               | —               | Yes      | —           | —              |
| `grouped_light_level`         | —               | Yes      | —           | —              |
| `grouped_motion`              | —               | Yes      | —           | —              |
| `homekit`                     | —               | Yes      | —           | —              |
| `light`                       | —               | Yes      | —           | Yes            |
| `light_level`                 | —               | Yes      | —           | —              |
| `matter`                      | —               | Yes      | —           | —              |
| `matter_fabric`               | —               | —        | Yes         | —              |
| `motion`                      | —               | Yes      | —           | —              |
| `motion_area_candidate`       | —               | Yes      | —           | —              |
| `motion_area_configuration`   | Yes             | Yes      | Yes         | —              |
| `power_output_configuration`  | —               | Yes      | —           | —              |
| `relative_rotary`             | —               | Yes      | —           | —              |
| `room`                        | Yes             | Yes      | Yes         | —              |
| `scene`                       | Yes             | Yes      | Yes         | —              |
| `security_area_motion`        | —               | Yes      | —           | —              |
| `service_group`               | Yes             | Yes      | Yes         | —              |
| `smart_scene`                 | Yes             | Yes      | Yes         | —              |
| `speaker`                     | —               | Yes      | —           | —              |
| `switch_input_configuration`  | —               | Yes      | —           | —              |
| `tamper`                      | —               | Yes      | —           | —              |
| `temperature`                 | —               | Yes      | —           | —              |
| `wifi_connectivity`           | —               | Yes      | —           | —              |
| `zgp_connectivity`            | —               | Yes      | —           | —              |
| `zigbee_connectivity`         | —               | Yes      | —           | —              |
| `zigbee_device_discovery`     | —               | Yes      | —           | —              |
| `zone`                        | Yes             | Yes      | Yes         | —              |

The map establishes routes, not every writable field of every service. For
specialized configuration beyond the payloads below, inspect the discovered
native tool's method-specific input schema or an exact request contract supplied
by the user. Check nested required fields, enums, bounds, and optionality. If the
needed field contract is unavailable, identify the missing schema before writing;
do not infer writable fields from a GET response or guess them from a tool name.
Script-defined automation configuration can be opaque and bridge-validated.

### Convenience MCP calls

The eleven convenience tools are `get_bridge_status`, `list_resources`,
`get_resource`, `set_light_state`, `set_group_state`, `recall_scene`, `create_scene`,
`update_scene`, `delete_scene`, `update_room`, and `update_zone`. Their normalized
arguments differ from native Hue fields. Use the discovered schema for the
selected tool. Examples of convenience arguments:

```json
{ "resource_type": "light", "query": "desk", "fresh": true }
```

The object above is for `list_resources`. Resolve its results before passing an
actual UUID to `set_light_state`:

```json
{
  "light_id": "<resolved light UUID>",
  "state": { "on": true, "brightness_percent": 35 }
}
```

Convenience state fields include `on`, `brightness_percent`, `color_xy`,
`color_temperature_kelvin`, and, where supported, `transition_ms`. Do not send
those wrapper names as raw Hue body fields. xy and Kelvin are mutually exclusive
in convenience state; unsupported capabilities are rejected rather than clamped.
Convenience room/zone membership inputs use device IDs and replace the whole
list. Do not transfer that restriction to native room/zone bodies, which carry
explicit `{rid,rtype}` references. Native and convenience scene tool contracts
also differ; a scene creation call does not recall the scene.

## Resolve targets and capabilities

Start with current inventory reads. Resolve names to resource `id` and `type`;
UUIDs in examples are placeholders. Names can collide, and one physical device
can own multiple services. Traverse `owner`, `services`, `children`, and
`{"rid":"...","rtype":"..."}` references. Clarify the intended target when
those relationships do not uniquely identify it.

For room/zone lighting, use the group's `grouped_light` service ID on the
`grouped_light` route. The room/zone UUID itself is not that service ID. Check a
scene's `group` and action targets before recall or modification. For native
membership, retain each intended reference type: room examples use device
children, whereas zone examples use light children. Preserve members outside the
requested change when replacing a list.

Read capabilities from the actual lights: `color.gamut`, supported effects,
gradient support, and `color_temperature.mirek_schema`. Broad schema limits do
not imply a light supports the entire range. Treat absent/invalid sensor values
and their source timestamps separately from the time of the read. A fresh read
does not make an old measurement new.

## Construct the requested change

Send the smallest body expressing the requested change. Omit untouched properties
and unused optional fields; do not send null unless the exact field contract
permits it. Honor nested requirements when including an optional object. Do not
copy an entire GET resource or illustrative response into a PUT: gamut and
capability information are not lighting commands.

Common raw Hue request bodies, after resolving IDs and capabilities:

| Intent                   | Method and route                   | Body or field shape                                                                                                                      |
| ------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Turn on at 35%           | `PUT /resource/light/{id}`         | `{"on":{"on":true},"dimming":{"brightness":35}}`                                                                                         |
| Turn off a group         | `PUT /resource/grouped_light/{id}` | `{"on":{"on":false}}`, using its service ID                                                                                              |
| Change chromaticity      | Light or grouped-light item `PUT`  | `{"color":{"xy":{"x":0.3,"y":0.3}}}`, only if those coordinates fit every target; calculate requested RGB colors with the formulas below |
| Set white temperature    | Light item `PUT`                   | `{"color_temperature":{"mirek":250}}`, within that light's bounds                                                                        |
| Transition over 1 second | Light item `PUT`                   | Include `"dynamics":{"duration":1000}` alongside the requested state                                                                     |
| Recall an existing scene | `PUT /resource/scene/{id}`         | `{"recall":{"action":"active"}}`                                                                                                         |
| Rename a room or zone    | Room/zone item `PUT`               | `{"metadata":{"name":"Office"}}`                                                                                                         |
| Replace membership       | Room/zone item `PUT`               | `{"children":[{"rid":"<member UUID>","rtype":"device"}]}`; construct the full intended list and use its actual reference types           |
| Create a room or zone    | Room/zone collection `POST`        | `children` and `metadata` required; metadata needs a 1–32 character `name` and a documented `archetype`, such as `office`                |
| Remove a resource        | Supported item `DELETE`            | No request body; only when the user requested this deletion and its consequences are resolved                                            |

Brightness uses a percentage; zero is minimum brightness, not off. Use explicit
`on.on` when power is part of the request. Convert Kelvin to integer mirek as
`round(1000000 / kelvin)` for positive Kelvin input, then check the light's
`mirek_minimum` and `mirek_maximum`. xy and white temperature are alternative
ways to request a simple color change.

Scene creation uses `POST /resource/scene` with required `metadata`, `group`, and
`actions`. Each action requires a light `target` reference and an `action` object.
For example, after replacing the placeholders with live UUIDs:

```json
{
  "metadata": { "name": "Reading" },
  "group": { "rid": "<room UUID>", "rtype": "room" },
  "actions": [
    {
      "target": { "rid": "<light UUID>", "rtype": "light" },
      "action": { "on": { "on": true }, "dimming": { "brightness": 35 } }
    }
  ]
}
```

Creation saves the scene; a separate scene PUT recalls it. Optional recall fields
include `recall.duration` and `recall.dimming.brightness`; they are not nested
under the light's `dynamics` object. `recall.action` may be `active`, `static`, or
`dynamic_palette`, subject to scene/device support.

For supported light effects, native `effects_v2.action.effect` selects the effect;
use actual supported values and the discovered request schema for its parameters.
For gradients, `gradient.points` entries contain `color.xy`; the contract calls
for at least two points when writing them, with the relevant schema and device
setting the maximum. Scene and direct-light schemas can have different bounds.
Do not substitute arbitrary effect strings, unsupported points, or response-only
status fields.

Batch `PUT /resource/light` takes an array of light updates. Keep the actual light
`id` with its requested fields in each entry; do not wrap the array in a `data`
object or treat it as an item PUT. Handle partial results per target.

Perform only the requested mutations with the authorization already established
in the session. Resolve ambiguous targets or materially broader consequences
before acting. Device removal, membership changes, and bridge/security
configuration must not become incidental steps in a lighting task.

## Color conversion

### Choose a consistent conversion

The source contains two different RGB-to-XYZ matrices. Its numbered RGB-to-xy
section uses the **prose matrix** below, while `calculateXY` in its iOS example
uses the **SDK matrix**. The published xy-to-RGB matrix matches the SDK matrix,
not the prose matrix. Do not combine the prose forward conversion with that
published inverse and describe the result as a round trip.

For ordinary RGB/hex input, follow the numbered RGB-to-xy section (prose matrix).
For a preview using the same convention, use its derived inverse below. Use the
SDK pair when explicitly reproducing the SDK example. Preserve the chosen pair
through a conversion and state which convention an integration uses. An explicitly
different input color space needs its own conversion; RGB triplets alone do not
identify a color space.

### Read the target's gamut

Read the current light resource before preparing a write. Color capability is
represented by `color`; its `gamut` contains `red`, `green`, and `blue` xy vertices.
Prefer these actual vertices over hardcoded model names, generic A/B/C triangles,
or a shared default. Some color-capable lights omit gamut information. A missing
gamut is not proof of a full gamut.

The source's fallback triangle `(1,0), (0,1), (0,0)` represents a generic coordinate
domain, not a measured lamp capability. If a light omits its gamut, disclose that
device gamut fitting cannot be verified; do not claim a fitted or reproducible
color. The convenience tools reject xy when the reported gamut is missing or
degenerate. Native REST/MCP fields remain subject to the bridge's capabilities.

For groups, inspect each member. A shared xy must fit every participating light
to represent the same chromaticity across the group. Do not project against one
member and assume the result fits all others. Individual projections can produce
different colors; describe that approximation when using them.

### RGB or hex to xy

Parse `#RRGGBB` as three 8-bit channels; divide each by 255. Inputs already in
`[0,1]` need no division. Validate finite values and the input range. For each
normalized channel `c`, linearize it before multiplying by either matrix:

```text
linear(c) = c / 12.92                         if c <= 0.04045
            ((c + 0.055) / 1.055) ** 2.4     otherwise
```

Let `r, g, b` denote the linear channels. Each matrix below multiplies the column
vector `[r, g, b]` to give `[X, Y, Z]`:

```text
Prose RGB -> XYZ (from the numbered RGB-to-xy section)
0.4124    0.3576    0.1805
0.2126    0.7152    0.0722
0.0193    0.1192    0.9505

SDK RGB -> XYZ (from calculateXY in the source's iOS example)
0.664511  0.154324  0.162028
0.283881  0.668433  0.047685
0.000088  0.072310  0.986039
```

For `S = X + Y + Z > 0`, compute `x = X/S`, `y = Y/S`, and retain `Y` separately
as relative luminance. Fit `(x,y)` to the target gamut as described below. Gamut
projection changes chromaticity; it does not recalculate the source's `Y`.

For black (`S = 0`), xy is undefined. Do not divide by zero or turn the SDK's
`(0,0)` NaN fallback into a lamp color request. To request black/off, use
`{"on":{"on":false}}` and leave the stored color unchanged. Hue brightness zero
means minimum light output, so it is not an off command.

As a check before gamut projection, the prose matrix maps `(255,0,0)` to roughly
`xy=(0.6400745,0.3299705), Y=0.2126`; the SDK matrix maps it to roughly
`xy=(0.7006062,0.2993010), Y=0.283881`. These are different source conventions,
not interchangeable constants for “red.”

### Project an out-of-gamut xy onto the triangle

For triangle vertices `A,B,C` and candidate `P`, check containment first. With
`cross(u,v) = u.x*v.y - u.y*v.x`, calculate:

```text
D = cross(B-A, C-A)
s = cross(P-A, C-A) / D
t = cross(B-A, P-A) / D
inside = s >= -epsilon and t >= -epsilon and s+t <= 1+epsilon
```

Reject nonfinite vertices and a degenerate triangle (`abs(D) < 1e-12`) before
division. A small tolerance such as `epsilon=1e-9` includes boundary points
despite floating-point error. For a point outside the triangle, project onto
each of the three closed edge segments `A -> B`:

```text
t = clamp(dot(P-A, B-A) / dot(B-A, B-A), 0, 1)
Q = A + t * (B-A)
```

Choose the candidate `Q` with the smallest squared distance to `P`. Clamping `t`
includes the vertices when the perpendicular projection lies beyond an edge.
Reject invalid or degenerate triangles before dividing. Clamping x and y
independently to `[0,1]` does not fit a color to the lamp's triangular gamut.
Keep enough precision that rounding does not push a boundary point outside it.
Report the requested and projected xy when an exact requested color is unavailable.

### Map the result to Hue v2 or MCP

Chromaticity and brightness are separate inputs. For “change the color,” omit
brightness and power unless the user also requested those changes. An explicit
brightness percentage takes precedence over the RGB-derived `Y`. When reproducing
the RGB color's relative luminance is part of the request, the v2 mapping is
`dimming.brightness = 100 * clamp(Y, 0, 1)`. This is a control-value mapping, not a
calibration of physical lamp luminance. Do not send legacy `bri` values on v2.

For a computed in-gamut `x,y`, the following shapes illustrate a color change at
35% with the light explicitly on. Replace the symbolic coordinates with numbers:

```text
REST PUT /clip/v2/resource/light/{id} body:
{"on":{"on":true},"dimming":{"brightness":35},"color":{"xy":{"x":x,"y":y}}}

Native MCP hue_update_light arguments:
{"resource_id":"<light UUID>","body":{"on":{"on":true},"dimming":{"brightness":35},"color":{"xy":{"x":x,"y":y}}}}

Convenience MCP set_light_state arguments:
{"light_id":"<light UUID>","state":{"on":true,"brightness_percent":35,"color_xy":{"x":x,"y":y}}}
```

Native tools forward documented Hue fields; they do not convert RGB or project
xy. Convenience tools validate xy against the actual light gamut and reject
unsupported coordinates; they do not silently project them. For a simple color
change, choose either xy or a white-temperature request. The convenience schema
rejects simultaneous `color_xy` and `color_temperature_kelvin`.

After a transition, compare the light's returned `color.xy`, power, and any
requested brightness with the submitted values. The convenience verifier uses
an absolute tolerance of `0.005` per xy coordinate and 1 brightness percentage
point. Native `observation_only` readback requires that comparison by the caller.
Compare xy to the projected target; a clipped RGB color cannot round-trip exactly.

### xy and luminance to an RGB preview

Fit xy to the known target gamut first when previewing that lamp. Use relative
`Y` in `[0,1]`; `dimming.brightness / 100` supplies the v2 control-value
approximation. A chromaticity-only preview can deliberately use `Y=1`, as the
source's iOS example does, but then it does not reproduce the light's brightness.
An off light renders black. Handle mathematical `Y=0` as black before division,
but remember that an on lamp at v2 brightness zero still emits its minimum output;
that control-value approximation does not establish physical black. For `Y>0`,
reject nonfinite coordinates and invalid xy (`x<0`, `y<=0`, or `x+y>1`) before
dividing; do not hide a zero y with an arbitrary epsilon.

```text
X = (Y / y) * x
Z = (Y / y) * (1 - x - y)
```

Multiply `[X,Y,Z]` by the matching inverse to obtain linear `[r,g,b]`:

```text
Prose XYZ -> RGB (derived by inverting the prose matrix above)
 3.240625477  -1.537207972  -0.498628599
-0.968930715   1.875756061   0.041517524
 0.055710120  -0.204021051   1.056995942

SDK XYZ -> RGB (the source's published xy-to-RGB coefficients)
 1.656492  -0.354851  -0.255038
-0.707196   1.655397   0.036152
 0.051713  -0.121364   1.011530
```

For display output, clamp negative linear channels to zero. Following the SDK's
normalization step, if the largest channel exceeds 1, divide all three by that
maximum; handle ties as well. This changes intensity to fit the display range.
Then encode each channel:

```text
encoded(c) = 12.92 * c                         if c <= 0.0031308
             1.055 * c ** (1 / 2.4) - 0.055   otherwise
```

Clamp residual numerical error to `[0,1]`, multiply by 255, and round for an 8-bit
RGB/hex result. Clipping, normalization, lamp brightness response, and rounding
make this a preview rather than an exact measurement of emitted light. Never
assert exact round-trip equality after those operations.

### HSV input

Normalize hue modulo 360 and validate saturation/value in `[0,100]`. Convert HSV
to floating-point RGB in `[0,1]` (for example, Python's
`colorsys.hsv_to_rgb((H % 360) / 360, S / 100, V / 100)`), then start at gamma
linearization above. Do not divide those channels by 255 again. The source's
`int R/G/B` declarations would truncate fractional values; keep floats until
final display quantization. HSV value is not XYZ luminance or v2 dimming percent.

## Interpret results and stop safely

For direct REST, inspect both HTTP status and the JSON `errors` and `data` arrays.
Item reads also return an array in `data`. Write data may contain only
`{"rid":"...","rtype":"..."}` references, which acknowledge affected resources
rather than prove their final state. HTTP 207 is partial success. HTTP 200 with
nonempty `errors` is not complete success; retain both successful targets and
failures.

MCP structured results and their JSON text representation carry `status`, `data`,
`meta`, `warnings`, and `errors`. Read them rather than relying on HTTP status or
`isError` alone:

| Status     | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| `ok`       | Read/diagnostic completed; inspect dependency state and freshness too |
| `accepted` | Request acknowledged; final state unverified                          |
| `verified` | Later bridge-reported state matched the requested fields              |
| `partial`  | Successful and unresolved/rejected outcomes coexist                   |
| `failed`   | Invalid input, undispatched failure, or definite bridge rejection     |
| `unknown`  | Submission may have occurred; acceptance is uncertain                 |

After a write, read the affected resources back, allowing for the requested
transition. Compare the requested fields, and inspect group member lights when
the claim concerns all members. Report acknowledgement, observation, matching
state, partial completion, or uncertainty distinctly. Native `observation_only`
is not a field-match guarantee. Bridge state is not independent physical proof.

Use bounded backoff for transient reads and rate limiting, honoring `Retry-After`.
Correct invalid input, authentication failures, stale IDs, and conflicts before
retrying. If a mutation times out or its connection drops, reconcile with fresh
reads before another write. Do not blindly replay creation, recall, deletion,
deltas, or other actions that may already have happened. Stop when the evidence
cannot establish whether another write is needed.

Distinguish the documented API behavior from observations of the actual bridge.
This skill describes local resource REST operations and the Hue MCP mapping; it
does not specify entertainment frame streaming, camera media, cloud access,
credential-provisioning protocols, or an event-stream implementation.

## Source provenance

Resource routes and request examples are based on the supplied Hue v2 resource
contract reviewed on 2026-09-19. Color guidance is based on the user-supplied full
text of the Hue conversion page from that date. The prose-matrix inverse is
mathematically derived here; it is not presented as a verbatim vendor formula.
These external links identify the sources and may require a developer login:

- [Hue API v2 resource reference](https://developers.meethue.com/develop/hue-api-v2/api-reference/)
- [Hue RGB/xy conversion guidance](https://developers.meethue.com/develop/application-design-guidance/color-conversion-formulas-rgb-to-xy-and-back/)
