---
name: use-hue-api
description: Use the Philips Hue Bridge CLIP API v2 to inspect resources, construct requests, and carry out authorized lighting or configuration changes using bundled operation contracts. Use for Hue REST API work and interpreting schemas or responses; use discovered hue_mcp_server tools for live Daedalus operations.
---

# Use the Hue CLIP API

Use the bundled [operation reference](references/api-reference.json) as the contract
for the requested operation. No HTML export or download is needed. The bundle
describes 155 REST operations; the connected `hue_mcp_server` determines which
operations are available as MCP tools. Documentation
coverage does not prove that a feature exists on the connected bridge's model
or firmware.

## Find the relevant contract

Use the bundled, read-only [reference reader](scripts/read_reference.py) to select
an operation instead of loading the entire JSON reference into context.
For local maintenance, run it from the repository root:

```bash
python3 skills/use-hue-api/scripts/read_reference.py list light
python3 skills/use-hue-api/scripts/read_reference.py show resource_light__id__put
python3 skills/use-hue-api/scripts/read_reference.py show resource_light__id__put --part response
```

In Daedalus, load resources with
`agent_skills_tool(operation=load_skill, skill_name=use-hue-api, resource=...)`.
Loading a script returns text. To run the reader in `llm_sandbox_tool`, explicitly
stage both `scripts/read_reference.py` and `references/api-reference.json`,
preserving their relative layout; the sandbox does not inherit `/skills` or
bridge credentials. Use connected MCP tools for live bridge operations.

`list` accepts an optional resource-name filter and reports exact methods, paths,
and stable operation anchors. `show` defaults to the request; choose `response`,
`securedby`, or `all` as needed. Some collection GETs have no request section; read their response
section with `--part response`. Output identifies the bundled source, operation,
section, and numbered text lines. Continue with `--start-line N --lines N` when
content remains. Read the relevant fields and their parent objects, not just a
search hit without context.

The bundle preserves request/response/security text, examples, and writable body
schemas from the supplied reference, with equivalent repeated operations removed.
It records the original source checksum and copy counts for provenance; that source
is not required to read or validate the bundle. The helper resolves its default
source relative to itself, so it works from any working directory. Use
`--source /path/to/api-reference.json` before the subcommand for another compact
reference. Neither the reader nor the importer contacts a bridge or fetches docs.

Before constructing a request, inspect its method-specific request properties,
required fields, enum values, bounds, and response contract. Some illustrative
objects include fields that are not listed as writable: follow the request's
property definitions instead of copying a full GET response or example into PUT.
Read-only, deprecated, optional, and device-dependent fields need distinct treatment.

## Choose the transport and credentials

For direct REST calls, the base is `https://{bridge}/clip/v2`. Append the documented
path, such as `/resource/light/{id}`. When the bridge client uses `HUE_BRIDGE_URL`
as its HTTPS origin, append `/clip/v2` once. Authenticate with the
`hue-application-key` header; JSON request bodies use `Content-Type: application/json`.

For an authorized direct REST integration, load `HUE_APPLICATION_KEY` or
`HUE_APPLICATION_KEY_FILE` from the operator's
configured environment/secret source. Parse `.env` as data, preserving the
project's environment-override behavior. Keep keys out of model messages, URLs,
shell arguments, and logs. If credentials are absent, follow the Hue MCP server's
onboarding instructions within the user's setup scope; an API-use task alone
does not request re-pairing. Daedalus's `HUE_MCP_TOKEN` authenticates to the MCP
server and is not a bridge application key.

Verify both the CA chain and bridge identity. `HUE_CA_BUNDLE_FILE` supplies optional
vendor trust, and `HUE_BRIDGE_ID` is the expected TLS server name when connecting
to the bridge's IP. A direct bridge client must configure its SSL context and
server name accordingly, for example through HTTPX's `sni_hostname` extension.
Use bounded timeouts, keep credential-bearing requests on that origin, and do not
disable TLS verification to work around a trust error.

If the user is using the MCP server, follow the discovered tool schemas and
[Daedalus MCP configuration](../../docs/operations.md#adding-or-expanding-an-mcp-server).
When advertised, native `hue_list_`, `hue_get_`, `hue_update_`, `hue_create_`, and
`hue_delete_` tools map to the documented operations. Native writes take `body` with Hue fields
and, for item routes, `resource_id`; collection light PUT uses
`hue_update_batch_light`. Follow `data.next_cursor` for complete collection reads.
MCP uses `/mcp` and its own bearer token; `brightness_percent`, `transition_ms`,
and tool result statuses are convenience-wrapper concepts. Do not send these as raw Hue fields, use the MCP bearer token as a Hue
key, invent a tool for an undocumented operation, or assume convenience-wrapper
restrictions describe the native tools. Native write `read_back` defaults to true;
`observation_only` is not a field-match or action-completion guarantee. Use the
transport the task authorizes.

## Resolve targets and capabilities

Start with reads. `GET /resource` (operation `resource_get`) supports a
comma-separated `type` filter, such as `light,room,zone,scene`. Specific collections
and item reads are listed by the helper; do not assume every resource implements
every CRUD method or invent pagination parameters absent from its contract.

Resolve a name to a current resource `id` and `type`. Names can collide, and a
physical device can own multiple services. Use `owner`, `services`, and
`{"rid": "...", "rtype": "..."}` references to traverse those relationships.
Ask for clarification when those relationships do not identify the intended
target. Example UUIDs in the documentation are not live IDs.

For a room/zone lighting action, find its `grouped_light` service ID rather than
using the room/zone ID on a light endpoint. For a scene, check its group and action
targets. For membership changes, inspect the current children and the exact
operation: the supplied room example uses device children, while the zone example
uses light children. Preserve the intended `rtype`; do not impose the convenience tools'
device-only membership input on direct REST requests.

A GET response also establishes capabilities: supported effects, color gamut,
`color_temperature.mirek_schema` bounds, and sensor validity/report timestamps.
The schema's broad numeric range is not proof that a particular light supports
that range. Omit unsupported fields and explain the limitation instead of silently
changing the requested result.

## Construct and execute the requested change

Use the smallest body that expresses the user's requested changes. Leave unrelated
properties out. Respect nested required fields when including an optional object;
omit unused optional fields rather than sending null unless explicitly supported.
Collection and item operations may have different body shapes: for example,
`PUT /resource/light` documents an array while `PUT /resource/light/{id}` uses an object.

Common operations, after resolving real IDs and capabilities:

| Intent                            | Operation                           | Request body or important distinction                                                                                                           |
| --------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn a light on at 35%            | `PUT /resource/light/{id}`          | `{"on":{"on":true},"dimming":{"brightness":35}}`                                                                                                |
| Turn a room/zone's lights off     | `PUT /resource/grouped_light/{id}`  | `{"on":{"on":false}}`, using its grouped-light service ID                                                                                       |
| Set a supported white temperature | `PUT /resource/light/{id}`          | `{"color_temperature":{"mirek":250}}`; use the device's supported bounds. Kelvin converts as `mirek = 1000000 / kelvin`, rounded to an integer. |
| Recall an existing scene          | `PUT /resource/scene/{id}`          | `{"recall":{"action":"active"}}`; inspect the scene request for optional transition/brightness fields.                                          |
| Create a scene                    | `POST /resource/scene`              | Read the create schema for required `actions`, `metadata`, and `group`; creation and recall are separate operations.                            |
| Change membership or metadata     | The documented room/zone item `PUT` | Read the current group and preserve members outside the user's requested change; do not send an empty or partial membership list inadvertently. |

Brightness zero is the lowest brightness, not an off command. Include the explicit
`on.on` value when the requested outcome includes power state. Light transitions
use `dynamics.duration` in milliseconds; inspect scene recall's own duration field
instead of assuming the same nesting for every operation. Color coordinates are
CIE xy, not RGB values.

Perform only the requested mutations with the authorization already established
in the session. Resolve ambiguous targets or materially broader consequences
before acting. Device deletion, room/zone membership changes, and bridge or
security configuration changes must not become incidental steps in a lighting task.

## Interpret results and stop safely

Inspect both the HTTP status and JSON `errors`/`data` arrays. Item reads also return
an array in `data`. Write responses can contain only `{rid, rtype}` references,
which acknowledge affected resources rather than prove the desired final state.
The documented HTTP `207` result is partial success; retain both changed targets
and failures. An HTTP `200` is not sufficient when `errors` is nonempty.

After a write, read the relevant resource state back, allowing for any requested
transition. Compare the requested fields, and for group operations check member
lights when the requested claim concerns all members. Report whether the command
was acknowledged, subsequently observed, partly successful, or uncertain.
Bridge-reported state is not independent physical confirmation.

Use bounded backoff for transient read failures or rate limiting. Correct an
invalid request, permission problem, stale ID, or conflict before retrying.
After a mutation times out or its connection drops, read/reconcile first: do not
blindly replay scene creation, recall, deletion, deltas, or other actions whose
first execution may have occurred. Stop and report uncertainty when a read cannot
establish whether another write is needed.

When explaining or reviewing an integration, cite the bundled reference's operation
anchor, section, and text lines from the reader, and distinguish reference-derived
behavior from an actual bridge response. The supplied
reference does not document an event-stream endpoint or credential provisioning;
do not infer those protocols from this REST resource reference.

## Refresh the reference only when requested

Ordinary use and repository validation need only the bundled JSON. To import an
authorized newer RAML HTML export, use the optional [importer](scripts/import_reference.py):

```bash
python3 skills/use-hue-api/scripts/import_reference.py /path/to/hue-reference.html
```

The importer rejects differing repeated operation contracts before writing the
bundle. Review the reference diff, exercise the reader, and run the skill catalog
and pre-commit checks described in [skills/AGENTS.md](../AGENTS.md#validation).
Any generated MCP schemas belong to the Hue server repository and need that
repository's contract checks. Keep the original export outside this repository;
do not restore it as a skill dependency.
