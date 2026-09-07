# CI workflow changes

Read `.github/workflows`, `Makefile`, pre-commit configuration, and dependency
locks together. Preserve parity between local checks and required CI jobs.

1. Identify triggers, permissions, job dependencies, concurrency, caches,
   artifacts and publication conditions for the requested change.
2. Keep pull-request validation separate from trusted release publication.
   Never execute untrusted PR code in a privileged secret-bearing job.
3. Pin external actions according to repository policy; validate versions and
   inputs against the action's current documentation rather than copying a
   stale template. Use the least token permissions each job needs.
4. Include lockfile/platform inputs in cache keys. A cache hit is not evidence
   the current tree passed tests. Preserve artifacts needed by downstream jobs.
5. Preserve Daedalus's skills build context and runtime-lock/image validation.
   Multi-platform publication needs each architecture validated.
6. Validate YAML and changed commands locally when execution is available;
   report external CI state only after observing that run/revision.

Use GitHub's [secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use)
for workflow trust boundaries. Configured Daedalus GitHub MCP operations inspect
source; they cannot create a workflow run, commit, or PR by themselves.
