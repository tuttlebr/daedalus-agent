# Dynamo failure decision tree

Use bounded reads from the connected Kubernetes tool or an operator environment.
Keep context, namespace, DGD, container and as-of time attached to evidence.

| Layer               | Strong evidence                                                  | Next read or proposed repair                                               |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Cluster/namespace   | unavailable API, node conditions, missing namespace              | confirm context/access and resource existence                              |
| Model access        | started cache job with 401/403/gated-model error                 | verify Secret reference/key names and operator-side access without values  |
| Cache/PVC           | pending claim, mount error, failed download                      | inspect provisioner, binding mode, capacity, locality and job logs         |
| Image/runtime       | pull error, wrong architecture, missing backend binary           | inspect exact image, supported platform and pull-Secret reference          |
| GPU scheduling      | scheduler rejection, allocatable mismatch                        | validate model parallelism and per-node placement before changing requests |
| Operator/DGD        | reconciliation error, absent children, stale observed generation | inspect installed CRD/controller and owner chain                           |
| Scaling             | unexpected replicas or repeated reversions                       | identify DGD scaling adapter/other owner before changing counts            |
| Registration/router | no registered workers, empty model list, request errors          | compare worker/frontend discovery and requested mode                       |
| Network/API         | absent endpoints, drops, response schema/model failure           | trace caller, Service, EndpointSlices, policy and application logs         |
| Benchmark client    | serving works but load job fails                                 | compare URL/model/tokenizer/workload and execution state                   |

An unstarted container cannot prove a runtime or connectivity failure. Correlate
old warnings with current conditions. Do not recreate populated PVCs, inspect
Secret payloads, lower GPU count below model fit, or switch to approximate KV
without evidence that this matches the intended worker event contract.

A diagnosis can end with a concrete proposed patch. Execute repairs only when
requested, then recheck the changed layer and user-visible behavior. Use
`dynamo-interconnect-check` when running peers exhibit a transport symptom;
configuration presence alone cannot validate the fabric.
