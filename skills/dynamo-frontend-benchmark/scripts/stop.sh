#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Stop the benchmark topology (frontend + workers). Leaves etcd/nats running.
# Waits until processes are gone, :8000 is free, and worker instances have
# drained from etcd, so a subsequent ./start.sh sees a clean slate.
set -uo pipefail
cd "$(dirname "$0")"
source ./env.sh

exec 9>"$LOG_DIR/topology.lock"
flock -n 9 || { echo "ERROR: another topology operation is active"; exit 1; }
STOP_FAILED=0
for name in frontend workers; do
    record="$LOG_DIR/$name.process.json"
    if [[ -f "$record" ]]; then
        if python3 ./process_control.py stop "$record"; then
            rm -f "$LOG_DIR/$name.pid"
        else
            STOP_FAILED=1
        fi
    elif [[ -f "$LOG_DIR/$name.pid" ]]; then
        echo "ERROR: legacy PID file has no birth record; inspect it before cleanup."
        STOP_FAILED=1
    fi
done
[[ "$STOP_FAILED" == 0 ]] || exit 1

# Wait for :8000 to free.
for i in $(seq 1 15); do ss -ltn 2>/dev/null | grep -q ":${HTTP_PORT}\b" || break; sleep 1; done
ss -ltn 2>/dev/null | grep -q ":${HTTP_PORT}\b" && { echo "[stop] ERROR: :${HTTP_PORT} still held."; exit 1; } || echo "[stop] :${HTTP_PORT} free."

# Wait for worker instances to drain from etcd (lease expiry).
for i in $(seq 1 20); do
    n="$(count_workers)" || { echo "[stop] ERROR: could not query worker registrations."; exit 1; }
    [[ "$n" -eq 0 ]] && break
    sleep 1
done
n="$(count_workers)" || { echo "[stop] ERROR: could not verify worker registrations."; exit 1; }
[[ "$n" -eq 0 ]] && echo "[stop] etcd worker instances drained." || { echo "[stop] ERROR: $n worker instance(s) still in etcd."; exit 1; }
echo "[stop] done."
