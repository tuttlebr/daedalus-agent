# Release and artifact lifecycle

Inspect the release workflow and documented commands before preparing a release.
For Daedalus, keep source tests, runtime image checks, immutable image publication,
deploy preflights, Helm rollout and live proof distinct.

1. Record the source revision and focused diff; preserve unrelated work.
2. Build using the pinned dependencies and actual build contexts, including
   skills. Verify supported architectures and registration/import contracts.
3. Preserve existing provenance, signatures, scans and immutable references.
   Promote the same verified digest rather than rebuilding under a matching tag.
4. Publish only when requested. Record the resulting registry reference and
   verify it exists; do not equate a local tag with a published image.
5. Preview deployment changes and run the owning wrapper's checks before an
   authorized rollout. Do not skip a preflight to hide a dependency failure.
6. Exercise the user-visible path after deployment, including protected tools
   and durable storage when changed. Keep rollback/data compatibility explicit.

For feature flags, dependency updates, release notes, parallel build jobs or
multi-service orchestration, add only the machinery needed by this release.
Dependency/security changes need version-specific upstream evidence and focused
compatibility checks. Retain artifacts needed to reproduce a result.

Commit only the task's files when a commit is requested; preserve actual
newlines in release descriptions. A release request does not imply sending
announcements to others.
