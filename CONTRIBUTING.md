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

Run the checks that match the area you changed.

Builder packages:

```bash
cd builder
python3 -m pytest
```

Frontend:

```bash
cd frontend
npm ci --legacy-peer-deps
npm run lint
npx tsc --noEmit --incremental false
npm test -- --run
npm run build
```

Helm chart:

```bash
helm lint helm/daedalus
```

## Pull Requests

- Explain the behavior change and why it is needed.
- Include tests for bug fixes and user-visible behavior changes.
- Update docs or examples when configuration, deployment, or public APIs change.
- Keep unrelated formatting and refactors out of functional changes.
