# Security Policy

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability. Report it privately to the repository maintainers with:

- affected version or commit
- reproduction steps
- impact assessment
- any relevant logs or screenshots with secrets removed

If this repository is mirrored under an organization that has GitHub private vulnerability reporting enabled, use that channel.

## Deployment Requirements

- Set a unique `SESSION_SECRET` for every production deployment.
- Keep `DAEDALUS_ALLOW_DEV_AUTH_FALLBACK=false` outside local development.
- Store API keys and passwords in Kubernetes Secrets, Docker secrets, or another secret manager.
- Rotate `SESSION_SECRET` and auth credentials after suspected exposure.
- Do not expose backend routes directly unless the deployment intentionally bypasses frontend authentication.
