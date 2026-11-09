# Autonomy

The Autonomy tab shows the latest short note for each area, current work and
paged ideas behind a closed **Ideas** control. **Add automation** also starts
closed, leaving current results in view. A blocked task explains what is affected, what the human can do,
and how to verify the fix in two or three sentences. The agent runs inside a
human-owned environment with partial access; missing repository, deployment or
service access should produce useful guidance for the owner.

There is no briefing or action-history view. Diagnostic evidence, skipped-action
lists, recommendations, continuity notes and full run records remain in backend
storage for recovery. They are excluded from the dashboard response and DOM.
The response contains the latest outcome per area, running actions, a bounded
sample of queued work with its total count, and up to 30 short pending ideas.
Existing long notes are bounded for display; legacy blocked notes carry forward
the first recommended step when available. Stored records remain unchanged.

Refresh, checks, pause/resume, cancellation, import and feedback actions show
progress and completion or failure. A queued check stays distinct from running
work and verified completion. The dashboard polls while visible, retains the last
successful view on errors, and rejects refresh results that predate a mutation.

Open **Add automation**, then use **Describe an automation** to write a request in plain language. **Preview
automation** translates it into supported settings without running tools or
saving changes. The preview shows the trigger, scene, days, months and check
cadence. Missing details produce a question; unsupported requirements produce a
limitation. **Save automation** applies the reviewed plan. Failed requests retain
the draft. Saving while Autonomy or Home is paused does not resume it.

For example:

> At Steelers kickoff, set the house lights to the "Go Steelers!" scene. Only
> check on Sundays, Mondays and Thursdays from September through February.

This adds a separate football lighting rule with weekdays `[6, 0, 3]` and months
`[9, 10, 11, 12, 1, 2]`. It preserves the existing MSU rule. Discovery and game
activation both obey these filters in Eastern time, including daylight saving.
The default preview checks hourly and allows a 15-minute missed-start window.
The worker verifies the game start and resolves the named Hue scene at runtime;
the preview does not claim the scene exists. Home lists saved rules with pause,
resume and removal controls. Removing a rule cancels its pending work; stopping
an in-flight request does not undo effects already applied.

Natural-language requests currently support game-start lighting for football
and men's basketball, and settings for calendar discovery, cluster checks and
improvement reviews. Arbitrary code, new services, presence/TV conditions,
end-of-game actions and fixed-time recurring lighting are unsupported. The
planner must report these limits rather than hide unsupported conditions in
free-text instructions. Review the preview before saving: model interpretation
can be wrong, while the validated fields determine the worker's schedule.

The signed-in frontend calls `POST /api/autonomy/plan` to preview and `PUT` to
save. The private Rust route `/internal/autonomy/plan` uses the configured main
model with no tools, persisted conversation or execution path. It requires Rust
preparation and does not require enabling the optional public model endpoint.
Frontend validation rejects unsupported fields, incomplete plans and tool-calling
responses. New rules append atomically; repeated saves of the same plan do not
duplicate a rule. Settings edits reject a preview if the configuration changed.

Expand **Automation JSON** to download the current configuration as a template,
then upload a complete configuration or a partial settings object (up to 128 KB).
Uploads are validated against the same generated contract as the API and shown
for review before **Apply JSON**. Omitted fields are preserved, invalid fields
are rejected, and failed saves retain the upload for retry. JSON configures the
supported responsibilities; it cannot introduce arbitrary executable tasks.

Workers load humanizer before writing public notes. Publication validation limits
outcome notes to one paragraph, three sentences, 80 words and 600 characters.
Routine success can use one sentence; blockers should name a supported owner
step and verification. Proposal titles allow ten words/80 characters and benefits
35 words/240 characters. Overlong completions receive correction feedback within
the same run; they cannot bypass validation or replay earlier mutations. The
limits preserve partial-failure and uncertainty status. They do not establish that
a suggested fix will work: the note must retain that uncertainty.

For example, this partial upload changes only cluster-check cadence:

```json
{
  "responsibilities": {
    "cluster": { "intervalSeconds": 1800 }
  }
}
```

The autonomous worker owns four independently scheduled responsibilities:

- **Local calendar:** discover practical dates and community activities, then
  reconcile individual events through the user's connected Google MCP account.
- **Game lighting:** discover configured teams’ football and men's basketball schedules and apply
  the configured scene once at each game start. Unreachable lights are skipped.
  MSU is the default; additional rules can target other teams. There is no
  end-of-game action.
- **Cluster maintenance:** investigate unhealthy workloads, preserve diagnostics,
  clean up failed pods, restart workloads and perform bounded configuration or
  resource repairs. Software upgrades are recommendations only.
- **Continual improvement:** use preferences and outcomes to propose additional
  responsibilities. A proposal does not grant new execution authority.

Improvement reviews receive up to six recent actions from each responsibility,
their configured boundaries, continuity notes and proposal feedback. This keeps
frequent cluster checks from crowding out calendar and home outcomes. Other
tasks retain their own scoped context. Notes and diagnostics remain untrusted
evidence, never instructions or permission.

Cluster checks include Daedalus's own services when within configured scope.
They discover actual workloads, correlate logs with previous outcomes, recheck
prior repairs and retain bounded follow-up notes. Improvement reviews can inspect
that evidence through read-only tools and propose a hypothesis with a validation
plan. Repairs remain within the existing cluster task boundary; code, prompts,
deployment changes and additional permissions remain proposals. The agent does
not autonomously rewrite or deploy itself, or change its evaluation criteria.

Dates and schedule windows use `America/Detroit`, including daylight-saving
changes. All-day calendar entries remain date-only; timed entries use explicit
offsets and the Michigan timezone.
Calendar and sports discovery default to six-hour intervals, cluster checks to
15 minutes, and improvement review to daily. Individual intervals and pauses are
configurable; **Pause all** also stops an active backend request. **Check now**
queues eligible checks without creating duplicate pending work. Home checks each
enabled rule that is within its configured days and months.

## Configuration and identity

Set `autonomousAgent.userId` in the Helm chart to the actual account that owns the
Google MCP connection. The worker sends that authenticated identity to the
backend; the model never supplies a user ID to tools. An existing valid or
refreshable Google grant is reused without a chat session. If the grant is
unavailable, the run records the limitation without opening interactive consent.

`GET/PUT /api/autonomy/config` reads or patches the signed-in user's charter.
Unknown keys, retired modes, invalid timezones and out-of-range settings are
rejected. The Python model in
`builder/autonomous_agent/src/autonomous_agent/charter.py` owns the config schema;
regenerate the frontend contract with:

```sh
builder/.venv/bin/python scripts/generate_autonomy_contract.py
```

JSON settings include calendar selection, local sources/preferences/reminders, lighting
team, sports, scene and device selection, extra `lighting.rules`, weekdays
(Monday=0 through Sunday=6), months (January=1 through December=12),
missed-start allowance, cluster contexts and excluded
namespaces, cluster-managed configuration, non-node LAN verification source,
maintenance boundaries, tool-call budget and run deadline. Defaults limit each
run to 40 tool calls and 600 seconds. The missed-start allowance is 15 minutes.
A game that is already beyond that window is recorded as expired.
Each extra lighting rule needs a unique `id` and a `title`; omitted optional
fields use the standard lighting defaults. JSON arrays replace the existing
array, so include all rules when uploading `lighting.rules`. Use natural-language
creation to append one rule without replacing others.

Calendar destination selection uses the configured ID, a saved user preference,
or the only writable calendar. Multiple writable calendars with no preference
require a selection before a write. Existing calendar events are read before
writing and source changes are compared with previously observed remote state so
user edits can be preserved. Event descriptions carry a stable source marker.

## Execution boundaries and recovery

`autonomy:<user>:charter:state` stores scheduled actions, run outcomes, managed
calendar records, notes, proposals, daily reports and reporting fingerprints.
`autonomy:<user>:charter:config` stores operator settings. All worker changes are
transactional and fenced by the per-user lease; claiming an action also watches
configuration so a racing pause is rechecked before dispatch. The frontend uses
compare-and-set writes against the same state.

The worker records intent before contacting the backend. A restarted worker
marks interrupted dispatched work uncertain. Lighting is not replayed after an
unknown outcome. Calendar reconciliation searches the stable remote event marker
before any write. Cluster checks inspect fresh state before choosing another
repair. Deferred work is bounded by the configured attempt count and backoff;
a result cannot classify an attempted mutation as deferred for automatic retry.
Calendar work deferred without a mutation can be reconsidered on a later source
check after the discovery interval, allowing restored Google access to unblock it.
Explicit pre-stream admission refusals from the internal backend use bounded
deferred retries, including during rolling deployments. Interrupted streams and
server/gateway failures remain uncertain and do not authorize blind replay.
After a mutation, the runtime requires a successful state read from the affected
service before accepting completed or partial status. The agent still must
compare that evidence with the intended result; a successful read alone does not
establish application recovery.

The runtime enforces the selected task's tool boundary and budget. Discovery
cannot execute calendar or lighting writes. Charter runs cannot use generic
shell/delegation tools or skill scripts, Helm mutations, software image changes or persistent-volume
deletion. Cluster repairs use workload restarts, pod cleanup, ConfigMap data merge
patches, or strategic patches of named containers' resource requests/limits.
Strategic patches preserve container images and unmentioned containers.
Application checks may use `execInPod` only for a bounded HTTP(S) GET with
`curl --fail --silent --show-error --max-time 10 <health-url>`. Shells, uploads,
redirects and arbitrary commands remain unavailable. A pod-origin health check
does not qualify as non-node LAN verification.

Cluster-managed configuration is the durable source. Before a configuration or
resource patch, read the current object, create a `daedalus-autonomy-backup-*`
ConfigMap containing its JSON snapshot in the same namespace, and read it back.
The runtime binds that successful backup to the source object, namespace, and
explicit Kubernetes context before allowing a patch. Backup ConfigMaps cannot
be overwritten or deleted by charter tasks. Retain the backup identity and a
rollback patch in the action evidence. If a required namespace is unwritable,
leave the repair deferred.

Inspect ownership before changing desired state. For Helm/GitOps-managed fields,
use an available authoritative in-cluster source or report the external-owner
limitation. The charter does not edit repositories or Helm release records and
does not claim direct patches will survive external reconciliation. Preserve fixed
NodePorts, ingress routes, ordinary LAN client access and inter-service
connections. Changes to network behavior require inventory of affected consumers
and verification from a non-node LAN source. If those prerequisites cannot be
satisfied, defer that change rather than claiming a successful repair. Never
interpret failed-pod deletion as root-cause recovery without verification.

`GET /api/autonomy/state` returns the compact dashboard projection. POST requests
an existing responsibility, cancels an action, or records whether an idea is
useful or dismissed. Marking an idea useful does not grant new execution
authority. Cancellation closes the backend stream; uncertain remote effects
remain recorded. Periodic action and
run histories use `maxRunsStored`; event identities remain for a year or while
their calendar event is still upcoming. Expired calendar snapshots are removed,
while user dismissal identities remain. Prompt context includes the selected
calendar record or at most 100 discovery records.

## Retired implementation

The research-feed modes, exploratory lanes, feed similarity dedupe, goal cadence
scheduler, model-authored workspace personas, and their HTTP endpoints are
removed. The charter uses a separate namespace and does not read or migrate old
queued research into executable tasks. Old Redis data remains inert so replacing
code does not delete user history. No compatibility switch activates the retired
worker.

## Validation

The charter unit tests cover date-only windows, daylight-saving offsets, stale
announcements, schedule changes, repeated observations, missed starts and digest
deduplication. `builder/tests/test_autonomous_store.py` runs against disposable
Redis to exercise real transactions, lease transfer, concurrent claims,
cancellation and restart handling. Enable it with `PYTEST_USE_REAL_REDIS=1` and a
disposable `REDIS_URL`, or run `make test-integration`. Frontend config, API, store
and dashboard tests cover the same user-facing contracts. Runtime changes require
`make rust-check` and an HTTP request against the built image; unit checks alone
do not prove a real connected calendar, Hue bridge or cluster is reachable.
`builder/migration/autonomy_http_check.py --image <backend-image> --redis-image
<redis-image> --preparation rust` exercises the charter against synthetic MCP
and model peers; repeat with `--preparation python` for the alternate preparation
path. It verifies per-user Google grants, read/write task separation, partial
lighting, bounded calls, and upgrade/duplicate-mutation rejection. Completion
checks use the actual worker schema and Pydantic validators, including safe
correction of invalid fields, timestamps, source URLs, duplicate identities,
missing evidence, event ordering and oversized observed state. Correction reuses
completed research within the same run.

The former autonomy briefing publisher and schedule are removed. Pending legacy
`daily_summary` jobs are cancelled without model dispatch or publication. Old
`summary` and `maxSummariesStored` configuration fields are ignored on read/import
and omitted from exports. Historical briefing data stays inert in storage for
compatibility and is never returned to the dashboard. This does not change the
separate, user-requested news briefing capability in chat.
