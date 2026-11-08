# Autonomous charter

The autonomous worker owns four independently scheduled responsibilities:

- **Local calendar:** discover practical dates and community activities, then
  reconcile individual events through the user's connected Google MCP account.
- **MSU lighting:** discover football and men's basketball schedules and apply
  the configured scene once at each game start. Unreachable lights are skipped.
  There is no end-of-game action.
- **Cluster maintenance:** investigate unhealthy workloads, preserve diagnostics,
  clean up failed pods, restart workloads and perform bounded configuration or
  resource repairs. Software upgrades are recommendations only.
- **Continual improvement:** use preferences and outcomes to propose additional
  responsibilities. A proposal does not grant new execution authority.

The Autonomy dashboard is the daily-summary destination. Defaults are 18:00 in
`America/Detroit`, including daylight-saving changes. All-day calendar entries
remain date-only; timed entries use explicit offsets and the Michigan timezone.
Calendar and sports discovery default to six-hour intervals, cluster checks to
15 minutes, and improvement review to daily. Individual intervals and pauses are
configurable; **Pause all** also stops an active backend request. **Check now**
queues an existing responsibility without creating duplicate pending work.

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

Settings include calendar selection, local sources/preferences/reminders, lighting
scene and device selection, missed-start allowance, cluster contexts and excluded
namespaces, cluster-managed configuration, non-node LAN verification source,
maintenance boundaries, tool-call budget and run deadline. Defaults limit each
run to 40 tool calls and 600 seconds. The missed-start allowance is 15 minutes.
A game that is already beyond that window is recorded as expired.

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

`GET /api/autonomy/state` returns the user's current charter state. Its POST
operations request an existing responsibility, cancel an action, or record
whether a proposal is useful or dismissed. Marking an idea useful records a
preference; it does not grant a new kind of execution authority. Running cancellation closes the backend stream; any uncertain remote
effects remain recorded. Daily summaries are built from persisted outcomes and
published atomically with their completion record. Unchanged findings are not
repeated on subsequent days. Action history retains verification evidence and
partial/failure status independently of summary delivery. Periodic action and
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
