#!/usr/bin/env bash
# Manually trigger the autonomous agent CronJob by creating an ad-hoc Job.
# Usage: ./trigger-autonomous-agent.sh [--dry-run]

set -euo pipefail

NAMESPACE="daedalus"
CRONJOB_NAME="daedalus-autonomous-agent"
JOB_NAME="${CRONJOB_NAME}-manual-$(date +%s)"

if [[ "${1:-}" == "--dry-run" ]]; then
    echo "Would create job: ${JOB_NAME} from cronjob/${CRONJOB_NAME} in namespace ${NAMESPACE}"
    kubectl create job "${JOB_NAME}" \
        --from="cronjob/${CRONJOB_NAME}" \
        --namespace="${NAMESPACE}" \
        --dry-run=client -o yaml
    exit 0
fi

echo "Creating job '${JOB_NAME}' from cronjob/${CRONJOB_NAME}..."
kubectl create job "${JOB_NAME}" \
    --from="cronjob/${CRONJOB_NAME}" \
    --namespace="${NAMESPACE}"

echo ""
echo "Job created. Watching status..."
echo ""

# Wait for the pod to appear and be running (up to 120s)
POD=""
for i in $(seq 1 60); do
    POD=$(kubectl get pods -n "${NAMESPACE}" -l "job-name=${JOB_NAME}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [[ -n "${POD}" ]]; then
        PHASE=$(kubectl get pod -n "${NAMESPACE}" "${POD}" \
            -o jsonpath='{.status.phase}' 2>/dev/null || true)
        if [[ "${PHASE}" == "Running" || "${PHASE}" == "Succeeded" || "${PHASE}" == "Failed" ]]; then
            break
        fi
    fi
    sleep 2
done

if [[ -z "${POD:-}" ]]; then
    echo "Warning: pod not found after 120s. Check manually:"
    echo "  kubectl get pods -n ${NAMESPACE} -l job-name=${JOB_NAME}"
    exit 1
fi

echo "Pod: ${POD} (${PHASE})"
echo "Streaming logs (Ctrl+C to detach — job keeps running)..."
echo "---"
kubectl logs -n "${NAMESPACE}" "${POD}" -f
