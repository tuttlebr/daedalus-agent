# GitOps ownership and drift

Determine whether the affected resource is owned by Flux, Argo CD, Helm, an
operator or a combination. Inspect the configured source repository/revision,
path, rendered values, reconciliation status and live resource generation.

A source commit is not an applied change. A Ready reconciler is not proof that
the intended revision is selected or every data-plane request works. Compare
reported revision/digest, effective spec/config and the real endpoint result.

Change the authoritative source. An authorized emergency live patch must be
accounted for in source or intentionally reverted; do not leave controllers
fighting each other. Reconciliation suspension, pruning, rollback and bootstrap
are mutations, not implicit parts of a drift audit.

Preserve dependency ordering, health checks, namespace scope, Secret-provider
references and persistent-resource retention. Do not dump bootstrap passwords,
replace credential systems, or install a second controller to resolve a
configuration error.

Use current installed Flux/Argo CD schemas for detailed resources and automation.
Keep image automation/promotion separate from image publication and rollout.
Verify the selected revision, reconciler outcome and affected service after a
requested change.
