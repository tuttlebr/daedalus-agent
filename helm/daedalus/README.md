# Daedalus Helm Chart

This chart deploys the full Kubernetes form of Daedalus rather than just a simple frontend and backend pair.

## What The Chart Deploys

Depending on values, the chart can deploy:

- nginx and ingress for external traffic entry
- the Next.js frontend
- the backend deployment
- Redis Stack using the repository-owned, security-updated runtime image
- the autonomous-agent worker Deployment
- PVCs, PodDisruptionBudget, NetworkPolicy, and optional Cilium policies

The top-level [`../../README.md`](../../README.md) contains the end-to-end deployment guide and request-flow diagrams. This file focuses on the chart itself.

## Prerequisites

- Helm 3.x
- A Kubernetes cluster with access to your image registry
- Backend, frontend, and repository-owned Redis container images pushed to a registry
- Separate allowlisted backend, frontend, and stream-worker Secrets

## Secrets

`deploy.sh` filters `.env` into three workload-specific Secrets. It doesn't
copy the full file into any pod:

```sh
<release>-backend-env
<release>-frontend-env
<release>-stream-worker-env
```

The frontend allowlist contains only authentication, upload bounds, public
browser configuration, backend routing, and frontend resilience settings. The
stream-worker allowlist contains only backend routing, queue tuning, and Web
Push configuration. Model API keys, MCP credentials, Milvus credentials,
Phoenix credentials, and NV-Ingest MinIO credentials are backend-only. The
Helm templates reject keys outside each workload allowlist when chart-managed
Secret data or frontend overrides are used.

The autonomous worker receives its internal backend token and Redis credential
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
When `documentObjectStorage.enabled=false`, the chart injects no document
credential and renders no object-store egress rule.

If you manage Secrets outside the chart, set
`backend.default.env.fromSecret`, `frontend.env.fromSecret`, and
`frontend.streamWorker.env.fromSecret`. If you prefer Helm-managed Secrets,
set each corresponding `createSecret` value and supply only allowed entries in
its `data` map. Don't use one Secret for multiple workloads.

The chart also manages `<release>-daedalus-internal-api`, a shared
frontend-to-backend token used for direct in-cluster API calls. Leave
`global.internalApiToken` empty to auto-generate and preserve the token across
upgrades, or set it explicitly when coordinating multiple releases.

For Google Workspace MCP, the backend secret must include
`GOOGLE_MCP_CLIENT_ID`, `GOOGLE_MCP_CLIENT_SECRET`, and
`GOOGLE_MCP_REDIRECT_URI`. The redirect URI must be registered on the
Google OAuth client and should point at the public nginx backend redirect
path, for example `https://daedalus.ddns.me/auth/redirect`.

### Redis ACL, TLS, And Rotation

Redis authentication is enabled by default. The chart disables the Redis
`default` user, creates the named `redis.auth.username` ACL user, and injects
the same credential into every in-chart client. For production, prefer an
externally managed Secret through `redis.auth.existingSecret`. Avoid passing
real passwords with `--set` because command history and Helm release metadata
aren't secret stores.

To enable transport encryption, provide an existing Secret containing the
server certificate, private key, and CA certificate, then set
`redis.tls.enabled=true` and `redis.tls.existingSecret`. The server certificate
must cover the chart's Redis Service DNS names. The chart never generates or
stores production TLS material.

Use this three-rollout sequence to rotate an externally managed ACL credential
without a credential gap:

1. Put the new password in the Secret's overlap key
   (`REDIS_PREVIOUS_PASSWORD`) while keeping the current password unchanged,
   then run Helm with a new `forceRedeploy` value.
2. Swap the Secret so `REDIS_PASSWORD` is new and the overlap key contains the
   old password, then force another rollout. Redis accepts both while clients
   restart on the new credential.
3. Remove the old overlap credential, force a final rollout, and verify the old
   credential is rejected.

For manual upgrades, add `--set forceRedeploy="$(date +%s)" --wait --atomic`.
`deploy.sh` already sets this value. The same forced rollout is required after
updating an externally managed Redis TLS Secret because Helm can't hash Secret
content it doesn't own.

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

## Install Or Upgrade

```sh
helm upgrade --install <release> ./daedalus \
  -n <namespace> \
  -f values.yaml
```

Provide the backend workflow config explicitly:

```sh
helm upgrade --install <release> ./daedalus \
  -n <namespace> \
  -f values.yaml \
  --set-file backend.default.config.data=backend/tool-calling-config.yaml
```

The repo-level [`../../custom-values.yaml`](../../custom-values.yaml) is the opinionated example for production-style deployments. RedisInsight isn't shipped. Use an authenticated, time-bounded local client through `kubectl port-forward` when interactive Redis inspection is required.

### Release Evidence

The immutable-image workflow won't publish application images until the exact
source commit has a completed successful `CI` workflow run. It scans backend,
frontend, and Redis images for HIGH and CRITICAL vulnerabilities, signs each
digest, publishes SLSA build provenance, records the exact commit-to-digest
mapping, and signs `release-metadata.json`.

For a prebuilt deployment, download all three metadata artifacts and provide
the JSON file to `deploy.sh`:

```sh
COSIGN_CERTIFICATE_IDENTITY_REGEXP='https://github\.com/<owner>/<repo>/\.github/workflows/release\.yml@refs/(heads/main|tags/v.*)' \
COSIGN_CERTIFICATE_OIDC_ISSUER='https://token.actions.githubusercontent.com' \
./deploy.sh --skip-build --release-metadata ./release-metadata.json
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

| Values path               | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `forceRedeploy`           | Rollout nonce for externally managed Secret changes            |
| `images.*`                | Container repositories, tags, and pull policy                  |
| `frontend.*`              | Frontend, stream-worker, services, and scoped env settings     |
| `backend.default.*`       | Backend deployment and config                                  |
| `backend.persistence.*`   | PVCs used by backend pods                                      |
| `backend.networkPolicy.*` | Kubernetes and optional Cilium restrictions                    |
| `nginx.*`                 | nginx deployment, direct backend routing, TLS, restricted mode |
| `redis.*`                 | Redis Stack deployment and persistence                         |
| `autonomousAgent.*`       | Background research worker schedule and config                 |
| `ingress.*`               | External hostnames, ingress class, annotations, and TLS        |

## Traffic Model

The standard browser flow is:

1. Client request enters the cluster through `Ingress`
2. `Ingress` forwards to the chart-managed `nginx` service
3. nginx proxies `/` and `/api/*` to the `frontend` service
4. Frontend routes work to the `backend-default` service
5. Backend pods use Redis plus optional integrations such as Milvus, NV-Ingest, Phoenix, and external model APIs

nginx can also proxy backend paths directly:

- `/chat/`
- `/generate/`
- `/v1/`

Those routes are selected by path and `X-Backend-Type` header, which allows callers to bypass the frontend pod for direct backend API access when desired.

## Operational Notes

- The frontend is job-oriented by default and expects Redis to be available.
- The backends expose headless pod services in addition to normal services so the frontend can pin each live stream to an individual pod.
- Network policies allow frontend-to-backend and backend-to-Redis traffic, and optionally restrict backend egress to approved destinations.
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

## NFS Ownership Runbook

Before deploying workloads that write to existing `nfs-client` PVCs, run the repo-level `nfs-fix.sh` on the NFS server to audit the export policy. It is intentionally read-only and should report `all_squash,anonuid=977,anongid=988`.

During a maintenance window, stop affected NFS-backed workloads and normalize existing PVC directories on the NFS server:

```sh
root=/var/nfs/shared/kubernetes
chown -R 977:988 "$root"
chmod -R u+rwX,g+rwX,o-rwx "$root"
find "$root" -type d -exec chmod g+s {} +
exportfs -ra
```

## Recommended Reading

- [`values.yaml`](values.yaml) for the default chart values
- [`../../custom-values.yaml`](../../custom-values.yaml) for a fuller production example
- [`../../README.md`](../../README.md) for deployment instructions and Kubernetes flow diagrams
