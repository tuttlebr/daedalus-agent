# Contributing

Thanks for helping improve Daedalus. Keep changes focused, test the affected surface, and avoid committing local secrets or generated runtime state.

## Local Setup

Copy the environment template and fill in local values:

```bash
cp .env.template .env
```

For production-like frontend behavior, set `SESSION_SECRET` to a unique value:

```bash
openssl rand -base64 32
```

## Validation

The repo ships a `Makefile` that mirrors `.github/workflows/ci.yml`. Run the
full gate before pushing:

```bash
make ci
```

Or run just the area you changed:

| Area | Command |
| --- | --- |
| Builder (Python) | `make builder` |
| Frontend (Next.js) | `make frontend` |
| Helm chart | `make helm` |
| Docker Compose | `make docker` |
| Security scans | `make security` |
| Eval harness | `make evals` |

Run `make` (no args) for the full target list, or `make tools-check` to verify
required binaries (`uv`, `helm`, `docker`, `gitleaks`, `trivy`, `node`, `npm`,
`python3.11`, `python3.12`) are installed.

If you'd rather invoke the commands directly:

```bash
# Builder
cd builder && python3 -m pytest

# Frontend
cd frontend
npm ci --legacy-peer-deps
npm run lint
npx tsc --noEmit --incremental false
npm test -- --run
npm run build

# Helm chart
helm lint helm/daedalus
```

## Pull Requests

- Explain the behavior change and why it is needed.
- Include tests for bug fixes and user-visible behavior changes.
- Update docs or examples when configuration, deployment, or public APIs change.
- Keep unrelated formatting and refactors out of functional changes.
