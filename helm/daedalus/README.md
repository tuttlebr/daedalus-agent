# Daedalus Helm Chart

This chart deploys the full Kubernetes form of Daedalus rather than just a simple frontend and backend pair.

## What The Chart Deploys

Depending on values, the chart can deploy:

- nginx and ingress for external traffic entry
- the Next.js frontend
- separate default and deep-thinker backend deployments
- Redis Stack and RedisInsight
- JupyterLab
- the autonomous-agent CronJob
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
  --set-file backend.default.config.data=backend/tool-calling-config.yaml \
  --set-file backend.deepThinker.config.data=backend/react-agent-config.yaml
```

The repo-level [`../../custom-values.yaml`](../../custom-values.yaml) is the opinionated example for production-style deployments.

## Key Value Areas

| Values path | Purpose |
|-------------|---------|
| `images.*` | Container repositories, tags, and pull policy |
| `frontend.*` | Frontend deployment, service, and env overrides |
| `backend.default.*` | Default backend deployment and config |
| `backend.deepThinker.*` | Deep-thinker backend deployment and config |
| `backend.persistence.*` | PVCs used by backend pods |
| `backend.networkPolicy.*` | Kubernetes and optional Cilium restrictions |
| `nginx.*` | nginx deployment, direct backend routing, TLS, restricted mode |
| `redis.*` | Redis Stack deployment and persistence |
| `redisinsight.*` | RedisInsight deployment and service |
| `jupyterlab.*` | JupyterLab enablement and access |
| `autonomousAgent.*` | Background research agent schedule and backend selection |
| `ingress.*` | External hostnames, ingress class, annotations, and TLS |

## Traffic Model

The standard browser flow is:

1. Client request enters the cluster through `Ingress`
2. `Ingress` forwards to the chart-managed `nginx` service
3. nginx proxies `/` and `/api/*` to the `frontend` service
4. Frontend routes work to either the `backend-default` or `backend-deep-thinker` service
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
- The autonomous agent can target either backend using `autonomousAgent.backendType`.

## Recommended Reading

- [`values.yaml`](values.yaml) for the default chart values
- [`../../custom-values.yaml`](../../custom-values.yaml) for a fuller production example
- [`../../README.md`](../../README.md) for deployment instructions and Kubernetes flow diagrams
