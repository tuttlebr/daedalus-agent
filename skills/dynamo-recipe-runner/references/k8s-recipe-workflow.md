# Existing recipe deployment contract

Read the selected revision's recipe README and manifests before choosing an
execution sequence. Commands require an actual operator checkout/cluster tool;
production `agent_skills_tool` only loads text.

## Selection and preflight

Match model, backend, aggregation mode, GPU SKU/count and architecture. If no
exact recipe fits, explain the mismatch before adapting a different target.
Inspect replica counts, parallelism, model/tokenizer paths, cache volume size,
access mode, storage class, image and backend versions, namespace and Secret
reference names. Text scanner hints do not prove schedulability or model fit.

Check the live CRD/operator, node labels/taints/allocatable resources, storage
provisioner and existing cache/PVC state. Preserve persistent data and the
controller owning replicas. Do not change architecture or scale silently.

## Apply and verification

Prepare the exact minimal source diff and use the owning repository's deploy
wrapper or selected recipe's documented commands within existing authorization.
Create missing resources only when included in that scope. Provision model
credentials through the operator's Secret path; never pass token values in
command arguments or tool output.

Use actual manifest names for cache jobs and DGD/frontend resources. Await the
same job while it runs with bounded polls; do not restart a download because
one observation timed out. Confirm completion, bound/mounted cache, reconciled
DGD, ready workers/frontend and the requested model.

Exercise a bounded completion and inspect its content and error state. Do not
launch `perf.yaml` as an incidental smoke test. If a port-forward is needed in
an operator environment, track and stop only that task's process and note that
it does not prove the normal client network path.

Load `dynamo-troubleshoot` for failures, `dynamo-router-starter` for router
settings/smoke mechanics, and `dynamo-interconnect-check` for disaggregated
fabric evidence. Report source validation, deployment and data-plane proof
separately.
