#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults
NAMESPACE="daedalus"
RELEASE="daedalus"
ENV_FILE="$SCRIPT_DIR/.env"
VALUES_FILE="$SCRIPT_DIR/custom-values.yaml"
BACKEND_CONFIG="$SCRIPT_DIR/backend/tool-calling-config.yaml"
DEEP_THINKER_CONFIG="$SCRIPT_DIR/backend/react-agent-config.yaml"
SKIP_BUILD=false
SKIP_TLS=false
DRY_RUN=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Build, push, and deploy Daedalus to Kubernetes.

Every step is idempotent -- safe to run repeatedly.

Options:
  -n, --namespace NAME       Kubernetes namespace (default: $NAMESPACE)
  -r, --release NAME         Helm release name (default: $RELEASE)
  -e, --env-file PATH        .env file for secrets (default: .env)
  -f, --values PATH          Helm values file (default: custom-values.yaml)
      --skip-build           Skip docker compose build/push
      --skip-tls             Skip TLS secret creation
      --dry-run              Print what would happen without applying
  -h, --help                 Show this help and exit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--namespace)     NAMESPACE="$2"; shift 2 ;;
    -r|--release)       RELEASE="$2"; shift 2 ;;
    -e|--env-file)      ENV_FILE="$2"; shift 2 ;;
    -f|--values)        VALUES_FILE="$2"; shift 2 ;;
    --skip-build)       SKIP_BUILD=true; shift ;;
    --skip-tls)         SKIP_TLS=true; shift ;;
    --dry-run)          DRY_RUN=true; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

log() { echo "==> $*"; }

# -------------------------------------------------------------------
# Build and push images
# -------------------------------------------------------------------
if [[ "$SKIP_BUILD" == false ]]; then
  log "Building and pushing images"
  run docker compose -f "$SCRIPT_DIR/docker-compose.yaml" build
  run docker compose -f "$SCRIPT_DIR/docker-compose.yaml" push
fi

# -------------------------------------------------------------------
# Create namespace (idempotent)
# -------------------------------------------------------------------
log "Ensuring namespace $NAMESPACE exists"
if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -"
else
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
fi

# -------------------------------------------------------------------
# Create secrets from .env (idempotent)
# -------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  log "Applying secrets from $ENV_FILE"
  for secret_name in "$RELEASE-backend-env" "$RELEASE-frontend-env"; do
    if [[ "$DRY_RUN" == true ]]; then
      echo "[dry-run] kubectl -n $NAMESPACE create secret generic $secret_name --from-env-file=$ENV_FILE --dry-run=client -o yaml | kubectl apply -f -"
    else
      kubectl -n "$NAMESPACE" create secret generic "$secret_name" \
        --from-env-file="$ENV_FILE" --dry-run=client -o yaml | kubectl apply -f -
    fi
  done
else
  echo "WARNING: $ENV_FILE not found -- skipping secret creation" >&2
fi

# -------------------------------------------------------------------
# Create TLS secret (idempotent)
# -------------------------------------------------------------------
if [[ "$SKIP_TLS" == false ]]; then
  TLS_DIR="$SCRIPT_DIR/nginx/ssl"
  TLS_KEY="$TLS_DIR/tls.key"

  # Accept .crt or .pem
  if [[ -f "$TLS_DIR/tls.crt" ]]; then
    TLS_CERT="$TLS_DIR/tls.crt"
  elif [[ -f "$TLS_DIR/tls.pem" ]]; then
    TLS_CERT="$TLS_DIR/tls.pem"
  else
    TLS_CERT=""
  fi

  if [[ -n "$TLS_CERT" && -f "$TLS_KEY" ]]; then
    log "Applying TLS secret from $TLS_CERT"
    if [[ "$DRY_RUN" == true ]]; then
      echo "[dry-run] kubectl -n $NAMESPACE create secret tls $RELEASE-tls --cert=$TLS_CERT --key=$TLS_KEY --dry-run=client -o yaml | kubectl apply -f -"
    else
      kubectl -n "$NAMESPACE" create secret tls "$RELEASE-tls" \
        --cert="$TLS_CERT" --key="$TLS_KEY" --dry-run=client -o yaml | kubectl apply -f -
    fi
  else
    echo "WARNING: TLS cert/key not found in $TLS_DIR -- skipping TLS secret" >&2
  fi
fi

# -------------------------------------------------------------------
# Deploy with Helm (upgrade --install is idempotent)
# -------------------------------------------------------------------
log "Deploying Daedalus via Helm"
HELM_CMD=(helm upgrade --install "$RELEASE" "$SCRIPT_DIR/helm/daedalus"
  -n "$NAMESPACE"
  --timeout 10m
)

if [[ -f "$VALUES_FILE" ]]; then
  HELM_CMD+=( -f "$VALUES_FILE" )
fi

if [[ -f "$BACKEND_CONFIG" ]]; then
  HELM_CMD+=( --set-file backend.default.config.data="$BACKEND_CONFIG" )
fi

if [[ -f "$DEEP_THINKER_CONFIG" ]]; then
  HELM_CMD+=( --set-file backend.deepThinker.config.data="$DEEP_THINKER_CONFIG" )
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run]" "${HELM_CMD[@]}"
else
  "${HELM_CMD[@]}"
fi

log "Done"
