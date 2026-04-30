# NVCF Self-Managed CLI Examples

Worked end-to-end examples for the highest-frequency self-managed workflows. Each example assumes `.nvcf-cli.yaml` is configured for the target environment and the user has confirmed the path. All commands pass `--config` explicitly because the CLI silently falls back to cloud defaults when running from the wrong working directory.

## Workflow 1: Create, deploy, invoke, and clean up a function

End-to-end happy path. Capture IDs from each output and pass them explicitly to subsequent commands — state persistence is unreliable.

### Step 1: Authenticate

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml init
nvcf-cli --config /path/to/.nvcf-cli.yaml api-key generate
```

`init` clears all saved state including the API key, so `api-key generate` must follow every `init`. If you only need to renew the admin token, use `refresh` instead.

### Step 2: Create the function

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml function create \
  --input-file function.json
```

Sample `function.json`:

```json
{
  "name": "echo-service",
  "inferenceUrl": "/v1/echo",
  "containerImage": "registry.example/echo:v1.0",
  "description": "Simple echo service for testing",
  "healthUri": "/health",
  "containerPort": 8000
}
```

Output (capture both IDs):

```
Function created
  ID: 7d4e9c20-1b2a-4c8e-aa11-2233445566ff
  Version: 04f7c3a8-9be2-4f55-9c33-aabbccddeeff
  Status: INACTIVE
```

### Step 3: Deploy

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml function deploy create \
  --function-id 7d4e9c20-1b2a-4c8e-aa11-2233445566ff \
  --version-id 04f7c3a8-9be2-4f55-9c33-aabbccddeeff \
  --input-file deploy.json
```

Sample `deploy.json`:

```json
{
  "deploymentSpecifications": [
    {
      "gpu": "L40",
      "instanceType": "gl40_1.br20_2xlarge",
      "minInstances": 1,
      "maxInstances": 2,
      "maxRequestConcurrency": 5
    }
  ]
}
```

Wait for status `ACTIVE` before invoking:

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml function deploy info \
  --function-id 7d4e9c20-1b2a-4c8e-aa11-2233445566ff \
  --version-id 04f7c3a8-9be2-4f55-9c33-aabbccddeeff
```

### Step 4: Invoke

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml function invoke \
  --function-id 7d4e9c20-1b2a-4c8e-aa11-2233445566ff \
  --version-id 04f7c3a8-9be2-4f55-9c33-aabbccddeeff \
  --request-body '{"message": "hello world"}'
```

If the response indicates the request was queued (status `pending`), poll with `function invoke-status` using the request ID from the initial response.

### Step 5: Clean up

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml function deploy remove \
  --function-id 7d4e9c20-1b2a-4c8e-aa11-2233445566ff \
  --version-id 04f7c3a8-9be2-4f55-9c33-aabbccddeeff

nvcf-cli --config /path/to/.nvcf-cli.yaml function delete \
  --function-id 7d4e9c20-1b2a-4c8e-aa11-2233445566ff \
  --version-id 04f7c3a8-9be2-4f55-9c33-aabbccddeeff
```

Always `deploy remove` before `function delete` — deleting a function with active deployments returns an error.

## Workflow 2: Generate and manage API keys

API keys (separate from the admin token) are required for `function invoke` operations. The default lifetime is 24 hours.

### Generate a 7-day key with a specific name

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml api-key generate \
  --name "ci-runner-7d" \
  --expiration-hours 168
```

Output:

```
API Key generated
  Name: ci-runner-7d
  Key: nvcf_apikey_AbCdEf123...
  Expires: 2026-05-07T18:30:00Z
```

The key is shown **once** in the create output. Capture it immediately — there is no way to retrieve a key value after creation. If lost, generate a new one.

### List existing keys

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml api-key list
```

### Revoke a key

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml api-key revoke --name ci-runner-7d
```

If `function invoke` returns 403 Forbidden, the API key has likely expired or been revoked. Run `api-key generate --validate` to confirm and regenerate.

## Workflow 3: Add registry credentials for private container images

Functions pulling from private registries need credentials registered with NVCF before deploy.

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml registry add \
  --name my-private-registry \
  --url https://registry.example.com \
  --username "$REGISTRY_USERNAME" \
  --password "$REGISTRY_PASSWORD"
```

Reference the credential by name in your function definition:

```json
{
  "name": "private-model",
  "containerImage": "registry.example.com/team/model:v2",
  "registryCredentials": "my-private-registry"
}
```

List or rotate credentials:

```bash
nvcf-cli --config /path/to/.nvcf-cli.yaml registry list
nvcf-cli --config /path/to/.nvcf-cli.yaml registry update --name my-private-registry --password "$NEW_PASSWORD"
```

Never paste secrets directly on the command line — use environment variables so credentials don't end up in shell history.

## Workflow 4: Switch environments with --config

For multi-environment workflows (dev / staging / prod), keep separate config files and pass each explicitly. The CLI will silently use the wrong one if it falls back to the home directory.

```bash
# Dev
nvcf-cli --config ~/nvcf/dev.yaml function list

# Staging
nvcf-cli --config ~/nvcf/staging.yaml function list

# Prod (read-only ops only — no create/delete from the CLI for prod)
nvcf-cli --config ~/nvcf/prod.yaml function list
```

If a command unexpectedly hits a different environment than intended, the most likely cause is a missing `--config` flag combined with a `~/.nvcf-cli.yaml` left in the home directory.

## Workflow 5: Direct curl invocation (when explicitly authorized)

The CLI is the supported path for all management operations, but direct HTTP invocation is acceptable when the user explicitly requests it and `NVCF_API_KEY` is set. Useful for embedding in scripts or testing latency without CLI overhead.

```bash
curl -X POST \
  -H "Authorization: Bearer $NVCF_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Host: invocation.<GATEWAY_ADDR>" \
  --data '{"message": "hello world"}' \
  http://<GATEWAY_ADDR>/v2/nvcf/pexec/functions/7d4e9c20-1b2a-4c8e-aa11-2233445566ff/versions/04f7c3a8-9be2-4f55-9c33-aabbccddeeff
```

The `Host` header override is required for self-hosted Envoy Gateway routing. For production deployments with DNS, the header is not needed.
