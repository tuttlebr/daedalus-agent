# Container build contracts

Inspect the actual Dockerfile, build contexts, lockfiles, runtime user, entrypoint,
health check, and deployment architecture before changing packaging.

For Daedalus, `builder/Dockerfile` installs the registered builder packages and
copies the named `skills` build context into `/skills`. Preserve that context in
Compose and release builds. Source validation alone cannot detect missing image
files, package metadata, entrypoints, or architecture-incompatible wheels.

- Use existing multi-stage boundaries and dependency locks. Keep build tools out
  of the final image where the runtime does not need them.
- Verify the chosen user exists, writable paths have correct ownership, and
  health-check executables exist in the final stage.
- Check amd64/arm64 artifacts and required native libraries for each supported
  platform; do not assume a tag implies multi-architecture support.
- Keep credentials out of build arguments, layers and logs. Use the existing
  secret injection mechanism, preserving names/references.
- Match `.dockerignore` to actual COPY sources; exclude caches and local secrets
  while retaining skill resources and runtime files.

Validate syntax plus a focused final-image import/startup contract when packaging
changes. Record the immutable image digest separately from local build success.
Do not start a new deployment as part of an image-only request.
