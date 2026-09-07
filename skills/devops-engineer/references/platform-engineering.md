# Internal platform changes

Identify the concrete developer/operator task to simplify before adding a
platform layer. Prefer the application's existing commands, templates,
authentication and ownership model.

For Daedalus, inspect the chat backend, stream worker, frontend, autonomous
worker, memory, retrieval and external MCP boundaries relevant to the task.
Preserve trusted per-user identity, private-source isolation, runtime approval,
and non-interactive autonomy. A new template must not bypass the release path.

For a requested self-service API, catalog or CLI:

- Define inputs, owner, authorization, generated resources, lifecycle and errors.
- Reuse declarative source templates and stable interfaces. Make defaults useful
  without hiding irreversible operations or persistent data costs.
- Keep per-user operations separate from shared infrastructure administration.
- Make retries/idempotency and partial-failure recovery observable.
- Validate a representative create/read/update lifecycle using isolated fixtures
  or an explicitly authorized target; measure the actual reduction in toil.

Do not install Backstage, Crossplane, a cloud provider or another GitOps
controller merely because they appear in common platform examples. For their
explicit adoption, consult current official schemas and integrate the existing
identity, storage, delivery and telemetry contracts.
