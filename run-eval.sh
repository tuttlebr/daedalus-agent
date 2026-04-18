#!/usr/bin/env bash
# Kick off the Daedalus evaluation harness via Docker Compose.
#
# Only Docker is required on the host. The evals service attaches to
# daedalus-network and reaches `backend:8000` by DNS. Override
# DAEDALUS_BACKEND_URL to hit a remote backend instead.
#
# Examples:
#   ./run-eval.sh                                   # full suite
#   ./run-eval.sh --dataset routing                 # one dataset
#   ./run-eval.sh --case ops-001                    # one case
#   DAEDALUS_BACKEND_URL=http://10.0.2.61:8000 ./run-eval.sh
#
# First run auto-builds the image. To force a rebuild (e.g. after
# editing requirements.txt): docker compose build evals
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

exec docker compose run --rm evals "$@"
