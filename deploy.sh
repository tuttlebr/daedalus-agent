#!/bin/bash
echo "Deploying Daedalus"
echo "================================"
echo ""
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults
NAMESPACE="daedalus"
RELEASE="daedalus"
ENV_FILE="$SCRIPT_DIR/.env"
VALUES_FILE="$SCRIPT_DIR/custom-values.yaml"
BACKEND_CONFIG="$SCRIPT_DIR/backend/tool-calling-config.yaml"
SKIP_BUILD=false
SKIP_TLS=false
SKIP_MCP_PREFLIGHT=false
MCP_PREFLIGHT_TIMEOUT="${MCP_PREFLIGHT_TIMEOUT:-20}"
MCP_PREFLIGHT_KUBECTL_IMAGE="${MCP_PREFLIGHT_KUBECTL_IMAGE:-curlimages/curl:8.8.0@sha256:73e4d532ea62d7505c5865b517d3704966ffe916609bedc22af6833dc9969bcd}"
DRY_RUN=false
ALLOW_UNSIGNED_IMAGES="${ALLOW_UNSIGNED_IMAGES:-false}"
ALLOW_DIRTY_SOURCE="${ALLOW_DIRTY_SOURCE:-false}"
COSIGN_KEYLESS="${COSIGN_KEYLESS:-false}"
RELEASE_EVIDENCE_FILE="${RELEASE_EVIDENCE_FILE:-/tmp/daedalus-release-evidence.json}"
RELEASE_METADATA_FILE="${RELEASE_METADATA_FILE:-}"
RELEASE_METADATA_SIGNATURE_FILE="${RELEASE_METADATA_SIGNATURE_FILE:-}"
RELEASE_METADATA_CERTIFICATE_FILE="${RELEASE_METADATA_CERTIFICATE_FILE:-}"

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
      --skip-mcp-preflight   Skip MCP server reachability checks
      --mcp-preflight-timeout SECONDS
                             Per-request MCP pre-flight timeout (default: $MCP_PREFLIGHT_TIMEOUT)
      --mcp-preflight-kubectl-image IMAGE
                             Image used for cluster-local MCP checks
                             (default: $MCP_PREFLIGHT_KUBECTL_IMAGE)
      --dry-run              Print what would happen without applying
      --allow-unsigned-images
                             Explicitly allow an unsigned development release
      --allow-dirty-source   Explicitly allow deploying from a dirty worktree
      --release-metadata PATH
                             Signed release-metadata.json for --skip-build
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
    --skip-mcp-preflight) SKIP_MCP_PREFLIGHT=true; shift ;;
    --mcp-preflight-timeout) MCP_PREFLIGHT_TIMEOUT="$2"; shift 2 ;;
    --mcp-preflight-kubectl-image) MCP_PREFLIGHT_KUBECTL_IMAGE="$2"; shift 2 ;;
    --dry-run)          DRY_RUN=true; shift ;;
    --allow-unsigned-images) ALLOW_UNSIGNED_IMAGES=true; shift ;;
    --allow-dirty-source) ALLOW_DIRTY_SOURCE=true; shift ;;
    --release-metadata) RELEASE_METADATA_FILE="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

COMPOSE_CMD=(docker compose -f "$SCRIPT_DIR/docker-compose.yaml")
if [[ -f "$ENV_FILE" ]]; then
  COMPOSE_CMD=(docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.yaml")
fi

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
if [[ "$DRY_RUN" == false && "$ALLOW_DIRTY_SOURCE" != true ]]; then
  if [[ -n "$(git -C "$SCRIPT_DIR" status --porcelain --untracked-files=normal)" ]]; then
    echo "ERROR: Refusing to build or deploy from a dirty worktree." >&2
    echo "Commit the intended source or pass --allow-dirty-source for development." >&2
    exit 1
  fi
fi

if [[ "$SKIP_BUILD" == false ]]; then
  log "Building images with provenance and SBOM attestations, then pushing"
  RELEASE_SERVICES=(backend frontend redis)
  run "${COMPOSE_CMD[@]}" build --provenance=mode=max --sbom=true "${RELEASE_SERVICES[@]}"
  # Limit pushes to repository-owned images. Compose also contains pinned
  # upstream runtime services that must never be republished under their names.
  run "${COMPOSE_CMD[@]}" push "${RELEASE_SERVICES[@]}"
fi

# Resolve application images to immutable registry digests. A local build is
# scanned before it can be signed or deployed. A prebuilt release is accepted
# only when its signed metadata proves the exact commit, CI result, scan result,
# image mapping, signatures, and build provenance attestations.
IMAGE_DIGEST_ARGS=()
if [[ "$DRY_RUN" == false ]]; then
  compose_image_ref() {
    local service="$1"
    "${COMPOSE_CMD[@]}" config --format json | python3 -c \
      'import json,sys; print(json.load(sys.stdin)["services"][sys.argv[1]]["image"])' \
      "$service"
  }

  registry_digest() {
    local image_ref="$1"
    local digest
    digest="$(docker buildx imagetools inspect "$image_ref" --format '{{.Manifest.Digest}}')"
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "ERROR: Could not resolve immutable digest for $image_ref" >&2
      exit 1
    fi
    printf '%s' "$digest"
  }

  image_repository() {
    local image_ref="${1%@*}"
    local final_component="${image_ref##*/}"
    if [[ "$final_component" == *:* ]]; then
      image_ref="${image_ref%:*}"
    fi
    printf '%s' "$image_ref"
  }

  metadata_image_ref() {
    python3 - "$RELEASE_METADATA_FILE" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)["images"][sys.argv[2]])
PY
  }

  metadata_value() {
    python3 - "$RELEASE_METADATA_FILE" "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for key in sys.argv[2:]:
    value = value[key]
print(value)
PY
  }

  verify_keyless_settings() {
    if [[ -z "${COSIGN_CERTIFICATE_IDENTITY_REGEXP:-}" || -z "${COSIGN_CERTIFICATE_OIDC_ISSUER:-}" ]]; then
      echo "ERROR: Set COSIGN_CERTIFICATE_IDENTITY_REGEXP and COSIGN_CERTIFICATE_OIDC_ISSUER" >&2
      echo "       to verify the keyless release identity." >&2
      exit 1
    fi
  }

  verify_release_metadata() {
    local signature_file certificate_file
    signature_file="${RELEASE_METADATA_SIGNATURE_FILE:-${RELEASE_METADATA_FILE}.sig}"
    certificate_file="${RELEASE_METADATA_CERTIFICATE_FILE:-${RELEASE_METADATA_FILE}.pem}"
    [[ -f "$RELEASE_METADATA_FILE" ]] || {
      echo "ERROR: --skip-build requires --release-metadata PATH" >&2
      exit 1
    }
    [[ -f "$signature_file" ]] || {
      echo "ERROR: Missing release metadata signature: $signature_file" >&2
      exit 1
    }
    command -v cosign >/dev/null 2>&1 || {
      echo "ERROR: cosign is required to verify prebuilt release metadata" >&2
      exit 1
    }

    if [[ -n "${RELEASE_METADATA_PUBLIC_KEY:-}" ]]; then
      cosign verify-blob \
        --key "$RELEASE_METADATA_PUBLIC_KEY" \
        --signature "$signature_file" \
        "$RELEASE_METADATA_FILE" >/dev/null
    else
      verify_keyless_settings
      [[ -f "$certificate_file" ]] || {
        echo "ERROR: Missing release metadata certificate: $certificate_file" >&2
        exit 1
      }
      cosign verify-blob \
        --certificate "$certificate_file" \
        --signature "$signature_file" \
        --certificate-identity-regexp "$COSIGN_CERTIFICATE_IDENTITY_REGEXP" \
        --certificate-oidc-issuer "$COSIGN_CERTIFICATE_OIDC_ISSUER" \
        "$RELEASE_METADATA_FILE" >/dev/null
    fi

    python3 - "$RELEASE_METADATA_FILE" "$(git -C "$SCRIPT_DIR" rev-parse HEAD)" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    metadata = json.load(handle)

commit = sys.argv[2]
if metadata.get("schemaVersion") != 1:
    raise SystemExit("release metadata has an unsupported schemaVersion")
if metadata.get("commit") != commit:
    raise SystemExit("release metadata commit does not match the checked-out source")

source = metadata.get("source", {})
if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source.get("repository", "")):
    raise SystemExit("release metadata has an invalid source repository")
if not re.fullmatch(r"refs/(heads|tags)/[^\s]+", source.get("ref", "")):
    raise SystemExit("release metadata has an invalid source ref")

ci = metadata.get("ci", {})
if (
    ci.get("headSha") != commit
    or ci.get("event") != "push"
    or ci.get("branch") != "main"
    or ci.get("conclusion") != "success"
):
    raise SystemExit("release metadata does not prove successful CI for this commit")

digest_ref = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
for role in ("backend", "frontend", "redis"):
    image = metadata.get("images", {}).get(role, "")
    if not isinstance(image, str) or not digest_ref.fullmatch(image):
        raise SystemExit(f"release metadata has an invalid {role} image reference")
    if metadata.get("security", {}).get("scans", {}).get(role) != "passed":
        raise SystemExit(f"release metadata does not prove a passed {role} vulnerability scan")
    if metadata.get("signatures", {}).get(role) != "signed":
        raise SystemExit(f"release metadata does not prove a signed {role} image")
    if metadata.get("attestations", {}).get(role) != "published":
        raise SystemExit(f"release metadata does not prove a published {role} attestation")
PY
  }

  verify_image_signature() {
    local image_ref="$1"
    if [[ -n "${COSIGN_PUBLIC_KEY:-}" ]]; then
      cosign verify --key "$COSIGN_PUBLIC_KEY" "$image_ref" >/dev/null
    else
      verify_keyless_settings
      cosign verify \
        --certificate-identity-regexp "$COSIGN_CERTIFICATE_IDENTITY_REGEXP" \
        --certificate-oidc-issuer "$COSIGN_CERTIFICATE_OIDC_ISSUER" \
        "$image_ref" >/dev/null
    fi
  }

  verify_build_attestation() {
    local image_ref="$1"
    command -v gh >/dev/null 2>&1 || {
      echo "ERROR: GitHub CLI is required to verify release provenance" >&2
      exit 1
    }
    gh attestation verify "oci://$image_ref" \
      --bundle-from-oci \
      --deny-self-hosted-runners \
      --repo "$RELEASE_SOURCE_REPOSITORY" \
      --signer-workflow "$RELEASE_SOURCE_REPOSITORY/.github/workflows/release.yml" \
      --source-digest "$RELEASE_SOURCE_COMMIT" \
      --source-ref "$RELEASE_SOURCE_REF" >/dev/null
  }

  if [[ "$SKIP_BUILD" == true ]]; then
    if [[ "$ALLOW_UNSIGNED_IMAGES" == true ]]; then
      echo "ERROR: --allow-unsigned-images cannot bypass prebuilt release verification" >&2
      exit 1
    fi
    verify_release_metadata
    RELEASE_SOURCE_COMMIT="$(metadata_value commit)"
    RELEASE_SOURCE_REPOSITORY="$(metadata_value source repository)"
    RELEASE_SOURCE_REF="$(metadata_value source ref)"
    BACKEND_IMMUTABLE_REF="$(metadata_image_ref backend)"
    FRONTEND_IMMUTABLE_REF="$(metadata_image_ref frontend)"
    REDIS_IMMUTABLE_REF="$(metadata_image_ref redis)"
    BACKEND_IMAGE_REPOSITORY="$(image_repository "$BACKEND_IMMUTABLE_REF")"
    FRONTEND_IMAGE_REPOSITORY="$(image_repository "$FRONTEND_IMMUTABLE_REF")"
    REDIS_IMAGE_REPOSITORY="$(image_repository "$REDIS_IMMUTABLE_REF")"
    BACKEND_IMAGE_DIGEST="${BACKEND_IMMUTABLE_REF##*@}"
    FRONTEND_IMAGE_DIGEST="${FRONTEND_IMMUTABLE_REF##*@}"
    REDIS_IMAGE_DIGEST="${REDIS_IMMUTABLE_REF##*@}"

    for image_ref in \
      "$BACKEND_IMMUTABLE_REF" \
      "$FRONTEND_IMMUTABLE_REF" \
      "$REDIS_IMMUTABLE_REF"; do
      [[ "$(registry_digest "$image_ref")" == "${image_ref##*@}" ]] || {
        echo "ERROR: Registry digest does not match signed release metadata: $image_ref" >&2
        exit 1
      }
      verify_image_signature "$image_ref"
      verify_build_attestation "$image_ref"
    done
  else
    BACKEND_IMAGE_REF="$(compose_image_ref backend)"
    FRONTEND_IMAGE_REF="$(compose_image_ref frontend)"
    REDIS_IMAGE_REF="$(compose_image_ref redis)"
    BACKEND_IMAGE_DIGEST="$(registry_digest "$BACKEND_IMAGE_REF")"
    FRONTEND_IMAGE_DIGEST="$(registry_digest "$FRONTEND_IMAGE_REF")"
    REDIS_IMAGE_DIGEST="$(registry_digest "$REDIS_IMAGE_REF")"
    BACKEND_IMAGE_REPOSITORY="$(image_repository "$BACKEND_IMAGE_REF")"
    FRONTEND_IMAGE_REPOSITORY="$(image_repository "$FRONTEND_IMAGE_REF")"
    REDIS_IMAGE_REPOSITORY="$(image_repository "$REDIS_IMAGE_REF")"
    BACKEND_IMMUTABLE_REF="$BACKEND_IMAGE_REPOSITORY@$BACKEND_IMAGE_DIGEST"
    FRONTEND_IMMUTABLE_REF="$FRONTEND_IMAGE_REPOSITORY@$FRONTEND_IMAGE_DIGEST"
    REDIS_IMMUTABLE_REF="$REDIS_IMAGE_REPOSITORY@$REDIS_IMAGE_DIGEST"

    command -v trivy >/dev/null 2>&1 || {
      echo "ERROR: trivy is required to scan locally built release images" >&2
      exit 1
    }
    for image_ref in \
      "$BACKEND_IMMUTABLE_REF" \
      "$FRONTEND_IMMUTABLE_REF" \
      "$REDIS_IMMUTABLE_REF"; do
      trivy image --scanners vuln --severity CRITICAL,HIGH --exit-code 1 "$image_ref"
    done

    if [[ "$ALLOW_UNSIGNED_IMAGES" == true ]]; then
      log "WARNING: unsigned image opt-out is active for this local build"
    else
      command -v cosign >/dev/null 2>&1 || {
        echo "ERROR: cosign is required to sign release images" >&2
        exit 1
      }
      if [[ -n "${COSIGN_KEY:-}" ]]; then
        cosign sign --yes --key "$COSIGN_KEY" "$BACKEND_IMMUTABLE_REF"
        cosign sign --yes --key "$COSIGN_KEY" "$FRONTEND_IMMUTABLE_REF"
        cosign sign --yes --key "$COSIGN_KEY" "$REDIS_IMMUTABLE_REF"
      elif [[ "$COSIGN_KEYLESS" == true ]]; then
        cosign sign --yes "$BACKEND_IMMUTABLE_REF"
        cosign sign --yes "$FRONTEND_IMMUTABLE_REF"
        cosign sign --yes "$REDIS_IMMUTABLE_REF"
      else
        echo "ERROR: Set COSIGN_KEY or COSIGN_KEYLESS=true, or explicitly pass" >&2
        echo "       --allow-unsigned-images for a development-only local build." >&2
        exit 1
      fi
    fi
  fi

  IMAGE_DIGEST_ARGS+=(
    --set-string "images.backend.repository=$BACKEND_IMAGE_REPOSITORY"
    --set-string "images.backend.digest=$BACKEND_IMAGE_DIGEST"
    --set-string "images.frontend.repository=$FRONTEND_IMAGE_REPOSITORY"
    --set-string "images.frontend.digest=$FRONTEND_IMAGE_DIGEST"
    --set-string "images.redis.repository=$REDIS_IMAGE_REPOSITORY"
    --set-string "images.redis.digest=$REDIS_IMAGE_DIGEST"
  )
  log "Resolved backend image to $BACKEND_IMAGE_DIGEST"
  log "Resolved frontend image to $FRONTEND_IMAGE_DIGEST"
  log "Resolved Redis image to $REDIS_IMAGE_DIGEST"
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
# Create least-privilege workload secrets from .env (idempotent)
# -------------------------------------------------------------------
HELM_SECRET_ARGS=()
DOCUMENT_OBJECT_SECRET_PREPARED=false
if [[ -f "$ENV_FILE" ]]; then
  log "Applying allowlisted workload secrets from $ENV_FILE"
  SECRET_ENV_DIR="$(mktemp -d)"
  cleanup_secret_env_dir() {
    if [[ -n "${SECRET_ENV_DIR:-}" && -d "$SECRET_ENV_DIR" ]]; then
      rm -rf -- "$SECRET_ENV_DIR"
    fi
  }
  trap cleanup_secret_env_dir EXIT

  filter_env_file() {
    local output_file="$1"
    shift
    python3 - "$ENV_FILE" "$output_file" "$@" <<'PY'
import fnmatch
import re
import sys

source, destination, *patterns = sys.argv[1:]
entries = {}
with open(source, encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if any(fnmatch.fnmatchcase(key, pattern) for pattern in patterns):
            entries[key] = value

with open(destination, "w", encoding="utf-8") as handle:
    for key in sorted(entries):
        handle.write(f"{key}={entries[key]}\n")
PY
  }

  apply_env_secret() {
    local secret_name="$1"
    local env_file="$2"
    if [[ "$DRY_RUN" == true ]]; then
      echo "[dry-run] apply allowlisted keys from $env_file to Secret $secret_name"
    else
      kubectl -n "$NAMESPACE" create secret generic "$secret_name" \
        --from-env-file="$env_file" --dry-run=client -o yaml | kubectl apply -f -
    fi
  }

  BACKEND_SECRET_KEYS=(
    DAEDALUS_PHOENIX_ENDPOINT PHOENIX_PROJECT_NAME PHOENIX_API_KEY
    OTEL_EXPORTER_OTLP_HEADERS PHOENIX_CLIENT_HEADERS
    ARIZE_SPACE_ID ARIZE_API_KEY ARIZE_PROJECT_NAME ARIZE_USE_EU_REGION
    KUBERNETES_MCP_SERVER KUBERNETES_MCP_TOKEN UNIFI_MCP_SERVER UNIFI_MCP_TOKEN
    DAEDALUS_REQUIRED_MCP_GROUPS GOOGLE_MCP_CLIENT_ID GOOGLE_MCP_CLIENT_SECRET
    GOOGLE_MCP_REDIRECT_URI LLM_SANDBOX_BASE_URL LLM_SANDBOX_API_KEY
    MILVUS_URI MILVUS_USERNAME MILVUS_USER MILVUS_PASSWORD MILVUS_TOKEN
    MILVUS_DATABASE MILVUS_METADATA_TIMEOUT_SECONDS
    MINIO_ENDPOINT MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_SESSION_TOKEN MINIO_BUCKET
    NV_INGEST_HOST NV_INGEST_PORT TOKENIZER EMBEDDING_DENSE_DIM
    DOCUMENT_INGEST_* DOCUMENT_MARKDOWN_MAX_CHARS RATE_LIMIT_DOC_MARKDOWN_*
    RATE_LIMIT_IMAGE_JOB_* NVIDIA_API_KEY OPENAI_API_KEY FIREWORKS_API_KEY
    FIREWORKS_SOURCE_VERIFIER_MODEL PERPLEXITY_SEARCH_API_KEY GITHUB_PAT
    IMAGE_AUGMENTATION_* IMAGE_COMPREHENSION_* IMAGE_GENERATION_*
    EMBEDDING_* RERANKER_* DEFAULT_LLM_MODEL_* REASONING_LLM_MODEL_*
    REACT_LLM_MODEL_* TOOL_CALLING_LLM_MODEL_* DISTILL_LLM_MODEL_*
    DAEDALUS_LLM_* NAT_CONFIG_FILE NAT_HOST NAT_PORT NAT_LOG_LEVEL LOG_LEVEL
    APPROVAL_REDIS_URL AUTONOMY_IDEMPOTENCY_TTL_SECONDS
  )
  FRONTEND_SECRET_KEYS=(
    DEPLOYMENT_MODE BACKEND_HOST BACKEND_NAMESPACE BACKEND_PORT BACKEND_API_PATH
    DOCUMENT_INGEST_TIMEOUT_MS NAT_SUBMIT_MAX_RETRIES NAT_RETRY_DELAY_MS
    NAT_CONNECTIVITY_TIMEOUT_MS STREAM_ABORT_POLL_INTERVAL_MS
    STREAM_READ_IDLE_TIMEOUT_MS DAEDALUS_DEBUG_REPLAY DOCUMENT_UPLOAD_MAX_MB
    DOCUMENT_UPLOAD_MAX_CONCURRENT_PER_USER NEXT_PUBLIC_* DEFAULT_MODEL
    FORCE_SECURE_COOKIES WS_PORT WS_MAX_MESSAGE_BYTES
    WS_MAX_JOB_SUBSCRIPTIONS_PER_CONNECTION WS_MAX_CHAT_SUBSCRIPTIONS_PER_CONNECTION
    FRONTEND_READY_TIMEOUT_MS REDIS_MAX_RETRIES_PER_REQUEST REDIS_COMMAND_TIMEOUT_MS
    VAPID_PRIVATE_KEY GENERATED_IMAGE_LEGACY_PUBLIC ADMIN_USERNAME
    USAGE_TRACKING_INTERNAL_TOKEN AUTH_USERNAME AUTH_PASSWORD AUTH_NAME
    AUTH_LOGIN_WINDOW_SECONDS AUTH_LOGIN_LOCKOUT_SECONDS AUTH_LOGIN_MAX_ATTEMPTS
    AUTH_TRUSTED_PROXY_HOPS AUTH_USER_* DAEDALUS_DEFAULT_USER LOG_LEVEL
  )
  STREAM_WORKER_SECRET_KEYS=(
    DEPLOYMENT_MODE BACKEND_HOST BACKEND_NAMESPACE BACKEND_PORT BACKEND_API_PATH
    DOCUMENT_INGEST_TIMEOUT_MS NAT_SUBMIT_MAX_RETRIES NAT_RETRY_DELAY_MS
    NAT_CONNECTIVITY_TIMEOUT_MS STREAM_ABORT_POLL_INTERVAL_MS
    STREAM_READ_IDLE_TIMEOUT_MS DAEDALUS_DEBUG_REPLAY NEXT_PUBLIC_VAPID_PUBLIC_KEY
    VAPID_PRIVATE_KEY REDIS_MAX_RETRIES_PER_REQUEST REDIS_COMMAND_TIMEOUT_MS
    STREAM_WORKER_* LOG_LEVEL
  )

  BACKEND_SECRET_FILE="$SECRET_ENV_DIR/backend.env"
  FRONTEND_SECRET_FILE="$SECRET_ENV_DIR/frontend.env"
  STREAM_WORKER_SECRET_FILE="$SECRET_ENV_DIR/stream-worker.env"
  filter_env_file "$BACKEND_SECRET_FILE" "${BACKEND_SECRET_KEYS[@]}"
  filter_env_file "$FRONTEND_SECRET_FILE" "${FRONTEND_SECRET_KEYS[@]}"
  filter_env_file "$STREAM_WORKER_SECRET_FILE" "${STREAM_WORKER_SECRET_KEYS[@]}"

  apply_env_secret "$RELEASE-backend-env" "$BACKEND_SECRET_FILE"
  apply_env_secret "$RELEASE-frontend-env" "$FRONTEND_SECRET_FILE"
  apply_env_secret "$RELEASE-stream-worker-env" "$STREAM_WORKER_SECRET_FILE"
  HELM_SECRET_ARGS+=(
    --set-string "backend.default.env.fromSecret=$RELEASE-backend-env"
    --set-string "frontend.env.fromSecret=$RELEASE-frontend-env"
    --set-string "frontend.streamWorker.env.fromSecret=$RELEASE-stream-worker-env"
  )

  DOCUMENT_OBJECT_SECRET_FILE="$SECRET_ENV_DIR/document-objects.env"
  python3 - "$ENV_FILE" "$DOCUMENT_OBJECT_SECRET_FILE" <<'PY'
import re
import sys

source, destination = sys.argv[1:]
entries = {}
with open(source, encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if separator and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            entries[key] = value

access_key = entries.get("DOCUMENT_OBJECT_ACCESS_KEY")
secret_key = entries.get("DOCUMENT_OBJECT_SECRET_KEY")
session_token = entries.get("DOCUMENT_OBJECT_SESSION_TOKEN")
if any((access_key, secret_key, session_token)) and not (access_key and secret_key):
    raise SystemExit(
        "DOCUMENT_OBJECT_ACCESS_KEY and DOCUMENT_OBJECT_SECRET_KEY must both be set; "
        "legacy MINIO credentials are never copied into the frontend document Secret"
    )
with open(destination, "w", encoding="utf-8") as handle:
    if access_key:
        handle.write(f"DOCUMENT_OBJECT_ACCESS_KEY={access_key}\n")
    if secret_key:
        handle.write(f"DOCUMENT_OBJECT_SECRET_KEY={secret_key}\n")
    if session_token:
        handle.write(f"DOCUMENT_OBJECT_SESSION_TOKEN={session_token}\n")
PY
  if [[ -s "$DOCUMENT_OBJECT_SECRET_FILE" ]]; then
    apply_env_secret "$RELEASE-document-objects" "$DOCUMENT_OBJECT_SECRET_FILE"
    DOCUMENT_OBJECT_SECRET_PREPARED=true
    HELM_SECRET_ARGS+=(
      --set-string "documentObjectStorage.auth.existingSecret=$RELEASE-document-objects"
    )
  fi

  cleanup_secret_env_dir
  trap - EXIT
else
  echo "WARNING: $ENV_FILE not found -- skipping workload secret creation" >&2
fi

validate_document_object_secret_refs() {
  local render_cmd refs
  render_cmd=(helm template "$RELEASE" "$SCRIPT_DIR/helm/daedalus" -n "$NAMESPACE")
  if [[ -f "$VALUES_FILE" ]]; then
    render_cmd+=( -f "$VALUES_FILE" )
  fi
  if [[ -n "${HELM_SECRET_ARGS[*]-}" ]]; then
    render_cmd+=( "${HELM_SECRET_ARGS[@]}" )
  fi

  # Resolve the effective Secret references from the same rendered workloads
  # Helm will deploy. This covers both .env-managed credentials and operators
  # that intentionally provide an externally managed Secret in values.
  if ! refs="$("${render_cmd[@]}" | python3 -c '
import re
import sys

manifest = sys.stdin.read()
required_env = {"DOCUMENT_OBJECT_ACCESS_KEY", "DOCUMENT_OBJECT_SECRET_KEY"}
refs = set()

for lines in (document.splitlines() for document in re.split(r"^---\s*$", manifest, flags=re.MULTILINE)):
    document_lines = list(lines)
    for index, line in enumerate(document_lines):
        match = re.match(r"^(\s*)- name:\s*([A-Z0-9_]+)\s*$", line)
        if not match or match.group(2) not in required_env:
            continue
        indent = len(match.group(1))
        secret_name = None
        secret_key = None
        in_secret_ref = False
        for nested in document_lines[index + 1:]:
            if re.match(rf"^\s{{{indent}}}- name:", nested):
                break
            stripped = nested.strip()
            if stripped == "secretKeyRef:":
                in_secret_ref = True
                continue
            if not in_secret_ref:
                continue
            if stripped.startswith("name:") and secret_name is None:
                secret_name = stripped.split(":", 1)[1].strip().strip("\"\x27")
            elif stripped.startswith("key:") and secret_key is None:
                secret_key = stripped.split(":", 1)[1].strip().strip("\"\x27")
        if secret_name and secret_key:
            refs.add((match.group(2), secret_name, secret_key))

managed = set()
for document in re.split(r"^---\s*$", manifest, flags=re.MULTILINE):
    if not re.search(r"^kind:\s*Secret\s*$", document, flags=re.MULTILINE):
        continue
    name_match = re.search(
        r"^metadata:\s*$.*?^\s{2}name:\s*([^\s]+)\s*$",
        document,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not name_match:
        continue
    secret_name = name_match.group(1).strip("\"\x27")
    for _env_name, ref_name, key in refs:
        if ref_name != secret_name:
            continue
        key_match = re.search(
            rf"^\s{{2}}{re.escape(key)}:\s*(.+?)\s*$",
            document,
            flags=re.MULTILINE,
        )
        if key_match and key_match.group(1).strip() not in {"", "\"\"", "\x27\x27"}:
            managed.add((ref_name, key))

for env_name, secret_name, secret_key in sorted(refs):
    is_managed = "true" if (secret_name, secret_key) in managed else "false"
    print(f"{env_name}\t{secret_name}\t{secret_key}\t{is_managed}")
')"; then
    echo "ERROR: Helm could not render the document-object startup configuration." >&2
    exit 1
  fi

  [[ -z "$refs" ]] && return

  local env_name secret_name secret_key chart_managed secret_json
  while IFS=$'\t' read -r env_name secret_name secret_key chart_managed; do
    [[ -z "$env_name" ]] && continue
    if [[ "$chart_managed" == true ]]; then
      continue
    fi
    if [[ "$DOCUMENT_OBJECT_SECRET_PREPARED" == true && "$secret_name" == "$RELEASE-document-objects" ]]; then
      continue
    fi
    if ! secret_json="$(kubectl -n "$NAMESPACE" get secret "$secret_name" -o json 2>/dev/null)" || \
      ! python3 -c '
import json
import sys

key = sys.argv[1]
payload = json.load(sys.stdin)
raise SystemExit(0 if payload.get("data", {}).get(key) else 1)
' "$secret_key" <<< "$secret_json"; then
      echo "ERROR: documentObjectStorage is enabled, but Secret '$secret_name'" >&2
      echo "       is missing a non-empty '$secret_key' key." >&2
      echo "       Set DOCUMENT_OBJECT_ACCESS_KEY and DOCUMENT_OBJECT_SECRET_KEY" >&2
      echo "       in $ENV_FILE, or provision the configured external Secret." >&2
      exit 1
    fi
  done <<< "$refs"
}

log "Validating document-object startup credentials"
validate_document_object_secret_refs

# -------------------------------------------------------------------
# Pre-flight MCP reachability checks
# -------------------------------------------------------------------
if [[ "$SKIP_MCP_PREFLIGHT" == false ]]; then
  if [[ -f "$BACKEND_CONFIG" ]]; then
    log "Checking MCP server reachability"
    run python3 "$SCRIPT_DIR/scripts/check_mcp_servers.py" \
      --config "$BACKEND_CONFIG" \
      --env-file "$ENV_FILE" \
      --kubernetes-namespace "$NAMESPACE" \
      --kubernetes-secret "$RELEASE-backend-env" \
      --kubectl-image "$MCP_PREFLIGHT_KUBECTL_IMAGE" \
      --timeout "$MCP_PREFLIGHT_TIMEOUT"
  else
    echo "WARNING: $BACKEND_CONFIG not found -- skipping MCP pre-flight" >&2
  fi
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
  --wait
  --atomic
  --cleanup-on-fail
)

if [[ -f "$VALUES_FILE" ]]; then
  HELM_CMD+=( -f "$VALUES_FILE" )
fi

if [[ -f "$BACKEND_CONFIG" ]]; then
  HELM_CMD+=( --set-file backend.default.config.data="$BACKEND_CONFIG" )
fi

# Force pod recreation by changing the deploy-timestamp annotation
HELM_CMD+=( --set forceRedeploy="$(date +%s)" )
if [[ "$DRY_RUN" == false ]]; then
  HELM_CMD+=( "${IMAGE_DIGEST_ARGS[@]}" )
fi
if [[ -n "${HELM_SECRET_ARGS[*]-}" ]]; then
  HELM_CMD+=( "${HELM_SECRET_ARGS[@]}" )
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run]" "${HELM_CMD[@]}"
  log "Dry run complete"
  exit 0
else
  "${HELM_CMD[@]}"
fi

log "Verifying every deployment in the release"
kubectl -n "$NAMESPACE" get deployment \
  -l "app.kubernetes.io/instance=$RELEASE" \
  -o name | while IFS= read -r deployment; do
    [[ -z "$deployment" ]] && continue
    kubectl -n "$NAMESPACE" rollout status "$deployment" --timeout=5m
  done

if [[ -n "${BACKEND_IMMUTABLE_REF:-}" && -n "${FRONTEND_IMMUTABLE_REF:-}" && -n "${REDIS_IMMUTABLE_REF:-}" ]]; then
  GIT_COMMIT="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
  HELM_REVISION="$(helm status "$RELEASE" -n "$NAMESPACE" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
  export GIT_COMMIT HELM_REVISION BACKEND_IMMUTABLE_REF FRONTEND_IMMUTABLE_REF REDIS_IMMUTABLE_REF NAMESPACE RELEASE
  python3 - "$RELEASE_EVIDENCE_FILE" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

evidence = {
    "commit": os.environ["GIT_COMMIT"],
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "helm": {
        "namespace": os.environ["NAMESPACE"],
        "release": os.environ["RELEASE"],
        "revision": int(os.environ["HELM_REVISION"]),
    },
    "images": {
        "backend": os.environ["BACKEND_IMMUTABLE_REF"],
        "frontend": os.environ["FRONTEND_IMMUTABLE_REF"],
        "redis": os.environ["REDIS_IMMUTABLE_REF"],
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(evidence, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
  log "Release evidence written to $RELEASE_EVIDENCE_FILE"
fi

log "Following backend logs (Ctrl+C to stop)"
exec kubectl -n "$NAMESPACE" logs -f \
  -l "app.kubernetes.io/component=backend-default,app.kubernetes.io/instance=$RELEASE" \
  --all-containers --prefix --tail=100 --max-log-requests=10
