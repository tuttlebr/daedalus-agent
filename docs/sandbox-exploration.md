# Secure sandbox exploration

`sandbox_exploration_tool` connects Daedalus to the separately deployed v2
exploration service in `daedalus-sandbox`. It supports offline Python/data runs,
durable files, cancellation, checkpoints/forks, experiment comparison, proposed
lessons and artifact publication. OpenShell isolates each run; Daedalus owns
identity, model access, planning and publication.

The existing `llm_sandbox_tool` continues to use the v1 Bubblewrap API. Its shared
API key and pod-local workspace IDs do not authorize v2 sessions. There is no
fallback between the services.

## Enable the integration

Provision the service first using the sandbox repository's `deploy/exploration.py`.
It creates the exploration control plane and synchronizes the grant-signing
Secret into the `daedalus` namespace. Its bootstrap is specific to that
installation; adapt its namespaces, storage and policy selectors for other sites.

The Daedalus chart currently defaults to:

```yaml
exploration:
  enabled: true
  namespace: daedalus-exploration
  baseUrl: http://exploration-api.daedalus-exploration.svc.cluster.local:8080
  grantSecret: exploration-grants
```

The referenced Secret must exist in the backend namespace with a `key` entry.
The chart injects it as `EXPLORATION_GRANT_KEY` and injects the endpoint as
`EXPLORATION_BASE_URL`. With backend network policy enabled, it allows backend
egress to the exploration API on TCP 8080. The sandbox chart supplies the
corresponding ingress rule. Keep these selectors aligned with your namespaces
and pod labels.

If this service is not installed, set `exploration.enabled: false` and remove
`sandbox_exploration_tool` from the selected workflow's functions/tool list. A
missing required Secret otherwise prevents backend startup. Disabling the Helm
setting alone does not remove a tool registration from workflow YAML.

The shipped full integration workflow registers:

```yaml
functions:
  sandbox_exploration_tool:
    _type: sandbox_exploration
```

It also includes `sandbox_exploration_tool` in `workflow.tools`. Local text
chat configuration does not enable it. For a non-Helm backend, supply both
`EXPLORATION_*` values through its trusted environment. Use the same high-entropy
signer as the exploration API, at least 64 characters; never put it in model
arguments or committed YAML. The environment reference is [.env.template](../.env.template).

Publication reuses `DAEDALUS_ARTIFACT_PUBLISH_URL`, the internal frontend token
and document object storage. Ensure that existing publication path works as well
as the exploration service. The workload receives none of these credentials.

## Tool workflow and recovery

1. Discover `capabilities`, create a session, and keep its ID and generation.
2. Write code/data, then submit an `argv` array with the latest generation and
   a fresh idempotency key. Submission returns a run ID immediately.
3. Poll `status` or cursor-based `events`. Events record state transitions;
   stdout/stderr are bounded final output, not a live log stream.
4. Inspect the outcome and file hashes. Checkpoint a READY session and fork it
   to test another hypothesis; compare terminal runs before recording a lesson.
5. Publish a sealed completed run file using `publish_file` with `runId` and
   `path`. Return the publisher's exact download URL.

Service mutations require an idempotency key. Retry uncertain requests with the
same key and arguments. Session mutations require the current generation from
`get` or the last mutation. `list` returns the newest 100 scoped summaries to help
recover IDs. `publish_file` is an agent operation outside the service mutation
ledger: the adapter reads `artifact`, validates size/hash/run/path, then publishes.

The enabled profile is `compute-offline-v1`: Python 3.12, NumPy, pandas, SciPy,
Matplotlib and pytest. Network access, networked installs, GPU and VM profiles
are unavailable. Each run starts fresh from files; checkpoints preserve no RAM,
background services or open connections. Files normalize to mode 0644.

A family has 12 admitted runs, eight sessions/branches and a 30-minute elapsed
budget starting at creation. Idle time, pauses, queueing and provisioning count;
forks do not renew the budget. At most two runs in a family are active. A run
requests 300 seconds by default, up to 1,800 seconds within the family deadline.
Files are limited to 6 MiB each, 32 MiB total and 256 files; output is 1 MiB.
Metadata retention is seven days, separate from execution admission.

Cancellation is asynchronous. A run remains nonterminal until the runtime and
workload pod are confirmed deleted. On controller restart, ambiguous started
runs become LOST without replay; durable queued runs can still start within
their deadline. Use `get` after completion to refresh generation. Lessons remain
PROPOSED scoped evidence and do not alter instructions or enter durable agent
memory automatically.

## Implementation and checks

Both adapters use [the shared schema](../builder/runtime/resources/exploration.json).
The [Rust adapter](../builder/runtime/src/exploration.rs) owns native calls;
the [Python adapter](../builder/daedalus_runtime/exploration.py) supports Python
preparation. Each derives identity from trusted user/conversation context and
signs a 120-second grant. The API verifies the audience, issuer, profile and
scope. No identity or policy selector is exposed in model arguments.

Normal [backend builds](../builder/Dockerfile) include both adapters.

Exercise the built backend with disposable local peers:

```bash
python3 builder/migration/exploration_http_check.py --image YOUR_BACKEND_IMAGE
python3 builder/migration/exploration_http_check.py --image YOUR_BACKEND_IMAGE --preparation python
```

These checks cover registration, grant scope, request validation and artifact
integrity. They do not qualify host isolation. With the two repositories checked
out side by side, see the sandbox's [API examples](../../daedalus-sandbox/docs/exploration-api.md),
[operations and backups](../../daedalus-sandbox/docs/exploration-operations.md),
[security boundaries](../../daedalus-sandbox/SECURITY.md) and
[live qualification record](../../daedalus-sandbox/docs/exploration-validation.md).

To disable new use, remove the tool from the workflow, cancel/drain outstanding
runs, then disable chart wiring or roll back the agent. Retain exploration
metadata, blobs and Secrets for recovery. An agent rollback does not cancel
already admitted exploration runs.
