#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Restore only the exact CPU properties captured by this benchmark's isolation.
set -euo pipefail
cd "$(dirname "$0")"
: "${ISOLATION_STATE:?set ISOLATION_STATE to the task recovery JSON path}"
python3 ./cpu_isolation.py restore "$ISOLATION_STATE"
echo 'Recorded CPU properties restored. Use stop.sh to stop the recorded topology.'
