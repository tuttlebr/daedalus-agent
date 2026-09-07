# Helm chart changes

Inspect Chart.yaml, values/schema, templates/helpers, dependencies/locks,
release values and rendered resources together. Preserve stable selectors,
resource names, ownership and immutable fields.

For Daedalus, `helm/daedalus` and the documented deploy wrapper own the release.
Check backend config mounts, optional skills volumes, external integrations,
Secret references, TLS, policies and persistent volumes for the changed path.
Do not replace wrapper preflights with an unguarded generic upgrade.

1. Change the owning template/value/schema and relevant docs as one contract.
2. Lint and render representative enabled/disabled configurations using actual
   chart dependencies. Keep optional blocks valid when absent.
3. Inspect the resource diff and migration/rollback effects. Rendered manifests
   can contain secrets; use safe output paths/redaction and avoid printing them.
4. Verify hooks, Jobs and cleanup policies cannot remove persistent data or
   rerun an irreversible migration unexpectedly.
5. Apply only the requested release scope and verify workload plus application
   behavior. Helm release success alone is insufficient.

Use the repository's installed Helm version and
[chart documentation](https://helm.sh/docs/topics/charts/) for template/schema
behavior. Publishing a chart, upgrading a dependency, and applying a release
are distinct stages; run only those authorized by the task.
