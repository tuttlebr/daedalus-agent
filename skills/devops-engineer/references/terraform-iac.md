# Terraform and infrastructure as code

Use the existing root module, backend, workspace, providers and version lock.
Do not introduce a cloud or provision infrastructure for an unrelated task.

- Resolve account/project/region and state ownership without reading credentials
  into the conversation. State and saved plans can contain secrets.
- Inspect module inputs, dependencies, resource addresses, lifecycle rules,
  import/move history, and deletion protection before changing resources.
- Run the repository's formatting/validation path. Generate a plan for the exact
  intended variables/state; inspect additions, changes, replacements and deletes.
- Treat unexpected replacement or broad drift as a diagnosis task before apply.
  Preserve persistent data, network access and resource identity.
- Apply only the reviewed scope within existing authorization and runtime gates.
  Do not replan against a moving environment and silently apply a different diff.
- Verify provider state and the affected service. A completed apply is not
  proof of application health.

For saved plans or state files, report safe summaries and checksums rather than
publishing their potentially secret contents. Local sandbox execution requires
staged source and discovered commands; it does not inherit cloud credentials.
