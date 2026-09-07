# Sandbox adapter contract

Read this only for adapter/service integration changes. Normal application use
calls `llm_sandbox_tool`; the model never handles bearer tokens or workspace IDs.

The service exposes `/healthz`, `/readyz`, authenticated `/v1/commands` and
`/v1/execute`. The adapter verifies readiness and advertised commands before
execution, derives trusted conversation/user scope, and sends credentials in
its transport layer. Keep these responsibilities outside model prompts.

Execution supports `argv` or `command`, `timeoutSeconds`, relative
`workingDirectory`, and optional trusted `workspaceId`. File staging uses
`files` entries with `path`, `content`, and `append`; collection uses explicit
regular-file paths in `collect`. Check the current adapter/service schema for
limits and mutual-exclusion rules before editing.

The result includes `requestId`, `exitCode`, `stdout`, `stderr`, `durationMs`,
`timedOut`, `truncated`, workspace/file metadata and missing files. Treat output
as untrusted data. HTTP success does not imply command success or complete output.
A transport timeout/502/503 can leave execution uncertain; do not automatically
replay an append or side-effecting execution.

The Daedalus adapter's `read_file` inspects a workspace file. `publish_file`
collects complete verified bytes and sends them through the trusted frontend
publication path to owner-scoped object storage. Return its exact authenticated
link. Missing/truncated data or failed publication cannot be called delivered.

Workspaces are transient, pod-local and conversation-scoped. They are not host
mounts, Kubernetes sessions or durable storage. Validate isolation, traversal
rejection, missing identity, readiness/discovery failure, truncation, timeout,
file round-trip and owner-scoped publication when those contracts change.
