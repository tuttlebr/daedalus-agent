# Daedalus review entry points and checks

Paths below are relative to the repository root. `scripts/check_maintenance_skills.py`
fails when a path or `make` target named here disappears, but it cannot detect
outdated descriptions: verify them against current files. Follow current
`AGENTS.md` and CI when versions, ownership or commands change; this guide
identifies where to investigate.

## Architecture and contracts

Start with `docs/architecture.md` and `CONTRIBUTING.md`. Consult
`docs/rust-migration.md` for ownership and compatibility, and
`docs/long-running-workflows.md` for measurement procedures and recovery boundaries.
`docs/research-workflows.md` describes recoverable article output and evaluation.
Keep review evidence outside these current-behavior guides.

| Surface                    | Entry points and contract questions                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser                    | `frontend/hooks/useAsyncChat.ts`, `frontend/hooks/useWebSocket.ts`, `frontend/state/`, `frontend/components/chat/`, `frontend/utils/app/streamingBuffer.ts`, `frontend/utils/app/conversation.ts`: optimistic state, render/update batching, completion, reconnect, deduplication and selected-conversation isolation.                      |
| Admission and transport    | `frontend/pages/api/chat/async.ts`, `frontend/server/jobSubmission.ts`, `frontend/server/chat/streamQueue.ts`, `frontend/server/chat/jobState.ts`, `frontend/server/chat/userJobGuard.ts`, `frontend/server/chat/conversationJobGuard.ts`, `frontend/ws-server.ts`: admission limits, owner checks, queue latency and cancellation.         |
| Stream processing          | `frontend/stream-worker.ts`, `frontend/server/chat/streamWorker.ts`, `frontend/server/chat/streamReader.ts`, `frontend/server/chat/streamState.ts`, `frontend/server/chat/finalization.ts`, `frontend/server/session/`: lease ownership, SSE parsing, persistence, event publication and recovery.                                          |
| Rust runtime               | `builder/runtime/src/main.rs`, `builder/runtime/src/agent.rs`, `builder/runtime/src/preparation.rs`, `builder/runtime/src/provider.rs`, `builder/runtime/src/control.rs`, `builder/runtime/src/authorization.rs`, `builder/runtime/src/mcp.rs`: route ownership, model/tool ordering, deadlines, steering, retries and approval boundaries. |
| Python and autonomous work | `builder/daedalus_runtime/service.py`, `builder/daedalus_runtime/tools.py`, individual tool packages and `builder/autonomous_agent/`: remaining leaf-tool ownership, explicit factory registration, adapters, background lifecycle and fallback preparation.                                                                                |
| Shared contracts           | `protocol/`, `scripts/generate_protocol_types.py`, `builder/runtime/src/protocol.rs`, generated frontend/Python types: schema source, generated outputs, runtime validation and persisted compatibility.                                                                                                                                    |
| Configuration and delivery | `backend/local-chat-config.yaml`, `backend/tool-calling-config.yaml`, `builder/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yaml`, `helm/daedalus/`, `scripts/`: actual enabled entry points, packaging, service wiring and limits.                                                                                                  |
| Runtime skills             | `skills/AGENTS.md`, `builder/agent_skills/`, `builder/runtime/src/agent_skills.rs`: loader/dispatcher contracts, resources and links. Apply the local instructions if editing these.                                                                                                                                                        |

Important review boundaries to confirm in source:

- Rust owns the agent loop and many public/native-tool APIs; Python still owns
  selected leaf tools, image APIs, autonomous work and supported fallback paths.
  Similar Rust/Python code may serve differential tests or compatibility.
- Existing `nat_helpers`, `natBaseUrl` and Redis key names can be compatibility
  identifiers. Their names alone do not prove a retired dependency is active or
  a path is dead. Follow actual registration and consumers.
- Redis job durability does not checkpoint the in-memory backend agent. Reclaim
  must not replay an already-started backend request and duplicate remote actions.
  Autonomous processing also persists a dispatch phase: only proven undispatched
  claims may be retried; legacy claims without that evidence are interrupted.
- Conversation finalization writes must atomically verify the current finalizer
  lock token, so an expired owner cannot overwrite a newer turn.
- Streaming recovery, authenticated ownership, approval binding and cancellation
  must survive latency improvements. Inspect normal and recovery transports.
- Generated types do not supply runtime validation or authorization. Update the
  source schemas and generator, regenerate all affected languages, then test
  real boundary validation.

## Test and hook discovery

Read `.github/workflows/ci.yml`, `Makefile`, `.pre-commit-config.yaml`,
`pyproject.toml`, `builder/pyproject.toml`, `builder/pytest.ini`,
`builder/.coveragerc`, `builder/conftest.py`, `builder/runtime/Cargo.toml`, `frontend/package.json`,
`frontend/vitest.config.ts`, `frontend/playwright.config.ts`, and
`frontend/e2e/README.md` for their relevant surfaces.

Inventory `builder/tests/`, package-local tests, Rust inline/test modules and
`builder/runtime/tests/`, `builder/migration/`, `frontend/__tests__/`,
`frontend/e2e/`, and executable checks under `scripts/`. Compare test discovery
to tracked files so misplaced or excluded tests do not disappear from the audit.
Inspect builder stubs and frontend setup/mocks before interpreting green runs.
Migration baselines and frozen fixtures need independent behavioral expectations;
do not regenerate them just to accept candidate regressions.

The current hooks include secrets/syntax checks, Python lint/format/import/upgrade
checks, Bandit, Prettier, Bash syntax, skill links, maintenance skill references
and Helm. Their precise selection and behavior live in the configuration. In particular:

- Python hook environments are built with the interpreter that runs pre-commit,
  which changes check-ast, pyupgrade, isort and Bandit results. CI, `make hooks`
  and the documented command run pre-commit 3.6.2 on Python 3.12:
  `uvx --from pre-commit==3.6.2 --python 3.12 pre-commit run --files <files>`.
  The configuration does not pin `default_language_version`, because older
  pre-commit installations whose virtualenv cannot discover uv-managed Python
  would then fail to build any Python hook.
- Prettier is a local hook that changes into `frontend/`, requires its installed
  dependencies and rewrites selected files. It and Ruff also format generated
  protocol outputs, so `scripts/generate_protocol_types.py` must emit their layout
  or the hook and `--check` disagree.
- The Bandit hook uses the same release (1.8.6) and `pyproject.toml` policy,
  which skips B101 assertions, as `make security`. The hook scans Python outside
  `builder/` test directories at all severities; `make security` scans only
  `builder/` production files at medium severity and above.
- The Bash syntax hook selects files by identify type (`shell`/`bash`), not
  extension, so executable shell scripts without a suffix are checked too.
- `scripts/check_skill_links.py` checks Markdown links in runtime `skills/` and
  maintenance `.agents/skills/`; it always runs so deletion-only commits cannot
  bypass validation when a linked resource disappears.
- `scripts/check_maintenance_skills.py` always runs, because a rename anywhere
  can strand a path or `make` target named by a maintenance skill.
- The Helm hook lints the chart and renders it with default and `custom-values.yaml`
  values, because `helm lint` only logs template `fail` errors; it fails when Helm
  is missing. `make helm` also checks rendered pod security, provisioning
  PyYAML through `uv run` as CI pins it.
- `scripts/validate_auth_env.py` supplies the environment parser reused by
  `deploy.sh` for workload Secrets and memory-mode settings. Keep validation and
  deployment interpretation consistent, including quoted whitespace.
- Check hook filters at nested package paths and with multiple filenames; inspect
  handling of spaces, excluded generated files and nonzero child-process exits.

## Validation map

The recorded toolchain is Node.js 22, Python 3.12 with `uv`, Rust 1.95, and
Helm 3; every setup-helm workflow step pins v3.22.1 because the action otherwise
installs the latest (Helm 4) release. `make tools-check` reports the Helm major
and checks that `uv` can find Python 3.12. Use current repository requirements
if they change. Prepare Python with
`uv venv builder/.venv --python 3.12` if absent; inspect the active environment
before installing. Frontend installation uses `npm ci --legacy-peer-deps` from
`frontend/`. Use synthetic local credentials and disposable test services.

`make runtime` and `make docker` provision the HTTP checker's Python 3.12
environment through `uv run --with httpx --with pyyaml`, and `make helm` runs
`scripts/check_rendered_pod_security.py` with `--with pyyaml==6.0.3`; those
dependencies do not need to be installed into the system Python. The migration
runners and `make candidate-browser` use `MIGRATION_PYTHON` as a single
interpreter path; supply Python 3.12 with the packages listed beside it in the
`Makefile`, which mirror `.github/workflows/rust-migration.yml`.

Automatic push/pull-request CI and `make ci` retain Rust formatting, Clippy,
unit tests, protocol drift, and coverage. The longer `make migration` and
`make candidate-browser` gates are opt-in, available locally or through the
manual-only `.github/workflows/rust-migration.yml` workflow. Account for these
separately when reviewing migration or compatibility behavior.

| Scope                                   | Repository checks                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python behavior and coverage            | `make builder`; use focused pytest runs during diagnosis. Preserve the Python coverage floor (currently 65%).                                                                                                                                                                                                                                                                               |
| Rust and shared protocol                | `make rust-check`; it runs formatting, Clippy, locked tests and `python3 scripts/generate_protocol_types.py --check`. Regenerate with the same script without `--check` when source schemas change. `make rust-coverage` exercises the Rust coverage gate.                                                                                                                                  |
| Runtime, tool registration or providers | `make runtime` builds the deployable backend and exercises HTTP contracts; without `RUNTIME_REDIS_IMAGE` it prints that the approval and compaction contracts were skipped. Add the relevant `builder/migration/*_check.py` cases when the generic smoke test does not cover the changed behavior; get arguments from current scripts/Makefile.                                             |
| Frontend behavior                       | `make frontend` runs lint, TypeScript, coverage and a production build. Preserve global and per-area coverage gates in `frontend/vitest.config.ts`.                                                                                                                                                                                                                                         |
| Redis, persistence and job lifecycle    | `make test-integration` runs Python and frontend tests against disposable Redis. `pytest -m integration` is a usage error without `PYTEST_USE_REAL_REDIS=1`; frontend suites skip unless `RUN_REDIS_STREAM_INTEGRATION=1`, which `npm run test:integration` sets.                                                                                                                           |
| Browser flows                           | `make frontend-e2e`; distinguish mock-backend coverage from `make candidate-browser`, which uses the built candidate image and its prerequisites.                                                                                                                                                                                                                                           |
| Migration/compatibility                 | `make migration` covers differential/full/minimal image and service contracts. `make migration-benchmark` uses frozen synthetic workloads after migration setup; it does not establish live task latency.                                                                                                                                                                                   |
| Deployment/configuration                | `make helm`, and applicable `make redis-upgrade`, `make docker`, `make security` jobs. Inspect required tools and disposable infrastructure before execution. `builder/tests/test_redis_acl_helm.py` checks the rendered backend Redis ACL against the backend's key families; `builder/tests/test_deploy_helm_secret_allowlists.py` keeps `deploy.sh` and chart Secret allowlists aligned. |
| Hooks                                   | `uvx --from pre-commit==3.6.2 --python 3.12 pre-commit run --files <changed-files>`; `make hooks` installs frontend dependencies and runs the same pinned release on all files.                                                                                                                                                                                                             |
| Automatic CI gate                       | `make ci` runs the automatic CI counterparts sequentially. Inspect `make help` and current CI for prerequisites and coverage. Record every unavailable gate; do not relabel a partial run as full CI.                                                                                                                                                                                       |

Containerized Rust checks of several source trees mounted at the same path
must not share a `CARGO_TARGET_DIR`: cargo's mtime fingerprints can reuse a test
binary built from another tree. Give each tree its own target directory.

Do not run shared build-output or disposable Compose gates concurrently:
the Makefile explicitly serializes `ci` because they share resources. A test
environment failure is a blocker to explain or repair, not evidence of a product
defect or permission to weaken the test. After passing final checks, repeat only
checks affected by subsequent edits or new evidence.
