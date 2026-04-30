---
name: nvcf-self-managed-cli
description: Manage NVIDIA Cloud Functions on self-managed deployments via the nvcf-cli. Create, deploy, invoke, and delete functions; manage API keys and registry credentials. Use when working with self-managed NVCF, self-hosted cloud functions, nvcf-cli, function deployment, invocation, API key generation, or registry credentials.
compatibility: Requires nvcf-cli binary installed and configured with .nvcf-cli.yaml
---

# NVCF Self-Managed CLI Skill

Manage NVIDIA Cloud Functions on self-managed deployments via `nvcf-cli`.

## Before You Start

### Always Use `--config`

The CLI resolves its config file from the current working directory or home directory. Agents typically run from the workspace root, **not** the directory containing `.nvcf-cli.yaml`, so the CLI will silently fall back to cloud-hosted defaults and fail. Always pass `--config` explicitly on every command:

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml status
```

At the start of a session, ask the user where their config file is (or search for it), then use that path for all subsequent commands.

### Check Status

Run `nvcf-cli status` **once** at the beginning of a session to confirm configuration and authentication state. Report the configuration details and token status to the user. After that, do not re-run it -- remember the result for the rest of the session.

### Do Not Modify CLI Configuration

**Never** change the CLI configuration file (`.nvcf-cli.yaml`) on behalf of the user. This includes editing endpoints, credentials, host headers, or any other settings. Only the user may change their configuration explicitly.

If the user needs to target a different environment, suggest using the `--config` flag:

```bash
nvcf-cli --config staging.yaml function list
```

### Verify Authentication

Before performing any operations, confirm that authentication tokens are available. Run `nvcf-cli status` and check for valid tokens. If tokens are missing or expired:

```bash
nvcf-cli init
nvcf-cli api-key generate
```

If `init` fails, **stop and help the user resolve the configuration** before proceeding. Do not attempt function operations -- they will fail with 401/403 errors.

### Do Not Bypass the CLI

All NVCF management operations must go through `nvcf-cli`. Do not call NVCF REST APIs directly (via curl, Python requests, etc.) to work around CLI errors. If a CLI command fails, stop and report the issue to the user.

**Exception:** Direct HTTP invocation via curl is acceptable when the user explicitly requests it and has `NVCF_API_KEY` set. See [Invocation Reference](references/invocation.md).

## Prerequisites

1. **Download nvcf-cli** from NGC (see self-hosted artifact manifest)
2. **Copy configuration template**: `cp .nvcf-cli.yaml.template .nvcf-cli.yaml`
3. **Configure for your environment**: See [Configuration Reference](references/configuration.md)
4. **Initialize authentication**: `nvcf-cli init && nvcf-cli api-key generate`

## Configuration

Config files are searched in this order (highest priority first):

1. Explicit path via `--config` flag
2. Current directory: `./.nvcf-cli.yaml`
3. Home directory: `~/.nvcf-cli.yaml`

For self-hosted deployments, the CLI must communicate with your Envoy Gateway. The gateway uses hostname-based routing, so **host header overrides** are required:

```yaml
# .nvcf-cli.yaml
base_http_url: "http://<GATEWAY_ADDR>"
invoke_url: "http://<GATEWAY_ADDR>"
base_grpc_url: "<GATEWAY_ADDR>:10081"
api_keys_service_url: "http://<GATEWAY_ADDR>"

api_keys_host: "api-keys.<GATEWAY_ADDR>"
api_host: "api.<GATEWAY_ADDR>"
invoke_host: "invocation.<GATEWAY_ADDR>"

api_keys_service_id: "nvidia-cloud-functions-ncp-service-id-aketm"
api_keys_issuer_service: "nvcf-api"
api_keys_owner_id: "svc@nvcf-api.local"

client_id: "nvcf-default"
```

For production with DNS/HTTPS, host header overrides are not needed. See [Configuration Reference](references/configuration.md) for full details including environment variables, multi-environment setup, and staging endpoints.

## Authentication

The CLI uses two token types:

| Token | Env Var | Purpose | Command |
|-------|---------|---------|---------|
| Admin Token (JWT) | `NVCF_TOKEN` | create, deploy, update, delete | `nvcf-cli init` |
| API Key | `NVCF_API_KEY` | invoke, list, queue status | `nvcf-cli api-key generate` |

```bash
nvcf-cli init                  # generate admin token (clears ALL state including API key)
nvcf-cli refresh               # refresh admin token (preserves state)
nvcf-cli api-key generate      # generate API key (default: 24h)
```

**Important:** `init` clears all saved state, including the API key. You **must** run `api-key generate` again after every `init`, otherwise invocations will fail with 403 Forbidden. Prefer `refresh` over `init` when you only need to renew the admin token.

See [API Keys Reference](references/api-keys.md) for scopes, expiration, and key management.

## Quick Start

```bash
nvcf-cli init
nvcf-cli api-key generate
nvcf-cli function create --input-file function.json
nvcf-cli function deploy create --input-file deploy.json
nvcf-cli function invoke --request-body '{"message": "hello world"}'
nvcf-cli function deploy remove
nvcf-cli function delete
```

After `function create`, the CLI attempts to save the function ID and version ID to `~/.nvcf-cli-state.json`. However, state persistence is unreliable -- it can fail silently due to permission issues, `--config` usage, or working directory differences. **Always capture the function ID and version ID from the `create` output and pass them explicitly with `--function-id` and `--version-id` on all subsequent commands.** Do not rely on automatic state resolution.

## Command Structure

```bash
nvcf-cli [--config <path>] [--debug] <command> [subcommand] [flags]
```

## Troubleshooting

```bash
nvcf-cli --debug function list
```

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | `nvcf-cli init --debug` |
| 403 Forbidden | `nvcf-cli api-key generate --validate` |
| Token expired | `nvcf-cli refresh` then `nvcf-cli api-key generate` |
| 404 on self-hosted | Verify host headers match HTTPRoute hostnames. See [Configuration Reference](references/configuration.md). |

## Worked Examples

For end-to-end workflows (create + deploy + invoke + cleanup, API key management, registry credentials, multi-environment switching), see [examples.md](examples.md).

## Reference Docs

- [Functions](references/functions.md) -- create, list, get, update, delete
- [Deployments](references/deployment.md) -- deploy, scale, remove
- [Invocation](references/invocation.md) -- REST, gRPC, curl, queue monitoring
- [API Keys](references/api-keys.md) -- generate, list, revoke, scopes
- [Registry](references/registry.md) -- add, list, update, delete credentials
- [Configuration](references/configuration.md) -- endpoints, env vars, multi-env, staging
