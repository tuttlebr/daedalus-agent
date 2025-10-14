#!/bin/bash
set -euo pipefail
# Colors for output
Black="\033[0;30m"        # Black
Red="\033[0;31m"          # Red
Yellow="\033[0;33m"       # Yellow
Green="\033[0;32m"        # Green
Cyan="\033[0;36m"         # Cyan
Blue="\033[0;34m"         # Blue
Purple="\033[0;35m"       # Purple
White="\033[0;37m"        # White
Color_Off='\033[0m'       # No Color

# Absolute paths
REPO_ROOT="/volume1/brandon/datasets/daedalus"
CHART_DIR="$REPO_ROOT/helm/daedalus"

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${Red}Required command not found in PATH: $cmd${Color_Off}"
    exit 1
  fi
}

wait_for_namespace_deletion() {
  local namespace="$1"
  local timeout="${2:-240}"
  local interval=5
  local start
  start=$(date +%s)

  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    echo "[dry-run] Would wait for namespace $namespace to fully terminate"
    return 0
  fi

  while kubectl get ns "$namespace" >/dev/null 2>&1; do
    local phase
    phase=$(kubectl get ns "$namespace" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [[ "$phase" == "Terminating" ]]; then
      local terminating_pvcs
      terminating_pvcs=$(kubectl get pvc -n "$namespace" -o jsonpath='{range .items[?(@.metadata.deletionTimestamp)]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
      if [[ -n "$terminating_pvcs" ]]; then
        echo -e "${Yellow}Namespace $namespace is terminating; attempting to remove PVC finalizers for a clean delete${Color_Off}"
        while read -r pvc_name; do
          [[ -z "$pvc_name" ]] && continue
          echo -e "  ${Yellow}- Patching PVC:${Color_Off} $pvc_name"
          kubectl patch pvc "$pvc_name" -n "$namespace" --type merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
        done <<< "$terminating_pvcs"
      fi
    fi

    if (( $(date +%s) - start >= timeout )); then
      echo -e "${Red}Timed out waiting for namespace $namespace to terminate.${Color_Off}"
      return 1
    fi
    sleep "$interval"
  done

  return 0
}

ensure_namespace() {
  local namespace="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "kubectl get ns $namespace >/dev/null 2>&1 || kubectl create ns $namespace"
  else
    if ! kubectl get ns "$namespace" >/dev/null 2>&1; then
      kubectl create ns "$namespace"
    fi
  fi
}

validate_env_file() {
  if [[ -n "${ENV_FILE:-}" && -f "${ENV_FILE}" ]]; then
    ENV_FILE_PRESENT="true"
  else
    ENV_FILE_PRESENT="false"
    if [[ "${DRY_RUN:-false}" == "true" ]]; then
      echo -e "${Yellow}Env file not found; dry-run will assume Secrets already exist${Color_Off}"
    else
      echo -e "${Red}Env file not found or not provided; cannot create required Secrets${Color_Off}"
      echo -e "${Yellow}If Secrets already exist, rerun with --skip-secret-creation (not yet implemented).${Color_Off}"
      exit 1
    fi
  fi
}

apply_env_secrets() {
  if [[ "${ENV_FILE_PRESENT}" != "true" ]]; then
    return
  fi

  echo -e "${Green}Applying Secrets from ${ENV_FILE}${Color_Off}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "kubectl -n $NAMESPACE create secret generic $RELEASE-backend-env --from-env-file=$ENV_FILE --dry-run=client -o yaml | kubectl apply -f -"
    echo "kubectl -n $NAMESPACE create secret generic $RELEASE-frontend-env --from-env-file=$ENV_FILE --dry-run=client -o yaml | kubectl apply -f -"
  else
    kubectl -n "$NAMESPACE" create secret generic "$RELEASE-backend-env" --from-env-file="$ENV_FILE" --dry-run=client -o yaml | kubectl apply -f -
    kubectl -n "$NAMESPACE" create secret generic "$RELEASE-frontend-env" --from-env-file="$ENV_FILE" --dry-run=client -o yaml | kubectl apply -f -
  fi
}

validate_tls_materials() {
  TLS_SECRET_NAME_EFFECTIVE="${TLS_SECRET_NAME:-$RELEASE-tls}"
  local cert_dir
  cert_dir="$REPO_ROOT/nginx/ssl"
  local crt_file
  crt_file="$cert_dir/daedalus_ddns_me.crt"
  local pem_file
  pem_file="$cert_dir/daedalus_ddns_me.pem"
  local key_file
  key_file="$cert_dir/daedalus_ddns_me.key"

  if [[ ! -f "$key_file" ]]; then
    echo -e "${Red}TLS key not found:${Color_Off} $key_file"
    exit 1
  fi

  if [[ -f "$crt_file" ]]; then
    TLS_CERT_PATH="$crt_file"
  elif [[ -f "$pem_file" ]]; then
    TLS_CERT_PATH="$pem_file"
  else
    echo -e "${Red}TLS cert not found:${Color_Off} expected $crt_file or $pem_file"
    exit 1
  fi

  TLS_KEY_FILE="$key_file"
}

apply_tls_secret() {
  if [[ "${ENABLE_TLS}" != "true" ]]; then
    return
  fi

  if [[ -z "${TLS_SECRET_NAME_EFFECTIVE}" || -z "${TLS_CERT_PATH}" || -z "${TLS_KEY_FILE}" ]]; then
    validate_tls_materials
  fi

  echo -e "${Green}Applying TLS Secret ${TLS_SECRET_NAME_EFFECTIVE} from ${TLS_CERT_PATH} and ${TLS_KEY_FILE}${Color_Off}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "kubectl -n $NAMESPACE create secret tls ${TLS_SECRET_NAME_EFFECTIVE} --cert=${TLS_CERT_PATH} --key=${TLS_KEY_FILE} --dry-run=client -o yaml | kubectl apply -f -"
  else
    kubectl -n "$NAMESPACE" create secret tls "${TLS_SECRET_NAME_EFFECTIVE}" --cert="${TLS_CERT_PATH}" --key="${TLS_KEY_FILE}" --dry-run=client -o yaml | kubectl apply -f -
  fi
}

usage() {
  echo "Usage: $0 [-n namespace] [-r release] [-e env_file] [-c backend_config] [-d deep_thinker_config] [-f values_file] [--enable-tls] [--tls-secret-name name] [--uninstall-first] [--skip-config-sort] [--sort-lists] [--dry-run] [--] [extra helm args]" 1>&2
  echo "  -n namespace            Kubernetes namespace (default: daedalus)" 1>&2
  echo "  -r release              Helm release name (default: <chartVersion>-daedalus)" 1>&2
  echo "  -e env_file             .env file path for Secrets (default: $REPO_ROOT/.env)" 1>&2
  echo "  -c backend_config       Default backend config path (default: $REPO_ROOT/backend/tool-calling-config.yaml if exists)" 1>&2
  echo "  -d deep_thinker_config  Deep Thinker backend config path (default: $REPO_ROOT/backend/react-agent-config.yaml if exists)" 1>&2
  echo "  -f values_file          values.yaml path (default: $CHART_DIR/values.yaml)" 1>&2
  echo "  --enable-tls            Enable HTTPS on nginx and create/update TLS Secret from nginx/ssl (.crt or .pem + .key)" 1>&2
  echo "  --tls-secret-name       TLS Secret name (default: <release>-tls)" 1>&2
  echo "  --uninstall-first       Uninstall release before install/upgrade" 1>&2
  echo "  --skip-config-sort      Skip automatic alphabetical sorting of backend config keys" 1>&2
  echo "  --sort-lists            Also sort list items alphabetically and remove duplicates" 1>&2
  echo "  --dry-run               Print actions without applying changes" 1>&2
}

# Defaults
NAMESPACE="daedalus"
CHART_VERSION=$(grep -E '^version:' "$CHART_DIR/Chart.yaml" | awk '{print $2}' || true)
if [[ -z "${CHART_VERSION}" ]]; then CHART_VERSION="0.1.0"; fi
# Default to a DNS-safe, human-friendly release name
RELEASE="daedalus"
ENV_FILE="$REPO_ROOT/.env"
VALUES_FILE="$CHART_DIR/values.yaml"
BACKEND_CONFIG_DEFAULT="$REPO_ROOT/backend/tool-calling-config.yaml"
BACKEND_CONFIG=""
DEEP_THINKER_CONFIG_DEFAULT="$REPO_ROOT/backend/react-agent-config.yaml"
DEEP_THINKER_CONFIG=""
UNINSTALL_FIRST="false"
SKIP_CONFIG_SORT="false"
SORT_LISTS="false"
DRY_RUN="false"
HELM_EXTRA_ARGS=()
ENABLE_TLS="false"
TLS_SECRET_NAME=""
ENV_FILE_PRESENT="false"
USE_RELEASE_SECRETS="false"
HELM_PRESET_PVC_IMAGES=()
HELM_PRESET_PVC_REDIS=()
HELM_PRESET_PVC_REDISINSIGHT=()

configure_pvc_presets() {
  local images_pvc
  local redis_pvc
  local redisinsight_pvc
  local backend_pvc
  images_pvc="${RELEASE}-images"
  redis_pvc="${RELEASE}-redis"
  redisinsight_pvc="${RELEASE}-redisinsight"
  backend_pvc="${RELEASE}-backend"

  echo -e "\n${Cyan}Checking for existing PVCs...${Color_Off}"

  # Default to allowing Helm to (re)create PVCs and ensure existingClaimName is cleared
  HELM_PRESET_PVC_IMAGES=( --set nginx.imageVolume.create=true --set-string nginx.imageVolume.existingClaimName="" )
  HELM_PRESET_PVC_REDIS=( --set redis.persistence.create=true --set-string redis.persistence.existingClaimName="" )
  HELM_PRESET_PVC_REDISINSIGHT=( --set redisinsight.persistence.create=true --set-string redisinsight.persistence.existingClaimName="" )
  HELM_PRESET_PVC_BACKEND=( --set backend.persistence.create=true --set-string backend.persistence.existingClaimName="" )

  if kubectl -n "$NAMESPACE" get pvc "$images_pvc" >/dev/null 2>&1; then
    echo -e "${Yellow}✓ Found existing PVC:${Color_Off} $images_pvc (will not create in Helm)"
    HELM_PRESET_PVC_IMAGES=( --set nginx.imageVolume.create=false --set nginx.imageVolume.existingClaimName="$images_pvc" )
  else
    echo -e "${Green}• Will create PVC:${Color_Off} $images_pvc"
  fi

  if kubectl -n "$NAMESPACE" get pvc "$redis_pvc" >/dev/null 2>&1; then
    echo -e "${Yellow}✓ Found existing PVC:${Color_Off} $redis_pvc (will not create in Helm)"
    HELM_PRESET_PVC_REDIS=( --set redis.persistence.create=false --set redis.persistence.existingClaimName="$redis_pvc" )
  else
    echo -e "${Green}• Will create PVC:${Color_Off} $redis_pvc"
  fi

  if kubectl -n "$NAMESPACE" get pvc "$redisinsight_pvc" >/dev/null 2>&1; then
    echo -e "${Yellow}✓ Found existing PVC:${Color_Off} $redisinsight_pvc (will not create in Helm)"
    HELM_PRESET_PVC_REDISINSIGHT=( --set redisinsight.persistence.create=false --set redisinsight.persistence.existingClaimName="$redisinsight_pvc" )
  else
    echo -e "${Green}• Will create PVC:${Color_Off} $redisinsight_pvc"
  fi

  if kubectl -n "$NAMESPACE" get pvc "$backend_pvc" >/dev/null 2>&1; then
    echo -e "${Yellow}✓ Found existing PVC:${Color_Off} $backend_pvc (will not create in Helm)"
    HELM_PRESET_PVC_BACKEND=( --set backend.persistence.create=false --set backend.persistence.existingClaimName="$backend_pvc" )
  else
    echo -e "${Green}• Will create PVC:${Color_Off} $backend_pvc ${Red}(CRITICAL for backend pods)${Color_Off}"
  fi

  echo ""
}

# Sanitize a string into a valid Helm/K8s release name (DNS-1035 compliant)
sanitize_release() {
  local input="$1"
  # lowercase, replace invalid chars with '-', collapse repeats, trim edges
  local out
  out=$(echo -n "$input" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/-{2,}/-/g; s/^-+//; s/-+$//')
  # must start with a letter
  if [[ ! "$out" =~ ^[a-z] ]]; then
    out="r-${out}"
  fi
  # ensure non-empty
  if [[ -z "$out" ]]; then
    out="daedalus"
  fi
  echo -n "$out"
}

sort_backend_config_keys() {
  local config_file="$1"
  local sort_lists="${2:-false}"  # Optional parameter to sort lists (default: false)

  if [[ ! -f "$config_file" ]]; then
    echo -e "${Yellow}Config file not found, skipping sort: $config_file${Color_Off}"
    return 0
  fi

  if [[ "$sort_lists" == "true" ]]; then
    echo -e "${Cyan}Sorting keys and lists (removing duplicates) in backend config: $config_file${Color_Off}"
  else
    echo -e "${Cyan}Sorting keys in backend config: $config_file${Color_Off}"
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    if [[ "$sort_lists" == "true" ]]; then
      echo "[dry-run] Would sort YAML keys and lists alphabetically (removing duplicates) in $config_file"
    else
      echo "[dry-run] Would sort YAML keys alphabetically in $config_file"
    fi
    return 0
  fi

  local temp_sorted
  temp_sorted=$(mktemp)

  python3 -c "
import yaml
import sys

def sort_dict_recursive(obj, sort_lists=False):
    if isinstance(obj, dict):
        return {k: sort_dict_recursive(v, sort_lists) for k, v in sorted(obj.items())}
    elif isinstance(obj, list):
        if sort_lists:
            # Sort list items if they are strings or have a consistent type
            try:
                # Remove duplicates while preserving order for sortable items
                seen = set()
                unique_items = []
                for item in obj:
                    # For hashable items, check for duplicates
                    try:
                        if item not in seen:
                            seen.add(item)
                            unique_items.append(item)
                    except TypeError:
                        # For unhashable items (like dicts), just keep them
                        unique_items.append(item)

                # Sort the deduplicated list
                sorted_list = sorted(unique_items)
                return [sort_dict_recursive(item, sort_lists) for item in sorted_list]
            except (TypeError, AttributeError):
                # If list items aren't sortable (mixed types, dicts, etc.), just recurse
                return [sort_dict_recursive(item, sort_lists) for item in obj]
        else:
            return [sort_dict_recursive(item, sort_lists) for item in obj]
    return obj

try:
    with open('$config_file', 'r') as f:
        data = yaml.safe_load(f)
    sort_lists = '$sort_lists' == 'true'
    sorted_data = sort_dict_recursive(data, sort_lists)
    print(yaml.dump(sorted_data, default_flow_style=False, allow_unicode=True, width=float('inf')), end='')
except Exception as e:
    print(f'Error sorting YAML: {e}', file=sys.stderr)
    sys.exit(1)
" > "$temp_sorted"

  if [[ $? -eq 0 ]]; then
    mv "$temp_sorted" "$config_file"
    if [[ "$sort_lists" == "true" ]]; then
      echo -e "${Green}Successfully sorted keys and lists (duplicates removed) in $config_file${Color_Off}"
    else
      echo -e "${Green}Successfully sorted keys in $config_file${Color_Off}"
    fi
  else
    rm -f "$temp_sorted"
    echo -e "${Red}Failed to sort in $config_file${Color_Off}"
    return 1
  fi
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) NAMESPACE="$2"; shift 2;;
    -r) RELEASE="$2"; shift 2;;
    -e) ENV_FILE="$2"; shift 2;;
    -c) BACKEND_CONFIG="$2"; shift 2;;
    -d) DEEP_THINKER_CONFIG="$2"; shift 2;;
    -f) VALUES_FILE="$2"; shift 2;;
    --enable-tls) ENABLE_TLS="true"; shift;;
    --tls-secret-name) TLS_SECRET_NAME="$2"; shift 2;;
    --uninstall-first) UNINSTALL_FIRST="true"; shift;;
    --skip-config-sort) SKIP_CONFIG_SORT="true"; shift;;
    --sort-lists) SORT_LISTS="true"; shift;;
    --dry-run) DRY_RUN="true"; shift;;
    --) shift; HELM_EXTRA_ARGS+=("$@"); break;;
    -h|--help) usage; exit 0;;
    *) HELM_EXTRA_ARGS+=("$1"); shift;;
  esac
done

ORIGINAL_DIR=$(pwd)
if [[ ! -d "$REPO_ROOT" ]]; then
  echo -e "${Red}Repository root not found at $REPO_ROOT${Color_Off}"
  exit 1
fi
cd "$REPO_ROOT"
trap 'cd "$ORIGINAL_DIR"' EXIT

if [[ "${DRY_RUN}" != "true" ]]; then
  require_command kubectl
  require_command helm
  require_command docker
  if ! docker compose version >/dev/null 2>&1; then
    echo -e "${Red}docker compose is required but not available (Docker CLI v2).${Color_Off}"
    exit 1
  fi
else
  require_command helm
fi

clear
echo -e "${Cyan}"
echo "╔══════════════════════════════════════════════════╗"
echo "║            Preparing Daedalus deployment         ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${Color_Off}"
sleep 5
if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${Yellow}Dry-run mode: skipping docker compose build/push${Color_Off}"
else
  clear
  echo -e "${Red}"
  echo "╔══════════════════════════════════════════════════╗"
  echo "║            Pruning Docker images                 ║"
  echo "╚══════════════════════════════════════════════════╝"
  docker system prune -f
  echo -e "${Color_Off}"

  clear
  echo -e "${Yellow}"
  echo "╔══════════════════════════════════════════════════╗"
  echo "║            Building Daedalus images              ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo -e "${Color_Off}"
  docker compose build builder backend frontend

  clear
  echo -e "${Green}"
  echo "╔══════════════════════════════════════════════════╗"
  echo "║            Pushing Daedalus images               ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo -e "${Color_Off}"
  docker compose push backend builder frontend
fi

# Validations
if [[ -z "$CHART_DIR" ]]; then
  echo -e "${Red}Chart directory variable resolved to empty.${Color_Off}"; exit 1
fi

if [[ ! -d "$CHART_DIR" ]]; then
  echo -e "${Red}Chart directory not found: $CHART_DIR${Color_Off}"; exit 1
fi

if [[ ! -f "$CHART_DIR/Chart.yaml" ]]; then
  echo -e "${Red}Chart.yaml not found in $CHART_DIR${Color_Off}"; exit 1
fi

if [[ -z "$BACKEND_CONFIG" && -f "$BACKEND_CONFIG_DEFAULT" ]]; then
  BACKEND_CONFIG="$BACKEND_CONFIG_DEFAULT"
fi

if [[ -z "$DEEP_THINKER_CONFIG" && -f "$DEEP_THINKER_CONFIG_DEFAULT" ]]; then
  DEEP_THINKER_CONFIG="$DEEP_THINKER_CONFIG_DEFAULT"
fi

# Sort backend config keys alphabetically before deployment
if [[ "$SKIP_CONFIG_SORT" != "true" ]]; then
  if [[ -n "$BACKEND_CONFIG" && -f "$BACKEND_CONFIG" ]]; then
    sort_backend_config_keys "$BACKEND_CONFIG" "$SORT_LISTS"
  fi
  if [[ -n "$DEEP_THINKER_CONFIG" && -f "$DEEP_THINKER_CONFIG" ]]; then
    sort_backend_config_keys "$DEEP_THINKER_CONFIG" "$SORT_LISTS"
  fi
fi

echo -e "${Cyan}Namespace:${Color_Off} $NAMESPACE"
RELEASE_SAFE=$(sanitize_release "$RELEASE")
if [[ "$RELEASE_SAFE" != "$RELEASE" ]]; then
  echo -e "${Yellow}Adjusted release to DNS-safe name:${Color_Off} $RELEASE_SAFE (from '$RELEASE')"
fi
RELEASE="$RELEASE_SAFE"
echo -e "${Cyan}Release:${Color_Off}   $RELEASE"
echo -e "${Cyan}Chart:${Color_Off}     $CHART_DIR"
echo -e "${Cyan}Values:${Color_Off}    ${VALUES_FILE:-<none>}"
echo -e "${Cyan}Env file:${Color_Off}  ${ENV_FILE:-<none>}"
echo -e "${Cyan}Default backend cfg:${Color_Off} ${BACKEND_CONFIG:-<none>}"
echo -e "${Cyan}Deep Thinker cfg:${Color_Off} ${DEEP_THINKER_CONFIG:-<none>}"
echo -e "${Cyan}TLS enabled:${Color_Off} ${ENABLE_TLS}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${Yellow}Dry-run mode: no changes will be applied${Color_Off}"
fi

ensure_namespace "$NAMESPACE"

# Check PVC status before proceeding
if [[ "$DRY_RUN" != "true" ]]; then
  echo -e "\n${Cyan}Verifying PVC requirements...${Color_Off}"

  # Check critical backend PVC
  if ! kubectl -n "$NAMESPACE" get pvc "${RELEASE}-backend" >/dev/null 2>&1; then
    if [[ "$UNINSTALL_FIRST" != "true" ]]; then
      echo -e "${Red}WARNING: Backend PVC '${RELEASE}-backend' does not exist!${Color_Off}"
      echo -e "${Yellow}The backend pods will fail to start without this PVC.${Color_Off}"
      echo -e "${Yellow}Helm will attempt to create it, but if you have specific storage requirements,${Color_Off}"
      echo -e "${Yellow}you may want to create it manually first or use --uninstall-first to start fresh.${Color_Off}"
      echo ""
      read -p "Continue with deployment? (y/N) " -n 1 -r
      echo
      if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${Red}Deployment cancelled.${Color_Off}"
        exit 1
      fi
    fi
  fi
fi

# Validate required assets before any uninstall logic so we fail fast
validate_env_file
if [[ "$ENABLE_TLS" == "true" ]]; then
  validate_tls_materials
fi

# Auto-detect existing PVCs to avoid Helm ownership conflicts
configure_pvc_presets

# Optional uninstall first
if [[ "$UNINSTALL_FIRST" == "true" ]]; then
  echo -e "${Red}Uninstalling existing release (if any)...${Color_Off}"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "helm uninstall $RELEASE -n $NAMESPACE || true"
    echo "kubectl delete namespace $NAMESPACE || true"
  else
    helm uninstall "$RELEASE" -n "$NAMESPACE" || true
    kubectl delete namespace "$NAMESPACE" || true
    echo -e "${Yellow}Waiting for namespace $NAMESPACE to fully terminate...${Color_Off}"
    if ! wait_for_namespace_deletion "$NAMESPACE" 300; then
      echo -e "${Red}Namespace $NAMESPACE did not terminate cleanly; aborting deployment.${Color_Off}"
      exit 1
    fi
  fi
  ensure_namespace "$NAMESPACE"
  # Namespace delete wipes PVC if not retained; refresh presets for the new namespace state
  configure_pvc_presets
fi

# Recreate secrets/config after ensure_namespace, including after uninstall
apply_env_secrets
apply_tls_secret

echo -e "${Yellow}Installing/Upgrading Daedalus...${Color_Off}"
HELM_CMD=(helm upgrade --install "$RELEASE" "$CHART_DIR" -n "$NAMESPACE" --wait --timeout 10m --create-namespace --atomic --wait-for-jobs --history-max 5)

if [[ -n "${VALUES_FILE}" && -f "${VALUES_FILE}" ]]; then
  HELM_CMD+=( -f "$VALUES_FILE" )
fi
# Always treat env Secrets as external to avoid Helm ownership conflicts.
HELM_CMD+=( --set backend.env.createSecret=false --set frontend.env.createSecret=false )
# Point the chart to use per-release secrets if we created them.
if [[ "$ENV_FILE_PRESENT" == "true" ]]; then
  HELM_CMD+=( --set backend.env.fromSecret="$RELEASE-backend-env" --set frontend.env.fromSecret="$RELEASE-frontend-env" )
fi
if [[ ${#HELM_PRESET_PVC_IMAGES[@]} -gt 0 ]]; then
  HELM_CMD+=( "${HELM_PRESET_PVC_IMAGES[@]}" )
fi
if [[ ${#HELM_PRESET_PVC_REDIS[@]} -gt 0 ]]; then
  HELM_CMD+=( "${HELM_PRESET_PVC_REDIS[@]}" )
fi
if [[ ${#HELM_PRESET_PVC_REDISINSIGHT[@]} -gt 0 ]]; then
  HELM_CMD+=( "${HELM_PRESET_PVC_REDISINSIGHT[@]}" )
fi
if [[ ${#HELM_PRESET_PVC_BACKEND[@]} -gt 0 ]]; then
  HELM_CMD+=( "${HELM_PRESET_PVC_BACKEND[@]}" )
fi
if [[ -n "${BACKEND_CONFIG}" && -f "${BACKEND_CONFIG}" ]]; then
  HELM_CMD+=( --set-file backend.default.config.data="$BACKEND_CONFIG" )
fi
if [[ -n "${DEEP_THINKER_CONFIG}" && -f "${DEEP_THINKER_CONFIG}" ]]; then
  HELM_CMD+=( --set-file backend.deepThinker.config.data="$DEEP_THINKER_CONFIG" )
fi
# If TLS is enabled, pass Helm values to expose 443 and bind the Secret
if [[ "$ENABLE_TLS" == "true" ]]; then
  SECRET_NAME="${TLS_SECRET_NAME:-$RELEASE-tls}"
  HELM_CMD+=( --set nginx.https.enabled=true --set nginx.https.tlsSecretName="$SECRET_NAME" --set nginx.service.type=NodePort --set nginx.service.nodePorts.https=30443)
  HELM_CMD+=( --set redisinsight.service.type=NodePort --set redisinsight.service.nodePorts.https=30540)
fi
if [[ ${#HELM_EXTRA_ARGS[@]} -gt 0 ]]; then
  HELM_CMD+=( "${HELM_EXTRA_ARGS[@]}" )
fi

if [[ "$DRY_RUN" == "true" ]]; then
  printf '%q ' "${HELM_CMD[@]}"; echo
else
  echo -e "${Cyan}Running helm command:${Color_Off}"
  printf '  %q' "${HELM_CMD[@]}"; echo
  "${HELM_CMD[@]}"
fi



echo -e "${Green}Done.${Color_Off}"

echo -e "\n${Cyan}Deployment status:${Color_Off}"
kubectl get all -n "$NAMESPACE"

echo -e "\n${Cyan}PVC status:${Color_Off}"
kubectl get pvc -n "$NAMESPACE"

echo -e "\n${Cyan}Checking backend pod status...${Color_Off}"
backend_ready=false
attempts=0
max_attempts=30

while [[ $attempts -lt $max_attempts ]]; do
  if kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=backend-default -o jsonpath='{.items[*].status.phase}' | grep -q "Running"; then
    backend_ready=true
    break
  fi
  echo -n "."
  sleep 2
  ((attempts++))
done

if [[ "$backend_ready" == "true" ]]; then
  echo -e "\n${Green}✓ Default backend pod is running${Color_Off}"
  echo -e "${Cyan}Following logs for default backend pod...${Color_Off}"
  kubectl logs -f deployment/${RELEASE}-backend-default -n "$NAMESPACE"
else
  echo -e "\n${Red}✗ Backend pods are not ready yet. Checking pod events...${Color_Off}"
  kubectl describe pods -l app.kubernetes.io/component=backend-default -n "$NAMESPACE" | grep -A 10 "Events:"
  kubectl describe pods -l app.kubernetes.io/component=backend-deep-thinker -n "$NAMESPACE" | grep -A 10 "Events:"
  echo -e "\n${Yellow}To check pod status: kubectl get pods -n $NAMESPACE${Color_Off}"
  echo -e "${Yellow}To check PVC status: kubectl get pvc -n $NAMESPACE${Color_Off}"
  echo -e "${Yellow}To follow logs when ready: kubectl logs -f deployment/${RELEASE}-backend-default -n $NAMESPACE${Color_Off}"
fi
