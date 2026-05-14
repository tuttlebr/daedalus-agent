# Daedalus Helm Chart

This chart deploys the full Kubernetes form of Daedalus rather than just a simple frontend and backend pair.

## What The Chart Deploys

Depending on values, the chart can deploy:

- nginx and ingress for external traffic entry
- the Next.js frontend
- the backend deployment
- Redis Stack and RedisInsight
- the autonomous-agent CronJob with a seed knowledge graph (identity, interests, schema, memory, and operating procedures mounted via ConfigMap)
- PVCs, PodDisruptionBudget, NetworkPolicy, and optional Cilium policies

The top-level [`../../README.md`](../../README.md) contains the end-to-end deployment guide and request-flow diagrams. This file focuses on the chart itself.

## Prerequisites

- Helm 3.x
- A Kubernetes cluster with access to your image registry
- Backend and frontend container images pushed to a registry
- Backend and frontend secrets prepared from `.env`

## Secrets

Create or update the two expected secrets before installing:

```sh
kubectl -n <namespace> create secret generic <release>-daedalus-backend-env \
  --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n <namespace> create secret generic <release>-daedalus-frontend-env \
  --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

If you prefer Helm-managed secrets, see the `backend.*.env.createSecret` and `frontend.env.createSecret` values.

For Google Workspace MCP, the backend secret must include
`GOOGLE_MCP_CLIENT_ID`, `GOOGLE_MCP_CLIENT_SECRET`, and
`GOOGLE_MCP_REDIRECT_URI`. The redirect URI must be registered on the
Google OAuth client and should point at the public nginx backend redirect
path, for example `https://daedalus.ddns.me/auth/redirect`.

## Install Or Upgrade

```sh
helm upgrade --install <release> ./daedalus \
  -n <namespace> \
  -f values.yaml
```

Override backend configs explicitly when needed:

```sh
helm upgrade --install <release> ./daedalus \
  -n <namespace> \
  -f values.yaml \
  --set-file backend.default.config.data=backend/tool-calling-config.yaml
```

The repo-level [`../../custom-values.yaml`](../../custom-values.yaml) is the opinionated example for production-style deployments.

## Key Value Areas

| Values path | Purpose |
|-------------|---------|
| `images.*` | Container repositories, tags, and pull policy |
| `frontend.*` | Frontend deployment, service, and env overrides |
| `backend.default.*` | Backend deployment and config |
| `backend.persistence.*` | PVCs used by backend pods |
| `backend.networkPolicy.*` | Kubernetes and optional Cilium restrictions |
| `nginx.*` | nginx deployment, direct backend routing, TLS, restricted mode |
| `redis.*` | Redis Stack deployment and persistence |
| `redisinsight.*` | RedisInsight deployment and service |
| `autonomousAgent.*` | Background research agent schedule and config |
| `ingress.*` | External hostnames, ingress class, annotations, and TLS |

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
- The backends expose headless pod services in addition to normal services so the frontend can discover individual pods for async job submission.
- Network policies allow frontend-to-backend and backend-to-Redis traffic, and optionally restrict backend egress to approved destinations.
- `nginx.config.restrictedMode=true` disables direct backend access through nginx and forces traffic through the frontend.
- On the production `nfs-client` StorageClass backed by UNAS Pro, PVC-writing pods must run as UID `977` and GID `988`. That matches the server export's `all_squash,anonuid=977,anongid=988` policy and avoids relying on `no_root_squash`.
- Use `runAsUser: 977`, `runAsGroup: 988`, `fsGroup: 988`, and `fsGroupChangePolicy: OnRootMismatch` for Daedalus workloads that write to NFS PVCs. `fsGroup` alone is not enough when files are created with owner-only write modes.
- The autonomous agent can target either backend using `autonomousAgent.backendType`.
- The autonomous agent mounts seed knowledge graph files from `helm/daedalus/files/autonomous-agent-*.md` via a ConfigMap. Set `autonomousAgent.workspace.resetOnDeploy=true` to re-seed all files after identity or schema changes.
- The autonomous agent defaults to a 10-cycle distillation interval so exploration, follow-up, falsification, and memory maintenance stay aligned.

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
