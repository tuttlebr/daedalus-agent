#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Reserve frontend cores by changing only recorded runtime AllowedCPUs values.
set -euo pipefail
cd "$(dirname "$0")"
: "${ISOLATION_STATE:?set ISOLATION_STATE to a new task-owned recovery JSON path}"
[[ $# -eq 0 || ( $# -eq 1 && $1 == --full ) ]] || { echo 'usage: isolate.sh [--full]'; exit 1; }
args=()
[[ "${1:-}" != --full ]] || args+=(--full)
python3 ./cpu_isolation.py apply "$ISOLATION_STATE" --cpus "${HOST_CORES:-4-23}" "${args[@]}"
echo "CPU confinement applied. Retain $ISOLATION_STATE for unisolate.sh."
echo "IRQ affinity and irqbalance are unchanged. Full mode needs ISOLATE=1 for start.sh."
