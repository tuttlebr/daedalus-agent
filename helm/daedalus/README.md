# Daedalus Helm chart

Use this reference to configure the Kubernetes resources, Secrets, storage,
and network policies for your installation. Start with the
[deployment procedure](../../docs/operations.md#deploy-to-kubernetes) for the
supported build, preflight, and rollout commands. For local text chat, use the
[README](../../README.md#local-setup).

## Prerequisites

- Helm 3 (CI pins v3.22.1; Helm 4 is untested) and a Kubernetes cluster with
  registry access and suitable storage.
- Application and repository-owned Redis images, built and published through
  `make deploy` or the signed release workflow.
- Separate backend, frontend, and stream-worker Secrets and any configured
  integration services; see [Secrets](#secrets).
- Values adapted for your hostnames, TLS, storage, and network policies. The
  repository's [custom-values.yaml](../../custom-values.yaml) is a home deployment
  example; [values.yaml](values.yaml) defines the chart defaults.

## What The Chart Deploys

Depending on values, the chart can deploy:

- nginx and ingress for external traffic entry
- the Next.js frontend and dedicated stream worker
- the backend deployment
- Redis Stack using the repository-owned, security-updated runtime image
- the autonomous-agent worker Deployment
- PVCs, PodDisruptionBudget, NetworkPolicy, and optional Cilium policies

The backend runs the Rust agent with a supervised Python tool service on
loopback. Helm supplies `DAEDALUS_CONFIG_FILE` and `DAEDALUS_PORT`; do not expose
the Python tool port. The stream worker runs separately from the frontend and
uses the same image.

## Secrets

### Workload credentials

Configure login hashes as described in [login configuration](../../docs/operations.md#login-configuration).

`make deploy` filters `.env` into three workload-specific Secrets. It doesn't
copy the full file into any pod:

```sh
<release>-backend-env
<release>-frontend-env
<release>-stream-worker-env
```

The frontend allowlist contains only authentication, upload bounds, public
browser configuration, backend routing, and frontend resilience settings. The
stream-worker allowlist contains only backend routing, queue and stream
tuning, and logging settings. Model API keys, MCP credentials, Milvus credentials,
Phoenix credentials, and NV-Ingest MinIO credentials are backend-only. The
Helm templates reject keys outside each workload allowlist when chart-managed
Secret data or frontend overrides are used. `deploy.sh` and the chart accept the
same keys, except that `make deploy` copies only non-credential Milvus and MinIO
settings: `scripts/sync_rag_secrets.py` mirrors their credentials into the
dedicated Secrets that `retrieval.*.auth.existingSecret` selects.

The autonomous worker receives its internal backend token and dedicated Redis credential
through explicit `secretKeyRef` entries and doesn't inherit the backend Secret.
Leave `autonomousAgent.env.fromSecret` empty unless a future worker feature has
a documented, narrowly scoped credential requirement.

Streamed document uploads use a fourth dedicated Secret selected by
`documentObjectStorage.auth.existingSecret`. This avoids copying general MinIO
or backend credentials into the frontend Secret. Give this credential access
only to the configured document bucket and prefix. The frontend server and
backend need that restricted credential to write and read document objects.
The stream worker receives object references only and doesn't receive the
object-store credential.

For the canonical `make deploy` path, the authoritative MinIO Secret is mirrored to
`<release>-document-objects`. When authoritative sync is enabled, legacy
`DOCUMENT_OBJECT_*` values in `.env` are ignored so stale local credentials
cannot replace the source-of-truth Secret. The deploy validates the required
keys before Helm, then runs a short-lived, prefix-scoped PUT/GET/DELETE probe
against the exact rendered endpoint and bucket. Invalid credentials, a
missing bucket, and insufficient object permissions therefore fail before
Helm changes the release. Use `--skip-document-storage-preflight` only when an
external change window makes the live probe intentionally unavailable.

Create the configured bucket before deployment and apply lifecycle expiration
to `documentObjectStorage.prefix` for the configured `expirySeconds`. The
dedicated credential needs `GetObject`, `PutObject`, and `DeleteObject` only for
that bucket prefix; bucket-administration permissions are not required.

When `documentObjectStorage.enabled=false`, the chart injects no document
credential and renders no object-store egress rule.

If you manage Secrets outside the chart, set
`backend.default.env.fromSecret`, `frontend.env.fromSecret`, and
`frontend.streamWorker.env.fromSecret`. If you prefer Helm-managed Secrets,
set each corresponding `createSecret` value and supply only allowed entries in
its `data` map. Don't use one Secret for multiple workloads.

With `exploration.enabled=true` (the default), the backend reads
`EXPLORATION_GRANT_KEY` from key `key` of the `exploration.grantSecret` Secret
(`exploration-grants`) in the release namespace. The separately provisioned
exploration service owns that Secret; neither the chart nor `make deploy`
creates it. The reference is optional, so workflows without
`sandbox_exploration_tool` start without it. A workflow that configures the
tool fails at startup until the Secret holds a key of at least 64 characters.

The chart also manages `<release>-daedalus-internal-api`, a shared
frontend-to-backend token used for direct in-cluster API calls. Leave
`global.internalApiToken` empty to auto-generate and preserve the token across
upgrades, or set it explicitly when coordinating multiple releases.

For Google Workspace MCP, the backend secret must include
`GOOGLE_MCP_CLIENT_ID`, `GOOGLE_MCP_CLIENT_SECRET`, and
`GOOGLE_MCP_REDIRECT_URI`. The redirect URI must be registered on the
Google OAuth client and should point at the public `/auth/redirect` path, for
example `https://assistant.example/auth/redirect`. nginx routes it to the
frontend, which completes it only for the signed-in user who started the flow. One OAuth client is
shared by Gmail, Calendar, and Docs. Add the scope union
listed in `.env.template` to the consent configuration. Before deployment,
enable both `docs.googleapis.com` and `docsmcp.googleapis.com` in that OAuth
client's Google Cloud project. Google exposes each MCP as a separate protected
resource, so each service can require one initial authorization; the resulting
per-user tokens are stored in separate Redis object-store buckets and remain
usable across chats, restarts, and replicas. The Docs flow requests offline,
incremental authorization so Google can issue a refresh token for durable
access.

### Exploration grant signer

`exploration.enabled` defaults to true. It injects `EXPLORATION_BASE_URL` from
`exploration.baseUrl` and `EXPLORATION_GRANT_KEY` from the `key` entry in
`exploration.grantSecret` (default `exploration-grants`). Provision that Secret
in the backend namespace using the sandbox bootstrap before starting the backend.
It is separate from the legacy `LLM_SANDBOX_API_KEY` and is not mounted into
untrusted exploration workloads.

With `backend.networkPolicy.enabled`, the chart allows backend egress to pods
labeled `app: exploration-api` in `exploration.namespace` on TCP 8080. The sandbox
chart must allow the matching ingress. The tool also needs its workflow
registration and the existing frontend artifact publication configuration.

If exploration is not installed, set `exploration.enabled: false` and remove
`sandbox_exploration_tool` from the workflow. Otherwise a missing Secret blocks
backend startup. See [sandbox exploration](../../docs/sandbox-exploration.md).

### Redis ACL, TLS, And Rotation

`global.nodePlacement.allowedArchitectures` adds required architecture affinity
to every workload. The supplied `custom-values.yaml` selects `amd64` because the
repository application release currently publishes `linux/amd64` images; this
keeps those images off incompatible ARM64 nodes. A workload-specific setting,
such as `redis.nodePlacement.allowedArchitectures`, overrides the global list.
Architecture and hostname restrictions share one selector term, so both must
match. Chart defaults leave architecture unrestricted. Existing node-bound Redis
volumes must also be accessible from an eligible node; changing affinity does
not migrate their data.

Redis authentication is enabled by default. The chart gives the frontend,
stream worker, backend, and autonomous worker distinct users and passwords.
Backend and worker ACLs are limited to their required key prefixes and channels;
in particular, the backend cannot read authentication sessions, login counters,
or configured-user hashes. Redis retains a random, undisclosed `default` user
only so persisted AOF transactions can replay. For production, prefer an
externally managed Secret through `redis.auth.existingSecret`. That Secret must
contain the primary, backend, stream-worker, and autonomous current/previous
password keys named in `redis.auth`. Avoid passing real passwords with `--set`
because command history and Helm release metadata aren't secret stores.

Redis liveness and readiness require an exact `PONG` response. A successful
`redis-cli` exit alone is insufficient because authentication error replies can
also return exit status zero.

To enable transport encryption, provide an existing Secret containing the
server certificate, private key, and CA certificate, then set
`redis.tls.enabled=true` and `redis.tls.existingSecret`. The server certificate
must cover the chart's Redis Service DNS names. The chart never generates or
stores production TLS material.

Use this three-rollout sequence to rotate all four externally managed ACL
credentials without a credential gap:

1. Put each new password in its corresponding `*_PREVIOUS_PASSWORD` key while
   keeping current passwords unchanged, then run `make deploy`.
2. Swap every current/previous pair, then force another rollout. Redis accepts
   both values while each workload restarts on its new credential.
3. Empty all former-password keys, force a final rollout, and verify every old
   credential is rejected.

Run each rotation stage with `make deploy`. Helm reads the stored version of the
external ACL and TLS Secrets during the upgrade and restarts Redis when either
has changed since the last rollout. The application workloads restart through
the fresh `forceRedeploy` value that `make deploy` supplies together with
`--wait --atomic`. Renderers without cluster access, such as `helm template`,
can't read those versions; with them, restart Redis after each stage.

Rotate a Redis issuing CA without a trust gap in three forced rollouts:

1. Keep the current server certificate and key, but replace `ca.crt` with a
   bundle containing both the current and next issuing CAs. Wait for Redis and
   every client to finish rolling out.
2. Replace `tls.crt` and `tls.key` with the certificate issued by the next CA
   while retaining the two-CA trust bundle. Verify TLS authentication and
   application health before continuing.
3. Remove the former CA from `ca.crt`, force one final rollout, and verify that
   the former CA and former ACL credential are rejected.

The `redis-upgrade` CI job uses a disposable Kind cluster to exercise this
sequence. It generates two ephemeral test CAs, starts the historical Redis
image with TLS and an external ACL Secret, upgrades the persisted PVC, verifies
the autonomous reliable queue and frontend Redis Stream pending state, rotates
the ACL password with overlap, rotates the TLS Secret and certificate with a CA
overlap, and performs a byte-compatible rollback. Those generated certificates
are test-only and aren't written to the repository. Production certificates
and keys must remain externally supplied.

## Install or upgrade

Follow [Deploy to Kubernetes](../../docs/operations.md#deploy-to-kubernetes),
including the preview and rollout verification. To select a release, namespace,
credential file, values file, or workflow, pass options through the Make target
from the repository root:

```sh
make deploy DEPLOY_ARGS='--release <release> --namespace <namespace> --env-file <env-file> --values <values-file> --backend-config <config-file>'
```

Replace the angle-bracket placeholders with your paths and names. Direct Helm
commands are useful for linting and rendering; the supported application
deployment path is `make deploy`, which includes preflights and Secret
synchronization.

The full workflow uses the Responses API. Config overlays using application
`base:` inheritance are also resolved by the MCP authorization policy loader.
See [runtime configuration](../../docs/operations.md#runtime-configuration)
for compatibility selectors and rollback boundaries.

RedisInsight is not shipped. Use an authenticated, time-bounded local client
through `kubectl port-forward` when interactive Redis inspection is required.

### Release Evidence

The immutable-image workflow won't publish application images until the exact
source commit has a completed successful `CI` workflow run. It scans backend,
frontend, and Redis images for HIGH and CRITICAL vulnerabilities, signs each
digest, publishes SLSA build provenance, records the exact commit-to-digest
mapping, and signs `release-metadata.json`.

For a prebuilt deployment, download all three metadata artifacts and provide
the JSON file through `make deploy`:

```sh
COSIGN_CERTIFICATE_IDENTITY_REGEXP='https://github\.com/<owner>/<repo>/\.github/workflows/release\.yml@refs/(heads/main|tags/v.*)' \
COSIGN_CERTIFICATE_OIDC_ISSUER='https://token.actions.githubusercontent.com' \
make deploy DEPLOY_IMAGE_ARGS= DEPLOY_ARGS='--skip-build --release-metadata ./release-metadata.json'
```

Keep `release-metadata.json.sig` and `release-metadata.json.pem` beside the JSON
file, or select them with `RELEASE_METADATA_SIGNATURE_FILE` and
`RELEASE_METADATA_CERTIFICATE_FILE`. The deploy gate verifies the signed
metadata, successful CI and scan states, exact checked-out commit, registry
digests, image signatures, and GitHub SLSA provenance before Helm can run.
Prebuilt releases can't use the unsigned development opt-out. A local build
also requires Trivy and must pass HIGH and CRITICAL image scans before signing
or deployment.

## Key Value Areas

| Values path               | Purpose                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `forceRedeploy`           | Rollout nonce for externally managed Secret changes; applies to the application workloads, never to Redis                                       |
| `images.*`                | Container repositories, tags, and pull policy                                                                                                   |
| `retrieval.*`             | Milvus/MinIO endpoints, Secret refs, policy ports, readiness                                                                                    |
| `frontend.*`              | Frontend, stream-worker, services, and scoped env settings                                                                                      |
| `backend.default.*`       | Backend deployment and config                                                                                                                   |
| `backend.persistence.*`   | PVCs used by backend pods                                                                                                                       |
| `backend.networkPolicy.*` | Kubernetes and optional Cilium restrictions                                                                                                     |
| `exploration.*`           | Exploration API endpoint/namespace, grant Secret and backend network access                                                                     |
| `contextServices.espnMcp` | ESPN MCP namespace and port for backend egress (defaults: `daedalus`, `8000`); limited to pods labeled `app.kubernetes.io/name=espn-mcp-server` |
| `nginx.*`                 | nginx deployment, direct backend routing, TLS, restricted mode                                                                                  |
| `redis.*`                 | Redis Stack deployment and persistence                                                                                                          |
| `autonomousAgent.*`       | Background research worker schedule and config                                                                                                  |
| `ingress.*`               | External hostnames, ingress class, annotations, and TLS                                                                                         |

## Traffic Model

The standard browser flow is:

1. Ingress forwards to the chart-managed nginx service.
2. nginx proxies `/` and `/api/*` to Next.js, and `/ws` to its WebSocket sidecar.
3. The frontend authenticates the user, selects a backend, and queues the job
   in Redis. The dedicated stream worker opens the backend request.
4. The Rust backend calls the model and configured tools; the worker persists
   output and publishes events for the browser.

See the [request-path diagram](../../docs/architecture.md#request-path) for
ownership and recovery boundaries.

### RAG Secret Contract

`retrieval.milvus.auth.existingSecret` and
`retrieval.minio.auth.existingSecret` must name Secrets in the Helm release
namespace; Kubernetes cannot mount a Secret across namespaces. Password mode
expects `MILVUS_USERNAME` and `MILVUS_PASSWORD`. Token mode is selected by
setting `retrieval.milvus.auth.tokenKey` and expects that key instead. MinIO
expects `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY`. Endpoint, bucket, namespace,
port, and key names are configurable under `retrieval.*`. Keep
`retrieval.milvus.database` at `default`: NV-Ingest writes uploads through
Milvus's default database, so the backend rejects another value at startup.

`retrieval.readiness.mode` controls the authenticated Milvus dependency check:
`degraded` keeps the backend ready while reporting RAG unavailable, `required`
returns HTTP 503, and `disabled` skips the probe. `requiredCollections` lists
the collection aliases that must be visible before RAG reports ready. The
default is `degraded`, so an ingestion or Milvus incident does not remove core
chat from service.

For the repository's production values, the shared runtime contract is
database `default`, object bucket `nv-ingest`, and the `milvus`, MinIO, and
NV-Ingest Services in the shared `daedalus` namespace. The rendered
NetworkPolicies include those namespace/port paths. Keep the same endpoint,
database, bucket, credential, and embedding/schema contract used by the
collection-population jobs when configuring the canonical deployment.

The repo-level `make deploy` path normalizes the default authoritative Secrets
from the `daedalus` namespace into release-local Secrets without placing
credential values in Helm release metadata. Installations using an external
Secret controller must provision those namespace-local Secrets before invoking
the same canonical deployment path.
After a deploy-managed copy, `retrieval.secretResourceVersions.*` contains only
the target Secrets' Kubernetes `metadata.resourceVersion` values. These values
are rendered as backend pod annotations (and as a frontend annotation for the
document-object Secret), ensuring environment-based credentials rotate without
putting credential values or hashes into the release.

Follow [rollout verification](../../docs/operations.md#verify-a-rollout) to check
application readiness and the configured dependencies, then test a chat through
the frontend. An HTTP 200 in `degraded` mode does not prove RAG is available.

nginx can also proxy backend paths directly:

- `/chat/`
- `/generate/`
- `/v1/`

Those routes use the path and `X-Backend-Type` header for backend selection.
They retain backend authentication requirements. Set
`nginx.config.restrictedMode=true` to disable these direct backend routes.

## Operational Notes

- The frontend is job-oriented by default and expects Redis to be available.
- The backends expose headless pod services in addition to normal services so the frontend can pin each live stream to an individual pod.
- Network policies allow frontend-to-backend and backend-to-Redis traffic, and optionally restrict backend egress to approved destinations.
- Redis accepts connections only from this release's frontend, stream worker,
  backend and autonomous worker pods (`networkpolicy-redis.yaml`, with a Cilium
  counterpart when `backend.networkPolicy.cilium.enabled` is set). Disabling
  Redis authentication is rejected at render time: an unauthenticated Redis
  would start in protected mode and refuse every pod.
- nginx appends to `X-Forwarded-For`, so the client address survives the
  Ingress hop. Set `AUTH_TRUSTED_PROXY_HOPS=2` in the frontend environment when
  the Ingress is enabled (Ingress + nginx) so per-IP login lockouts key on real
  clients, and list the controller's CIDRs in `nginx.config.trustedProxyCidrs`
  so nginx's own per-IP limits do too. Without them, those limits apply to the
  Ingress address shared by every browser.
- `make deploy` restarts the application workloads through `forceRedeploy`;
  Redis is excluded and rolls only when its image, init configuration, or auth
  or TLS configuration changes, including writes to its external Secrets.
- Document-object egress is isolated to the configured namespace, CIDRs, or
  FQDNs for the frontend. The stream worker has no object credential and can
  reach only DNS, Redis, and the backend. The backend also hosts arbitrary URL
  scraping and therefore retains broad public 80/443 egress when the standard
  NetworkPolicy fallback or Cilium webscrape policy is enabled. In that mode,
  external object-store rules are additive and don't provide strict backend
  endpoint isolation. Use an in-cluster object store, disable broad webscrape
  egress with Cilium, or move object reads to a separately credentialed fetcher
  before claiming end-to-end endpoint isolation.
- Use `backend.networkPolicy.extraIngressNamespaces` and
  `backend.networkPolicy.extraEgressNamespaces` to open specific namespaces
  and ports. When Cilium is enabled, the broad Kubernetes HTTPS egress fallback
  is not rendered, so external access is controlled by the Cilium FQDN and
  webscrape rules.
- `nginx.config.restrictedMode=true` disables direct backend access through nginx and forces traffic through the frontend.
- On the production `nfs-client` StorageClass backed by UNAS Pro, PVC-writing pods must run as UID `977` and GID `988`. That matches the server export's `all_squash,anonuid=977,anongid=988` policy and avoids relying on `no_root_squash`.
- Use `runAsUser: 977`, `runAsGroup: 988`, `fsGroup: 988`, and `fsGroupChangePolicy: OnRootMismatch` for Daedalus workloads that write to NFS PVCs. `fsGroup` alone is not enough when files are created with owner-only write modes.
- The autonomous worker streams from the already-loaded backend workflow through `autonomousAgent.backendApiPath`, normally `/v1/chat/completions`.
- The autonomous worker seeds first-run workspace context from built-in defaults in the `autonomous_agent` package.
- The run cadence defaults to `autonomousAgent.worker.intervalSeconds` and can be changed from the Autonomy dashboard.
- Scheduled runs rotate through active goals by their `cadence:<n>h` or `cadence:<n>d` tag (daily when omitted). Autonomous goals should use only non-interactive sources and must not depend on per-user OAuth.

## NFS Ownership Runbook

For the home `nfs-client` setup, audit the NFS export policy with `exportfs -v`.
Its expected policy is `all_squash,anonuid=977,anongid=988`.

These UID/GID values describe the home export policy above; match your own
server's policy before applying them. During a maintenance window, stop affected
workloads, back up the data, and set `DAEDALUS_PVC_DIR` to the specific Daedalus
PVC directory on the NFS server before normalizing its ownership:

```sh
DAEDALUS_PVC_DIR=/path/to/daedalus/pvc-data
chown -R 977:988 "$DAEDALUS_PVC_DIR"
chmod -R u+rwX,g+rwX,o-rwx "$DAEDALUS_PVC_DIR"
find "$DAEDALUS_PVC_DIR" -type d -exec chmod g+s {} +
exportfs -ra
```

## Recommended Reading

- [`values.yaml`](values.yaml) for the default chart values
- [`../../custom-values.yaml`](../../custom-values.yaml) for the maintainer's home deployment settings
- [Operations reference](../../docs/operations.md) for deployment and rollout verification

### Service and container ports

`frontend.port` and `backend.default.port` select the application listeners and
NetworkPolicy destination ports. Their respective `service.port` values select
the ports used by nginx and other callers of the ClusterIP Services. The chart
sets the frontend listener `PORT`, `BACKEND_PORT` for Service requests, and
`BACKEND_POD_PORT` for direct pod discovery and OAuth callbacks. These explicit
values take precedence over the workload envFrom Secrets. For an external backend,
set the ports in `frontend.env.overrides` and, when different,
`frontend.streamWorker.env.overrides`; omitting `BACKEND_POD_PORT` there preserves
the existing single-port override.
