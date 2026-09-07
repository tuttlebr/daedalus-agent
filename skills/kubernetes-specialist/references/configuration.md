# Configuration and Secret wiring

Trace the selected source/overlay, rendered ConfigMap or Secret reference,
pod mount/environment source, process reload behavior, and effective runtime
configuration. Environment injection and mounted-file updates have different
reload semantics; a changed value file does not prove the process reloaded.

For Daedalus, the main backend YAML is canonical and the Responses overlay
inherits it. Helm and Compose supply different mounts. Keep frontend/backend
trusted identity tokens, per-user OAuth, external MCP tokens, retrieval
credentials and autonomous worker identity aligned with their owners.

Inspect names, key references and safe metadata, never Secret payloads or whole
credential-bearing configuration output. Do not decode Secrets into chat,
copy redacted placeholders into writes, or pass credentials on command lines.
Preserve the existing Secret lifecycle/provider rather than adding a new one.

For a rotation or immutable resource change, identify every consumer, rollout
trigger, overlap period and recovery path. Validate an authenticated read from
the actual consumer after an authorized update. Missing access is a distinct
boundary from invalid content or a broken application.
