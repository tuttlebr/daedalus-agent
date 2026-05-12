#!/usr/bin/env bash
# Kick off the Daedalus evaluation harness against the Kubernetes backend.
#
# By default this assumes the Daedalus backend is running in Kubernetes and
# creates a local kubectl port-forward to the backend Service. The evals
# container reaches that forwarded port through host.docker.internal.
#
# Examples:
#   ./run-eval.sh                                   # default routing + factuality suite
#   ./run-eval.sh --dataset routing                 # one dataset
#   ./run-eval.sh --dataset workflows               # workflow audit suite
#   ./run-eval.sh --case ops-001                    # one case
#   DAEDALUS_KUBE_NAMESPACE=daedalus ./run-eval.sh
#   DAEDALUS_KUBE_CONTEXT=my-context ./run-eval.sh
#   DAEDALUS_BACKEND_URL=https://daedalus.example.com ./run-eval.sh
#
# First run auto-builds the image. To force a rebuild (e.g. after
# editing requirements.txt): docker compose build evals
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PF_PID=""
PF_LOG=""

cleanup() {
  if [[ -n "$PF_PID" ]] && kill -0 "$PF_PID" >/dev/null 2>&1; then
    kill "$PF_PID" >/dev/null 2>&1 || true
    wait "$PF_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$PF_LOG" ]]; then
    rm -f "$PF_LOG"
  fi
}
trap cleanup EXIT INT TERM

VALIDATE_ONLY=false
for arg in "$@"; do
  if [[ "$arg" == "--validate-only" ]]; then
    VALIDATE_ONLY=true
    break
  fi
done

wait_for_backend() {
  local url="$1"
  local deadline=$((SECONDS + ${DAEDALUS_EVAL_PORT_FORWARD_TIMEOUT:-30}))

  while (( SECONDS < deadline )); do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "$url/docs" >/dev/null 2>&1; then
        return 0
      fi
    else
      if python3 - "$url/docs" >/dev/null 2>&1 <<'PY'
import sys
from urllib.request import urlopen

urlopen(sys.argv[1], timeout=2).read(1)
PY
      then
        return 0
      fi
    fi

    if [[ -n "$PF_PID" ]] && ! kill -0 "$PF_PID" >/dev/null 2>&1; then
      echo "kubectl port-forward exited before the backend became reachable." >&2
      [[ -n "$PF_LOG" ]] && cat "$PF_LOG" >&2
      return 1
    fi
    sleep 1
  done

  echo "Timed out waiting for backend at $url" >&2
  [[ -n "$PF_LOG" ]] && cat "$PF_LOG" >&2
  return 1
}

if [[ -z "${DAEDALUS_BACKEND_URL:-}" && "$VALIDATE_ONLY" != "true" ]]; then
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "DAEDALUS_BACKEND_URL is unset and kubectl is not available." >&2
    echo "Set DAEDALUS_BACKEND_URL to a reachable backend URL, or install kubectl." >&2
    exit 2
  fi

  KUBE_NAMESPACE="${DAEDALUS_KUBE_NAMESPACE:-${KUBE_NAMESPACE:-daedalus}}"
  KUBE_SERVICE="${DAEDALUS_KUBE_BACKEND_SERVICE:-daedalus-backend-default}"
  KUBE_SERVICE_PORT="${DAEDALUS_KUBE_BACKEND_PORT:-8000}"
  LOCAL_PORT="${DAEDALUS_EVAL_LOCAL_PORT:-18000}"
  PORT_FORWARD_ADDRESS="${DAEDALUS_EVAL_PORT_FORWARD_ADDRESS:-0.0.0.0}"
  KUBECTL_ARGS=()
  if [[ -n "${DAEDALUS_KUBE_CONTEXT:-}" ]]; then
    KUBECTL_ARGS+=(--context "$DAEDALUS_KUBE_CONTEXT")
  fi

  PF_LOG="$(mktemp -t daedalus-eval-port-forward.XXXXXX.log)"
  echo "Port-forwarding Kubernetes backend svc/$KUBE_SERVICE in namespace $KUBE_NAMESPACE on $PORT_FORWARD_ADDRESS:$LOCAL_PORT..." >&2
  kubectl "${KUBECTL_ARGS[@]}" -n "$KUBE_NAMESPACE" port-forward \
    --address "$PORT_FORWARD_ADDRESS" \
    "svc/$KUBE_SERVICE" "$LOCAL_PORT:$KUBE_SERVICE_PORT" >"$PF_LOG" 2>&1 &
  PF_PID=$!

  wait_for_backend "http://127.0.0.1:$LOCAL_PORT"
  export DAEDALUS_BACKEND_URL="http://host.docker.internal:$LOCAL_PORT"
  echo "Running evals against Kubernetes backend via $DAEDALUS_BACKEND_URL" >&2
fi

docker compose run --rm evals "$@"
