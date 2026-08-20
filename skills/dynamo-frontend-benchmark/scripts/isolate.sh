#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Reserve cores 0-3 for the frontend by moving other userspace to cores 4-23
# (systemd cgroup cpuset). Reversible (--runtime), no reboot.
#
# Run from a pre-authorized privileged shell:
#   bash bench/isolate.sh           # LITE (default): confine daemons only
#   bash bench/isolate.sh --full    # also confine user.slice (max isolation)
#   bash bench/unisolate.sh         # revert (or reboot)
#
# LITE (recommended): confine `system.slice` + `init.scope` (the security
# daemons / system services that were the dominant noise) to 4-23, and LEAVE
# `user.slice` on all cores. The frontend then runs with plain `taskset -c 0-3`
# After this one-time privileged operation, ordinary benchmark scripts stay unprivileged.
# Residual: your own user.slice procs (IDE/node/other sessions) may still touch
# 0-3, but they're small and steady vs. the scanners.
#
# FULL (--full): also confine `user.slice` to 4-23, fully clearing 0-3 of
# userspace. The frontend then can't use taskset (its slice forbids 0-3), so it
# must launch via `ISOLATE=1 ./start.sh` from the same approved privileged
# shell. Use this only when maximum isolation is necessary.
set -uo pipefail
HOST_CORES="${HOST_CORES:-4-23}"
FULL=0; [[ "${1:-}" == "--full" ]] && FULL=1
[[ $EUID -eq 0 ]] || { echo "ERROR: a pre-authorized privileged shell is required."; exit 1; }

UNITS=(system.slice init.scope)
[[ $FULL -eq 1 ]] && UNITS+=(user.slice)

echo "[isolate] mode=$([[ $FULL -eq 1 ]] && echo FULL || echo LITE); confining ${UNITS[*]} to cores ${HOST_CORES} ..."
for unit in "${UNITS[@]}"; do
    systemctl set-property --runtime "$unit" AllowedCPUs="${HOST_CORES}" \
        && echo "  $unit -> ${HOST_CORES}" || echo "  WARN: failed to set $unit"
done

echo "[isolate] steering IRQs off 0-3 (stop irqbalance so it doesn't undo this) ..."
systemctl stop irqbalance 2>/dev/null || true
moved=0
for f in /proc/irq/*/smp_affinity_list; do
    echo "${HOST_CORES}" > "$f" 2>/dev/null && moved=$((moved+1))
done
echo "  steered ${moved} IRQ(s) (some are pinned/unmovable — expected)."

echo "[isolate] verify — effective cpus (want ${HOST_CORES}):"
for unit in "${UNITS[@]}"; do
    [[ "$unit" == "init.scope" ]] && path="init.scope" || path="$unit"
    echo "  $unit: $(cat /sys/fs/cgroup/$path/cpuset.cpus.effective 2>/dev/null || echo '?')"
done

if [[ $FULL -eq 1 ]]; then
    echo "[isolate] FULL: launch with ISOLATE=1 ./start.sh from the approved privileged shell."
    echo "          stop the isolated frontend with: systemctl stop bench.slice"
else
    echo "[isolate] LITE: run ./start.sh as usual; taskset puts the frontend on 0-3."
fi
