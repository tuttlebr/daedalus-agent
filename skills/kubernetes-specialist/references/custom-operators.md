# Custom controllers and CRDs

Inspect the installed CRD version/schema, conversion behavior, controller image,
watch namespaces, RBAC, reconciliation conditions and owner references.
Find the controller of the desired field before changing its generated child.

For Dynamo, follow DGD and scaling-adapter ownership through rendered worker
resources. A manual replica patch can be overwritten; change the responsible
custom resource or documented configuration.

When authoring an operator, scope the API and reconcile contract first:
validation/defaults, idempotent reconciliation, observedGeneration/status,
finalizers, resource ownership, retries and deletion/data-retention behavior.
Avoid broad RBAC and do not remove another controller's finalizer to force
completion. Inspect its failure condition first.

Validate schema acceptance/rejection, repeated reconciliation, partial failures,
upgrade compatibility and intended cleanup in an isolated fixture/environment.
Report installed schema/controller compatibility separately from local tests.
Use current upstream controller/CRD documentation for code examples rather
than copying a generic controller into this application.
