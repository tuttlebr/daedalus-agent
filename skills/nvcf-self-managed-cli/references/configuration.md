# Configuration Reference

Detailed reference for configuring `nvcf-cli`.

## Config File

The CLI uses YAML configuration files. Copy the included template to get started:

```bash
cp .nvcf-cli.yaml.template .nvcf-cli.yaml
```

### Search Order

Config files are searched in this order (highest priority first):

1. **Explicit path** via `--config` flag
2. **Current directory**: `./.nvcf-cli.yaml`
3. **Home directory**: `~/.nvcf-cli.yaml`

### Configuration Priority

Values are resolved in this order (highest to lowest):

1. Command-line flags (e.g., `--debug`)
2. Environment variables (e.g., `NVCF_BASE_HTTP_URL`)
3. Config file in current directory
4. Config file in home directory
5. Built-in defaults

## Self-Hosted Configuration

For self-hosted deployments, the CLI must communicate with your Envoy Gateway. The gateway uses hostname-based routing for HTTP services, which requires host header overrides.

### Get Your Gateway Address

After deploying the control plane:

```bash
export GATEWAY_ADDR=$(kubectl get gateway nvcf-gateway -n envoy-gateway \
  -o jsonpath='{.status.addresses[0].value}')
echo "Gateway Address: $GATEWAY_ADDR"
```

### Complete Self-Hosted Config

Replace `<GATEWAY_ADDR>` with your gateway address (e.g., an AWS ELB hostname like `a1b2c3d4.us-west-2.elb.amazonaws.com`):

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

### Production Setup (DNS/HTTPS)

With proper DNS and TLS configured, host header overrides are not needed. DNS records resolve service hostnames directly to your gateway's load balancer:

```yaml
# .nvcf-cli.yaml (production with DNS/HTTPS)

base_http_url: "https://api.nvcf.example.com"
invoke_url: "https://invocation.nvcf.example.com"
base_grpc_url: "grpc.nvcf.example.com:443"
api_keys_service_url: "https://api-keys.nvcf.example.com"
```

### Why Host Headers?

The Envoy Gateway uses hostname-based routing to direct traffic to different backend services through a single load balancer. Without the correct `Host` header, the gateway cannot match the request to a route and returns 404.

gRPC does not need host headers because it uses a dedicated TCP listener on port 10081. The gateway routes all traffic on that port directly to the gRPC service without hostname matching.

### Verifying Your Configuration

```bash
nvcf-cli init

# If you see 404, verify:
# 1. api_keys_host matches your HTTPRoute hostname
# 2. The gateway load balancer is accessible
# 3. The API Keys service is running: kubectl get pods -n api-keys
```

## Environment Variables

Config keys map to environment variables. Environment variables override config file values.

| Config Key | Environment Variable | Default |
|-----------|---------------------|---------|
| `base_http_url` | `NVCF_BASE_HTTP_URL` | `https://api.nvcf.nvidia.com` |
| `invoke_url` | `NVCF_INVOKE` / `NVCF_BASE_INVOKE_URL` | Same as `base_http_url` |
| `base_grpc_url` | `NVCF_BASE_GRPC_URL` | `grpc.nvcf.nvidia.com:443` |
| `api_keys_service_url` | `API_KEYS_SERVICE_URL` | `https://api-keys.nvcf.nvidia.com` |
| `api_key` | `NVCF_API_KEY` | -- |
| `token` | `NVCF_TOKEN` | -- |
| `client_id` | `NVCF_CLIENT_ID` | `nvcf-default` |
| `api_keys_host` | `API_KEYS_HOST` | -- |
| `api_host` | `API_HOST` | -- |
| `invoke_host` | `INVOKE_HOST` | -- |
| `api_keys_service_id` | `API_KEYS_SERVICE_ID` | `nvidia-cloud-functions-ncp-service-id-aketm` |
| `api_keys_issuer_service` | `API_KEYS_ISSUER_SERVICE` | `nvcf-api` |
| `api_keys_owner_id` | `API_KEYS_OWNER_ID` | `svc@nvcf-api.local` |
| `debug` | `NVCF_DEBUG` | `false` |
| `default_timeout` | `NVCF_DEFAULT_TIMEOUT` | -- |

Note: API Keys and host header environment variables do not use the `NVCF_` prefix.

OAuth2 SSA (alternative authentication): `NVCF_SSA_CLIENT_ID`, `NVCF_SSA_CLIENT_SECRET`, `NVCF_SSA_TOKEN_ENDPOINT`.

## Multi-Environment Setup

Use separate config files for different environments:

```bash
nvcf-cli --config dev.yaml init
nvcf-cli --config dev.yaml function list

nvcf-cli --config prod.yaml init
nvcf-cli --config prod.yaml function list
```

Each configuration maintains separate state files (e.g., `~/.nvcf-cli.dev.state` for `dev.yaml`).

## Staging Environment

```yaml
base_http_url: "https://api.shqa.stg.nvcf.nvidia.com"
base_grpc_url: "grpc.shqa.stg.nvcf.nvidia.com:443"
api_keys_service_url: "https://api-keys.shqa.stg.nvcf.nvidia.com"
invoke_url: "https://invocation.shqa.stg.nvcf.nvidia.com"
```

## State File

The CLI stores tokens and function context in `~/.nvcf-cli-state.json`. This file is managed automatically -- do not edit it manually.

## Debug Mode

```bash
nvcf-cli --debug function list
NVCF_DEBUG=true nvcf-cli function list
```
