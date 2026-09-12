# Review coverage ledger

Baseline: `main` at `457d338ad9eec9a285a57436b37213b5ba577477`, initial worktree clean. All **807 tracked paths** (including hidden configuration and four config-directory symlinks) are accounted for below. The detached checkout and evidence root are `/tmp/daedalus-review-457d338` and `/tmp/daedalus-review-evidence-457d338`. Concurrent untracked original `review.md` is preserved and excluded from this commit review. Review-created reports are not part of the original inventory.

This is traceable coverage, not an assertion that every line received identical depth or that automated checks substitute for inspection. **Inspected** means direct source/configuration or control-flow reasoning; **Inspected by group** means contract/test-family inspection with selected assertions; **Sampled** records partial direct inspection; **Inventoried only** records an accounted path without direct review; **Generated/resolved** means tooling/schema/version/integrity inspection rather than manual graph/hash review; **Excluded binary** means asset internals excluded with the rationale below. UI logic inspection omitted repetitive className/type/import text in a TypeScript AST source view while preserving handlers, effects, ARIA, URLs and render conditions; representative layout CSS and all style/config files were read separately.

| Status | Paths |
|---|---:|
| Excluded binary | 27 |
| Generated/resolved | 9 |
| Inspected | 593 |
| Inventoried only | 153 |
| Sampled | 25 |

All source areas were considered independently of recent changes. Architecture/trust boundaries and success/failure/cancellation/retry/recovery across the six required workflows are in [REVIEW_REPORT.md](REVIEW_REPORT.md). Exact commands, runtime distinctions, pass/fail/blocked results and evidence locations are in [REVIEW_VALIDATION.md](REVIEW_VALIDATION.md).

## Coherent group ledger

The V and L columns in the per-file inventory refer to the validation and limitation columns below; individual exceptions/statuses remain explicit. Source-ledger JSON retains additional per-file notes at `root/merged-inventory.json` under the evidence root.

| Group | Purpose / paths | Review and validation (V) | Remaining limitations (L) |
|---|---|---|---|
| G01 | Hidden config, CI/Makefile, manifests/locks, container build/runtime scripts | CI/Makefile read before commands; resolved versions/image contents; lint/type/build; independent scans; native runtime contracts; security exceptions/primary advisories | Generated lock graphs/hashes machine inspected; arm64 execution and real GitHub signing/publishing not run. Read-only formatter checks fail worker.py; no automatic fixing. |
| G02 | Backend workflow, Google scope declarations | Canonical and inherited config, source-policy/tool exposure, approval/OAuth/native schema/catalog contracts | No live model/MCP catalogs or consent; declarative scopes do not prove remote grants. |
| G03 | Python APIs, NAT adapters, tools, workers, migration and storage | All coherent modules inspected, larger modules by execution path; full Python tests; actual NAT contracts; real Redis; local HTTP fault fixtures; native Milvus fixture | External NV-Ingest/Hindsight/sandbox/embedding/provider execution unavailable; sampled heuristic branches, no sustained load. |
| G04 | Python tests, fixtures and test/runtime harness | Contract families, mocked boundaries, meaningful assertions selected; 1327 tests plus four real-Redis tests; configured coverage 75.70% | Not every assertion/body manually reviewed; coverage denominator is configured modules, not whole repo; external service mocks explicitly retained. |
| G05 | Next authenticated API and storage routes | Caller/identity/owner/input/output and error paths; actual Next/Redis/worker and upload/browser fixtures; two-user checks | Provider service boundaries remain simulated; no real user data. Some docs/tests associated with APIs sampled. |
| G06 | Node server, queue/journal/worker/WebSocket/session/persistence | Lease/terminal/append/cancel/recovery and ownership paths; unit and real Redis tests; actual built worker/WebSocket/browser paths | No enforcing CNI or production topology; load and multi-node failures beyond fixtures not measured. |
| G07 | Shared application utilities, network, media and state helpers | Source/control-flow review, active callers, token framing, caches, replay, metadata, request headers and failures; applicable frontend suite | New cache/replay/rate/endpoint concerns distinguished from executed evidence; no native IndexedDB compression fault experiment or heap benchmark. |
| G08 | Components, pages, hooks and state | All 90 components and 19 entry/hook/state files inspected; handlers/effects/rendering/ARIA plus selected complete source; browser matrix across five projects | Some presentational text omitted in logic view. Physical iOS/PWA not tested; one full-suite login timeout passed focused retry; no model UX quality evaluation. |
| G09 | Frontend unit/Redis tests | All executed by relevant suites; selected auth/state/queue/storage/UI and historical contract assertions inspected | Many individual test bodies remain inventoried only; 818 default passes and 177 Redis passes do not prove unmocked component/service composition. |
| G10 | Browser harness and scenarios | Scripts/Compose/bootstrap inspected before execution; production build with local backend/Redis/object fixtures; full matrix and focused retry | Some scenario bodies sampled/inventoried;14 platform-conditional skips; no real provider or physical device. |
| G11 | Styles, type/limit contracts, PWA and public assets | Styles/types/config reviewed; manifest/offline page and service-worker logic reviewed; build/brand/browser checks | Fonts/raster image bytes excluded; generated precache not audited line-by-line; no screenshot aesthetic certification or physical PWA installation. |
| G12 | 18 app skills and 123 tracked skill paths | Entrypoints/references/helpers reviewed as data; local links/AST/Bash syntax; parser/helper/renderer tests and actual NAT 18 skills/102 resources | Imported benchmark/cards sampled for provenance and not rerun; no infrastructure helper execution, paid model generation or real GPU benchmark. |
| G13 | Helm/nginx/Redis/Compose/deploy assets | Source and default/custom consistency; Helm render/lint; built images; actual nginx-t; exact Compose Redis; disposable persisted Kind upgrade/ACL/TLS/rollback | No deploy.sh live execution; no real secrets/IAM/Cilium dataplane, rolling full application release or arm64 runtime. |
| G14 | Preflight/deployment/credential-sync/link scripts | Read before use; syntax, corresponding contract tests and isolated Redis upgrade; guarded source/secret behavior | Real preflight targets/credential synchronization not invoked. Temporary Kind script changes only isolate checkout, image, cluster and network identities; assertions retained. |
| G15 | Documentation, license, security and prior reviews | Claims checked against current implementation; historical comparisons after independent review; UX/operator scopes read | Historical live evidence not replayed; long independent derivation schedules sampled; not a transitive legal/license audit. |
| G16 | Frozen independent oracle fixtures | README, gzip/JSON structure, checksum and current test use verified | Generated repeated states excluded from manual review; original generation environment not recreated. |

## Exclusions and gaps

Binary assets are branding/fonts/screenshots, not executable first-party source. Their paths/build references were inventoried and browser/build use checked; their binary internals were not audited. Generated dependency locks were retained unchanged, resolved/installed/scanned and checked for runtime requirements rather than read hash-by-hash. The compressed independent oracle expands to1,752,709 bytes and SHA256 `854e10f07cc7904c2d38ca113166408e6fbe59fc120e4947f8bf86b35ea16865`, matching its README. Config symlinks are directory aliases, not missing files. Generated isolated `frontend/public/sw.js` changes came from the production build and did not change the reviewed source baseline.

Required end-to-end validation remains partial for unavailable disposable external services, enforcing network policy, arm64 and physical devices. Individual uninspected test/scenario bodies are explicitly listed below. This report does not silently reinterpret execution as inspection. No area is omitted from the ledger.

## Complete tracked-path inventory

Each path is relative to the repository at the pinned commit. V/L refer to the group table. `root/merged-inventory.json` records the reviewer evidence source and individual notes for every row. All 807 paths occur exactly once.

| Tracked path | Group | Inspection status | Validation / gap |
|---|---|---|---|
| `.dockerignore` | G01 | Inspected | G01 V/L |
| `.env.template` | G01 | Inspected | G01 V/L |
| `.github/pull_request_template.md` | G01 | Inspected | G01 V/L |
| `.github/workflows/ci.yml` | G01 | Inspected | G01 V/L |
| `.github/workflows/release.yml` | G01 | Inspected | G01 V/L |
| `.gitignore` | G01 | Inspected | G01 V/L |
| `.gitleaksignore` | G01 | Inspected | G01 V/L |
| `.pre-commit-config.yaml` | G01 | Inspected | G01 V/L |
| `.security-triage.yaml` | G01 | Inspected | G01 V/L |
| `LICENSE` | G15 | Inspected | G15 V/L |
| `Makefile` | G01 | Inspected | G01 V/L |
| `README.md` | G15 | Inspected | G15 V/L |
| `SECURITY.md` | G15 | Inspected | G15 V/L |
| `backend/google_api_scopes.md` | G02 | Inspected | G02 V/L |
| `backend/tool-calling-config.yaml` | G02 | Inspected | G02 V/L |
| `builder/.coveragerc` | G04 | Inspected | G04 V/L |
| `builder/.dockerignore` | G01 | Inspected | G01 V/L |
| `builder/Dockerfile` | G01 | Inspected | G01 V/L |
| `builder/agent_loop_contract_check.py` | G03 | Inspected | G03 V/L |
| `builder/agent_skills/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/agent_skills/src/agent_skills/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/agent_skills/src/agent_skills/agent_skills_function.py` | G03 | Inspected | G03 V/L |
| `builder/agent_skills/src/agent_skills/register.py` | G03 | Inspected | G03 V/L |
| `builder/agent_skills/src/agent_skills/skill_parser.py` | G03 | Inspected | G03 V/L |
| `builder/autonomous_agent/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/autonomous_agent/src/autonomous_agent/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/autonomous_agent/src/autonomous_agent/backend_client.py` | G03 | Inspected | G03 V/L |
| `builder/autonomous_agent/src/autonomous_agent/dedupe.py` | G03 | Inspected | G03 V/L |
| `builder/autonomous_agent/src/autonomous_agent/models.py` | G03 | Inspected | G03 V/L |
| `builder/autonomous_agent/src/autonomous_agent/prompt.py` | G03 | Inspected | G03 V/L |
| `builder/autonomous_agent/src/autonomous_agent/store.py` | G03 | Inspected | G03 V/L |
| `builder/autonomous_agent/src/autonomous_agent/worker.py` | G03 | Inspected | G03 V/L |
| `builder/collection_metadata_api.py` | G03 | Inspected | G03 V/L |
| `builder/conftest.py` | G04 | Inspected | G04 V/L |
| `builder/content_distiller/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/content_distiller/src/content_distiller/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/content_distiller/src/content_distiller/content_distiller_function.py` | G03 | Inspected | G03 V/L |
| `builder/content_distiller/src/content_distiller/register.py` | G03 | Inspected | G03 V/L |
| `builder/document_ingest_api.py` | G03 | Inspected | G03 V/L |
| `builder/entrypoint.py` | G03 | Inspected | G03 V/L |
| `builder/google_workspace_oauth_contract_check.py` | G03 | Inspected | G03 V/L |
| `builder/image_api.py` | G03 | Inspected | G03 V/L |
| `builder/llm_sandbox/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/llm_sandbox/src/llm_sandbox/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/llm_sandbox/src/llm_sandbox/configs/config.yml` | G03 | Inspected | G03 V/L |
| `builder/llm_sandbox/src/llm_sandbox/llm_sandbox_function.py` | G03 | Inspected | G03 V/L |
| `builder/llm_sandbox/src/llm_sandbox/register.py` | G03 | Inspected | G03 V/L |
| `builder/mcp_approval_api.py` | G03 | Inspected | G03 V/L |
| `builder/mcp_patches.py` | G03 | Inspected | G03 V/L |
| `builder/memory_api.py` | G03 | Inspected | G03 V/L |
| `builder/milvus_collection_migration.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/nat_helpers/src/nat_helpers/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/agent_loop_guard.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/briefing_renderer.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/daedalus_memory_tools.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/front_end.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/google_workspace_auth.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/hindsight_client.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/hindsight_memory_context.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/history_budget.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/idempotency.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/identity.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/image_brief.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/image_utils.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/internal_auth.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/milvus.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/nvidia_docs.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/openai_images.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/per_user_tool_calling.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/redis_url.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/register.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/safe_http.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/secure_redis_object_store.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/tool_output_compaction.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/tool_output_retriever.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/url_guard.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/vllm_embeddings.py` | G03 | Inspected | G03 V/L |
| `builder/nat_helpers/src/nat_helpers/vllm_reranker.py` | G03 | Inspected | G03 V/L |
| `builder/nat_nv_ingest/README.md` | G03 | Inspected | G03 V/L |
| `builder/nat_nv_ingest/configs` | G03 | Inspected | G03 V/L; config-directory symlink |
| `builder/nat_nv_ingest/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/nat_nv_ingest/src/nat_nv_ingest/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/nat_nv_ingest/src/nat_nv_ingest/configs/config.yml` | G03 | Inspected | G03 V/L |
| `builder/nat_nv_ingest/src/nat_nv_ingest/nat_nv_ingest.py` | G03 | Inspected | G03 V/L |
| `builder/nat_nv_ingest/src/nat_nv_ingest/register.py` | G03 | Inspected | G03 V/L |
| `builder/perplexity_search/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/perplexity_search/src/perplexity_search/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/perplexity_search/src/perplexity_search/configs/config.yml` | G03 | Inspected | G03 V/L |
| `builder/perplexity_search/src/perplexity_search/perplexity_search_function.py` | G03 | Inspected | G03 V/L |
| `builder/perplexity_search/src/perplexity_search/register.py` | G03 | Inspected | G03 V/L |
| `builder/profile_import_api.py` | G03 | Inspected | G03 V/L |
| `builder/pylock.runtime-linux-amd64.toml` | G01 | Generated/resolved | G01 V/L |
| `builder/pylock.runtime-linux-arm64.toml` | G01 | Generated/resolved | G01 V/L |
| `builder/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/pytest.ini` | G04 | Inspected | G04 V/L |
| `builder/requirements-runtime-overrides.in` | G01 | Inspected | G01 V/L |
| `builder/requirements-runtime.in` | G01 | Inspected | G01 V/L |
| `builder/rss_feed/README.md` | G03 | Inspected | G03 V/L |
| `builder/rss_feed/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/rss_feed/src/rss_feed/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/rss_feed/src/rss_feed/configs/config.yml` | G03 | Inspected | G03 V/L |
| `builder/rss_feed/src/rss_feed/register.py` | G03 | Inspected | G03 V/L |
| `builder/rss_feed/src/rss_feed/rss_feed_function.py` | G03 | Inspected | G03 V/L |
| `builder/runtime_contract_check.py` | G03 | Inspected | G03 V/L |
| `builder/smart_milvus/README.md` | G03 | Inspected | G03 V/L |
| `builder/smart_milvus/configs` | G03 | Inspected | G03 V/L; config-directory symlink |
| `builder/smart_milvus/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/smart_milvus/src/smart_milvus/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/smart_milvus/src/smart_milvus/configs/config.yml` | G03 | Inspected | G03 V/L |
| `builder/smart_milvus/src/smart_milvus/register.py` | G03 | Inspected | G03 V/L |
| `builder/smart_milvus/src/smart_milvus/smart_milvus_function.py` | G03 | Inspected | G03 V/L |
| `builder/source_verifier/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/source_verifier/src/source_verifier/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/source_verifier/src/source_verifier/critic.py` | G03 | Inspected | G03 V/L |
| `builder/source_verifier/src/source_verifier/register.py` | G03 | Inspected | G03 V/L |
| `builder/source_verifier/src/source_verifier/source_verifier_function.py` | G03 | Inspected | G03 V/L |
| `builder/tests/fixtures/daily_summary_dense_edition.json` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_agent_loop_guard.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_agent_skills_function.py` | G04 | Inspected | G04 V/L |
| `builder/tests/test_async_functions.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_autonomous_agent_worker.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_autonomous_dedupe.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_autonomous_store.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_backend_config_contracts.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_briefing_renderer_tool.py` | G04 | Inspected | G04 V/L |
| `builder/tests/test_ci_makefile_parity.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_collection_metadata_api.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_consolidated_tools.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_content_distiller.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_daedalus_memory_tools.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_daily_summary_renderer.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_daily_summary_validator.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_document_ingest_api.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_document_object_storage_preflight.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_entrypoint.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_front_end.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_google_workspace_auth.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_hindsight_client.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_hindsight_memory_context.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_idempotency.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_image_api.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_image_brief.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_image_utils.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_independent_audit_contracts.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_integration_redis.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_internal_auth_middleware.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_llm_sandbox.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_mcp_approval_api.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_mcp_approval_gate.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_mcp_patches.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_mcp_preflight.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_memory_api.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_milvus_collection_migration.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_milvus_connection_ownership.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_nat_nv_ingest.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_nvidia_docs.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_openai_images.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_operation_filtering.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_per_user_tool_calling.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_perplexity_search.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_profile_import_api.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_rag_preflight.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_rag_secret_sync.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_redis_url.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_rss_feed_utils.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_secure_redis_object_store.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_skill_catalog.py` | G04 | Inspected | G04 V/L |
| `builder/tests/test_skill_helpers.py` | G04 | Inspected | G04 V/L |
| `builder/tests/test_skill_parser.py` | G04 | Inspected | G04 V/L |
| `builder/tests/test_smart_milvus.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_source_verifier_citation_audit.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_source_verifier_llm_critic.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_source_verifier_source_policy.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_telemetry_redaction.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_tool_output_compaction.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_tool_skill_alignment.py` | G04 | Inspected | G04 V/L |
| `builder/tests/test_url_guard.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_user_interaction.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_verify_uv_pip_check.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_vllm_retrieval_clients.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tests/test_webscrape_utils.py` | G04 | Inventoried only | G04 V/L; no direct content review; automated checks only where applicable |
| `builder/tool_catalog_contract_check.py` | G03 | Inspected | G03 V/L |
| `builder/user_interaction/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/user_interaction/src/user_interaction/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/user_interaction/src/user_interaction/approval_tokens.py` | G03 | Inspected | G03 V/L |
| `builder/user_interaction/src/user_interaction/register.py` | G03 | Inspected | G03 V/L |
| `builder/user_interaction/src/user_interaction/user_interaction_function.py` | G03 | Inspected | G03 V/L |
| `builder/uv.lock` | G01 | Generated/resolved | G01 V/L |
| `builder/verify_uv_pip_check.py` | G03 | Inspected | G03 V/L |
| `builder/visual_media/README.md` | G03 | Inspected | G03 V/L |
| `builder/visual_media/configs` | G03 | Inspected | G03 V/L; config-directory symlink |
| `builder/visual_media/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/visual_media/src/visual_media/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/visual_media/src/visual_media/configs/config.yml` | G03 | Inspected | G03 V/L |
| `builder/visual_media/src/visual_media/register.py` | G03 | Inspected | G03 V/L |
| `builder/visual_media/src/visual_media/visual_media_function.py` | G03 | Inspected | G03 V/L |
| `builder/webscrape/configs` | G03 | Inspected | G03 V/L; config-directory symlink |
| `builder/webscrape/pyproject.toml` | G01 | Inspected | G01 V/L |
| `builder/webscrape/src/webscrape/__init__.py` | G03 | Inspected | G03 V/L |
| `builder/webscrape/src/webscrape/configs/config.yml` | G03 | Inspected | G03 V/L |
| `builder/webscrape/src/webscrape/register.py` | G03 | Inspected | G03 V/L |
| `builder/webscrape/src/webscrape/webscrape_function.py` | G03 | Inspected | G03 V/L |
| `custom-values.yaml` | G13 | Inspected | G13 V/L |
| `deploy.sh` | G13 | Inspected | G13 V/L |
| `docker-compose.yaml` | G13 | Inspected | G13 V/L |
| `docs/.gitkeep` | G15 | Inspected | G15 V/L |
| `docs/agent-loop-recovery.md` | G15 | Inspected | G15 V/L |
| `docs/code-audit-2026-09-09.md` | G15 | Inspected | G15 V/L |
| `docs/code-audit-independent-amendment-2026-09-09.md` | G15 | Inspected | G15 V/L |
| `docs/code-audit-independent-review-2026-09-09.md` | G15 | Sampled | G15 V/L |
| `docs/code-audit-review-contracts-2026-09-09.md` | G15 | Inspected | G15 V/L |
| `docs/code-review-2026-08-27.md` | G15 | Inspected | G15 V/L |
| `docs/daily-briefing-loop-investigation-2026-09-11.md` | G15 | Inspected | G15 V/L |
| `docs/google-workspace-authentication.md` | G15 | Inspected | G15 V/L |
| `docs/hindsight-memory-integration.md` | G15 | Inspected | G15 V/L |
| `docs/skills-review.md` | G15 | Inspected | G15 V/L |
| `docs/tool-skill-alignment-2026-09-11.md` | G15 | Inspected | G15 V/L |
| `frontend/.dockerignore` | G01 | Inspected | G01 V/L |
| `frontend/.eslintignore` | G01 | Inspected | G01 V/L |
| `frontend/.eslintrc.json` | G01 | Inspected | G01 V/L |
| `frontend/.gitignore` | G01 | Inspected | G01 V/L |
| `frontend/.npmrc` | G01 | Inspected | G01 V/L |
| `frontend/DESIGN.md` | G15 | Inspected | G15 V/L |
| `frontend/Dockerfile` | G01 | Inspected | G01 V/L |
| `frontend/README.md` | G15 | Inspected | G15 V/L |
| `frontend/UX_REVIEW.md` | G15 | Inspected | G15 V/L |
| `frontend/__tests__/components/autonomy/AutonomyDashboard.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/autonomy/utils.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/chat/ChatInputDocumentDownload.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/chat/ChatView.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/chat/ResponseDocument.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/connections/ConnectionsView.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/images/AttachmentsPopover.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/images/ImagesDock.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/images/OutputActionSheet.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/markdown/SandboxArtifactLink.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/mobile/BottomNav.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/components/surfaces/ModalSurface.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/fixtures/imageContext.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/hooks/useAsyncChat.test.tsx` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/hooks/useVisualViewportKeyboard.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/hooks/useWebSocket.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/nextConfig.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/auth/login.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/pages/api/auth/redirect.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/autonomy/goals.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/autonomy/queue.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/autonomy/runs/index.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/chat/async.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/pages/api/conversations/id.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/conversations/traces.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/document/markdown.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/document/process.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/generated-image/id.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/google-workspace/connections.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/images/history.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/images/jobs.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/pages/api/images/proxy.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/internal/sandboxArtifacts.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/memory.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/profile/import.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/push/subscribe.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/routeInventory.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/session/conversationHistory.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/session/documentStorage.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/pages/api/session/imageStorage.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/pages/api/session/selectedConversation.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/scripts/branding.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/autonomy/store.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/server/chat/conversationJobGuard.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/finalization.integration.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/server/chat/jobState.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/mcpApproval.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/memoryRetention.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/sandboxArtifacts.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/sourcePolicy.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/streamQueue.integration.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/streamQueue.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/streamState.integration.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/streamState.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/chat/streamWorker.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/conversationDeletion.integration.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/documentObjectStore.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/googleWorkspaceConnections.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/independentReview.integration.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/server/mcpOAuth.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/milvusMetadata.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/rateLimit.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/sandboxArtifactStore.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/session/_utils.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/session/documentRefs.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/session/redis.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/server/stateBoundaries.integration.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/services/websocket.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/setupDom.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/state/conversationStore.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/state/imageGuidance.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/state/imagePanelStore.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/api.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/backendApi.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/codeblock.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/conversation.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/conversationReplay.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/documentHandler.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/googleWorkspace.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/htmlResponse.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/imageHandler.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/utils/app/imageHandlerBlobCache.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/imageModelCapabilities.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/imagePresets.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/latexNormalizer.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/magicBytes.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/milvusCollections.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/oauthPrompts.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/promptSafety.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/pwa.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/sandboxArtifactDownload.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/sanitizeSchema.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/serviceWorker.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/streamingBuffer.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/streamingContent.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/uploadBatch.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/app/uploadLimits.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/utils/auth/session.test.ts` | G09 | Sampled | G09 V/L |
| `frontend/__tests__/utils/server/httpProxy.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/__tests__/ws-server.test.ts` | G09 | Inventoried only | G09 V/L; no direct content review; automated checks only where applicable |
| `frontend/auth-passwords.json.template` | G01 | Inspected | G01 V/L |
| `frontend/components/agent/IntermediateSteps.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/agent/StepDetails.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/agent/StepTimeline.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/agent/ViewToggle.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/auth/AuthProvider.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/auth/GalaxyBackground.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/auth/LoginPage.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/auth/ProtectedRoute.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/auth/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/AutonomyDashboard.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/AutonomyFeed.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/DayGroup.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/EmptyState.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/FeedItem.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/LaneFilterChips.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/StatusStrip.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/WorkspaceDrawer.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/autonomy/utils.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/AgentHeartbeat.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/AssistantMessage.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/ChatInput.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/ChatView.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/DocumentIngestProgress.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/McpApprovalCard.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/MessageBubble.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/OptimizedImage.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/ResponseDocument.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/chat/UserMessage.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/connections/ConnectionsView.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/connections/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/error/ErrorBoundary.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/AdjustPopover.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/AttachmentsPopover.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/HistoryDrawer.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/ImagePanel.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/ImagePromptDetail.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/ImageSettingsPanel.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/ImagesCanvas.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/ImagesDock.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/ModeSegmentedControl.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/OutputActionSheet.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/ParamsPopover.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/PresetsPopover.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/images/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/layout/AppShell.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/layout/AppearanceSettings.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/layout/MobileShell.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/layout/SplitPane.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/layout/ViewTabs.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/layout/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/Chart.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/CodeBlock.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/CustomComponents.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/Image.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/LazyChart.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/LazyCodeBlock.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/LazyMermaidChart.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/LazySearchResults.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/Loading.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/MarkdownRenderer.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/MermaidChart.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/SandboxArtifactLink.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/SearchResults.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/markdown/Video.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/memory/MemoryCenter.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/memory/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/mobile/BottomNav.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Avatar.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Badge.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Button.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/DropZone.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/IconButton.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Input.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Popover.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/ProgressBar.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Skeleton.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Spinner.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/Textarea.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/primitives/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/components/pwa/InstallPrompt.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/pwa/OfflineIndicator.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/pwa/UpdateToast.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/sidebar/Sidebar.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/surfaces/GlassCard.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/surfaces/GlassOverlay.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/surfaces/GlassPanel.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/surfaces/GlassToolbar.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/surfaces/ModalSurface.tsx` | G08 | Inspected | G08 V/L |
| `frontend/components/surfaces/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/constants/uploadLimits.ts` | G11 | Inspected | G11 V/L |
| `frontend/e2e/docker-compose.yml` | G10 | Inspected | G10 V/L |
| `frontend/e2e/ensure-s3-bucket.mjs` | G10 | Inspected | G10 V/L |
| `frontend/e2e/helpers/design.ts` | G10 | Inspected | G10 V/L |
| `frontend/e2e/mock-backend.mjs` | G10 | Sampled | G10 V/L |
| `frontend/e2e/run-e2e.mjs` | G10 | Inspected | G10 V/L |
| `frontend/e2e/start-e2e-app.mjs` | G10 | Inspected | G10 V/L |
| `frontend/e2e/tests/agentic-app.spec.ts` | G10 | Sampled | G10 V/L |
| `frontend/e2e/tests/branding.spec.ts` | G10 | Inventoried only | G10 V/L; no direct content review; automated checks only where applicable |
| `frontend/e2e/tests/daily-summary-layout.spec.ts` | G10 | Inventoried only | G10 V/L; no direct content review; automated checks only where applicable |
| `frontend/e2e/tests/hig-design.spec.ts` | G10 | Inventoried only | G10 V/L; no direct content review; automated checks only where applicable |
| `frontend/e2e/tests/ui-layout.spec.ts` | G10 | Sampled | G10 V/L |
| `frontend/e2e/tests/ux-review.spec.ts` | G10 | Inventoried only | G10 V/L; no direct content review; automated checks only where applicable |
| `frontend/env.example` | G01 | Inspected | G01 V/L |
| `frontend/generated/branding.ts` | G01 | Generated/resolved | G01 V/L |
| `frontend/hooks/useAsyncChat.ts` | G08 | Inspected | G08 V/L |
| `frontend/hooks/useFocusTrap.ts` | G08 | Inspected | G08 V/L |
| `frontend/hooks/useKeyboardShortcuts.ts` | G08 | Inspected | G08 V/L |
| `frontend/hooks/useMediaQuery.ts` | G08 | Inspected | G08 V/L |
| `frontend/hooks/useReducedMotion.ts` | G08 | Inspected | G08 V/L |
| `frontend/hooks/useTheme.ts` | G08 | Inspected | G08 V/L |
| `frontend/hooks/useVisualViewportKeyboard.ts` | G08 | Inspected | G08 V/L |
| `frontend/hooks/useWebSocket.ts` | G08 | Inspected | G08 V/L |
| `frontend/next-env.d.ts` | G01 | Generated/resolved | G01 V/L |
| `frontend/next.config.js` | G01 | Inspected | G01 V/L |
| `frontend/package-lock.json` | G01 | Generated/resolved | G01 V/L |
| `frontend/package.json` | G01 | Inspected | G01 V/L |
| `frontend/pages/404.tsx` | G08 | Inspected | G08 V/L |
| `frontend/pages/500.tsx` | G08 | Inspected | G08 V/L |
| `frontend/pages/_app.tsx` | G08 | Inspected | G08 V/L |
| `frontend/pages/_document.tsx` | G08 | Inspected | G08 V/L |
| `frontend/pages/api/auth/login.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/auth/logout.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/auth/me.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/auth/redirect.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/autonomy/config.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/autonomy/feed.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/autonomy/goals.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/autonomy/queue.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/autonomy/runs/[id].ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/autonomy/runs/[id]/cancel.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/autonomy/runs/index.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/chat/async.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/conversations/[id].ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/conversations/[id]/traces.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/conversations/index.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/document/markdown.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/document/process.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/generated-image/[id].ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/google-workspace/connections.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/health.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/images/edit.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/images/generate.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/images/history.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/images/jobs.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/internal/sandboxArtifacts.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/mcp-approvals/[requestId].ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/memory/[...path].ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/memory/status.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/milvus/README.md` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/milvus/collections.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/profile/import.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/push/subscribe.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/session/conversationHistory.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/session/documentStorage.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/session/imageStorage.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/session/selectedConversation.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/session/videoStorage.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/api/sync/notify.ts` | G05 | Inspected | G05 V/L |
| `frontend/pages/index.tsx` | G08 | Inspected | G08 V/L |
| `frontend/pages/login.tsx` | G08 | Inspected | G08 V/L |
| `frontend/playwright.config.ts` | G01 | Inspected | G01 V/L |
| `frontend/playwright.daybook.config.ts` | G01 | Inspected | G01 V/L |
| `frontend/postcss.config.js` | G01 | Inspected | G01 V/L |
| `frontend/prettier.config.js` | G01 | Inspected | G01 V/L |
| `frontend/public/favicon.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/JetBrainsMono-Bold.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/JetBrainsMono-BoldItalic.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/JetBrainsMono-Italic.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/JetBrainsMono-Medium.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/JetBrainsMono-MediumItalic.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/JetBrainsMono-Regular.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/NVIDIASans_Bd.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/NVIDIASans_BdIt.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/NVIDIASans_It.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/NVIDIASans_Md.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/NVIDIASans_MdIt.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/fonts/NVIDIASans_Rg.woff2` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-120x120.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-144x144.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-152x152.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-16x16.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-180x180.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-192x192.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-32x32.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-48x48.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-512x512-maskable.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-512x512.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-72x72.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/icons/icon-96x96.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/manifest.json` | G11 | Inspected | G11 V/L |
| `frontend/public/offline.html` | G11 | Inspected | G11 V/L |
| `frontend/public/screenshots/user-chat.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/screenshots/user-login.png` | G11 | Excluded binary | G11 V/L |
| `frontend/public/sw.js` | G11 | Sampled | G11 V/L |
| `frontend/scripts/check-production-audit.mjs` | G01 | Inspected | G01 V/L |
| `frontend/scripts/check-production-audit.test.mjs` | G01 | Inspected | G01 V/L |
| `frontend/scripts/generate-branding.js` | G01 | Inspected | G01 V/L |
| `frontend/scripts/inject-precache.js` | G01 | Inspected | G01 V/L |
| `frontend/scripts/mermaid-runtime.test.mjs` | G01 | Inspected | G01 V/L |
| `frontend/scripts/start-runtime.js` | G01 | Inspected | G01 V/L |
| `frontend/server/autonomy/store.ts` | G06 | Sampled | G06 V/L |
| `frontend/server/chat/backendSelection.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/constants.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/conversationJobGuard.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/debugReplay.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/documentIngest.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/finalization.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/jobState.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/mcpApproval.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/memoryRetention.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/messagePreprocessing.ts` | G06 | Sampled | G06 V/L |
| `frontend/server/chat/natMessages.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/sandboxArtifacts.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/sourcePolicy.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/streamQueue.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/streamReader.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/streamState.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/streamWorker.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/chat/types.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/config/env.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/documentObjectStore.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/googleWorkspaceConnections.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/images/requestHelpers.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/mcpOAuth.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/milvusMetadata.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/multipartDocument.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/rateLimit.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/sandboxArtifactStore.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/_utils.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/conversationDeletion.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/conversationOwnership.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/dns-cache.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/documentRefs.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/redis.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/redisShared.ts` | G06 | Inspected | G06 V/L |
| `frontend/server/session/sanitize.ts` | G06 | Inspected | G06 V/L |
| `frontend/services/websocket.ts` | G06 | Inspected | G06 V/L |
| `frontend/state/conversationStore.ts` | G08 | Inspected | G08 V/L |
| `frontend/state/imageChatDraftStore.ts` | G08 | Inspected | G08 V/L |
| `frontend/state/imagePanelStore.ts` | G08 | Inspected | G08 V/L |
| `frontend/state/index.ts` | G08 | Inspected | G08 V/L |
| `frontend/state/uiSettingsStore.ts` | G08 | Inspected | G08 V/L |
| `frontend/stream-worker.ts` | G06 | Inspected | G06 V/L |
| `frontend/styles/animations.css` | G11 | Inspected | G11 V/L |
| `frontend/styles/app.css` | G11 | Inspected | G11 V/L |
| `frontend/styles/appearance.css` | G11 | Inspected | G11 V/L |
| `frontend/styles/design-system.css` | G11 | Inspected | G11 V/L |
| `frontend/styles/globals.css` | G11 | Inspected | G11 V/L |
| `frontend/tailwind.config.js` | G01 | Inspected | G01 V/L |
| `frontend/tsconfig.json` | G01 | Inspected | G01 V/L |
| `frontend/types/autonomy.ts` | G11 | Inspected | G11 V/L |
| `frontend/types/chat.ts` | G11 | Inspected | G11 V/L |
| `frontend/types/heic-decode.d.ts` | G11 | Inspected | G11 V/L |
| `frontend/types/imageBrief.ts` | G11 | Inspected | G11 V/L |
| `frontend/types/intermediateSteps.ts` | G11 | Inspected | G11 V/L |
| `frontend/types/mermaid-browser.d.ts` | G11 | Inspected | G11 V/L |
| `frontend/types/sourcePolicy.ts` | G11 | Inspected | G11 V/L |
| `frontend/utils/app/api.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/asyncStepParser.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/backendApi.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/clean.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/codeblock.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/conversation.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/conversationList.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/conversationPagination.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/conversationReplay.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/documentHandler.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/errorCategory.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/googleWorkspace.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/helper.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/htmlResponse.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/imageBlobCache.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/imageHandler.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/imageModelCapabilities.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/imagePresets.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/intermediateSteps.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/intermediateStepsDB.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/latexNormalizer.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/magicBytes.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/mcpApproval.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/milvusCollections.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/oauthPrompts.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/promptSafety.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/pwa.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/queries/auth.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/queries/images.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/queries/index.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/queries/keys.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/queries/milvus.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/sandboxArtifactDownload.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/sanitizeSchema.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/storage.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/streamingBuffer.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/streamingContent.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/uploadBatch.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/videoHandler.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/app/visibilityAwareTimer.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/auth/session.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/auth/users.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/data/isEqual.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/errorReporter.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/fetchWithTimeout.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/logger.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/server/backendAuth.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/server/httpProxy.ts` | G07 | Inspected | G07 V/L |
| `frontend/utils/sync/publish.ts` | G07 | Inspected | G07 V/L |
| `frontend/vitest.config.ts` | G01 | Inspected | G01 V/L |
| `frontend/ws-server.ts` | G06 | Inspected | G06 V/L |
| `helm/daedalus/Chart.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/README.md` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/_helpers.tpl` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/autonomous-agent-worker.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/backend-default-deployment.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/backend-pdb.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/backend-pvc.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/cilium-autonomous-agent.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/cilium-backend.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/cilium-dns-visibility.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/cilium-frontend.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/cilium-nginx.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/config-backend-default.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/config-nginx.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/frontend-deployment.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/frontend-stream-worker.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/ingress.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/networkpolicy-autonomous-agent.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/networkpolicy-backend.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/networkpolicy-frontend.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/networkpolicy-nginx.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/nginx-deployment.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/nginx-pvc.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/redis-deployment.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/redis-init-configmap.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/redis-pvc.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/secret-backend.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/secret-document-objects.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/secret-frontend-session.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/secret-frontend-stream-worker.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/secret-frontend.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/secret-internal-api.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/templates/secret-redis-auth.yaml` | G13 | Inspected | G13 V/L |
| `helm/daedalus/values.yaml` | G13 | Inspected | G13 V/L |
| `nginx/conf.d/frontend.conf` | G13 | Inspected | G13 V/L |
| `package-lock.json` | G01 | Generated/resolved | G01 V/L |
| `pyproject.toml` | G01 | Inspected | G01 V/L |
| `redis/Dockerfile` | G13 | Inspected | G13 V/L |
| `scripts/check_document_object_storage.py` | G14 | Inspected | G14 V/L |
| `scripts/check_mcp_servers.py` | G14 | Inspected | G14 V/L |
| `scripts/check_rag_backend.py` | G14 | Inspected | G14 V/L |
| `scripts/check_skill_links.py` | G14 | Inspected | G14 V/L |
| `scripts/sync_rag_secrets.py` | G14 | Inspected | G14 V/L |
| `scripts/test_redis_helm_upgrade.sh` | G14 | Inspected | G14 V/L |
| `skills/.dockerignore` | G12 | Inspected | G12 V/L |
| `skills/.gitkeep` | G12 | Inspected | G12 V/L |
| `skills/AGENTS.md` | G12 | Inspected | G12 V/L |
| `skills/bubblewrap-agent-workflow/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/bubblewrap-agent-workflow/agents/openai.yaml` | G12 | Inspected | G12 V/L |
| `skills/bubblewrap-agent-workflow/references/api-contract.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/anti-slop.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/exercises.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/full-prompt-library.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/heuristics.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/method-catalog.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/affinity-diagrams.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/analogy-and-blending.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/biomimicry.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/chance-and-remix.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/compression-progress.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/creative-discipline.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/defamiliarization.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/derive-and-mapping.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/first-principles.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/jobs-to-be-done.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/lateral-provocations.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/leverage-points.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/oblique-strategies.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/oulipo.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/pataphysics.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/pattern-languages.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/polya.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/premortem-and-inversion.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/scamper.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/story-skeletons.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/triz-principles.md` | G12 | Inspected | G12 V/L |
| `skills/creative-ideation/references/methods/volume-generation.md` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/assets/daybook-v4.html` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/references/edition-format.md` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/references/edition-policy.json` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/references/editorial-spec.md` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/references/research-and-sourcing.md` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/scripts/render_daybook.py` | G12 | Inspected | G12 V/L |
| `skills/daily-summary/scripts/validate_daybook.py` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/deployment-strategies.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/docker-patterns.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/github-actions.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/incident-response.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/kubernetes.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/platform-engineering.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/release-automation.md` | G12 | Inspected | G12 V/L |
| `skills/devops-engineer/references/terraform-iac.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-docs/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/references/benchmark-protocol.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/analyze_folded.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/capture_offcpu.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/cpu_isolation.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/env.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/extract_throughput.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/isolate.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/process_control.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/profile_oncpu.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/run_aiperf.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/smoke.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/start.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/stop.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-frontend-benchmark/scripts/unisolate.sh` | G12 | Inspected | G12 V/L |
| `skills/dynamo-interconnect-check/BENCHMARK.md` | G12 | Sampled | G12 V/L |
| `skills/dynamo-interconnect-check/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-interconnect-check/evals/evals.json` | G12 | Inspected | G12 V/L |
| `skills/dynamo-interconnect-check/references/interconnect-env-vars.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-interconnect-check/scripts/check_interconnect.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-interconnect-check/skill-card.md` | G12 | Sampled | G12 V/L |
| `skills/dynamo-kv-replay-parity/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-kv-replay-parity/agents/openai.yaml` | G12 | Inspected | G12 V/L |
| `skills/dynamo-kv-replay-parity/references/campaign-concurrency.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-kv-replay-parity/references/campaign-protocol.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-kv-replay-parity/references/internal-polynomial-golden-points.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-recipe-runner/BENCHMARK.md` | G12 | Sampled | G12 V/L |
| `skills/dynamo-recipe-runner/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-recipe-runner/evals/evals.json` | G12 | Inspected | G12 V/L |
| `skills/dynamo-recipe-runner/references/k8s-recipe-workflow.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-recipe-runner/scripts/recipe_tool.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-recipe-runner/skill-card.md` | G12 | Sampled | G12 V/L |
| `skills/dynamo-router-starter/BENCHMARK.md` | G12 | Sampled | G12 V/L |
| `skills/dynamo-router-starter/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-router-starter/evals/evals.json` | G12 | Inspected | G12 V/L |
| `skills/dynamo-router-starter/references/router-modes.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-router-starter/scripts/check_router_health.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-router-starter/skill-card.md` | G12 | Sampled | G12 V/L |
| `skills/dynamo-troubleshoot/BENCHMARK.md` | G12 | Sampled | G12 V/L |
| `skills/dynamo-troubleshoot/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-troubleshoot/evals/evals.json` | G12 | Inspected | G12 V/L |
| `skills/dynamo-troubleshoot/references/failure-decision-tree.md` | G12 | Inspected | G12 V/L |
| `skills/dynamo-troubleshoot/scripts/collect_dynamo_debug_bundle.py` | G12 | Inspected | G12 V/L |
| `skills/dynamo-troubleshoot/skill-card.md` | G12 | Sampled | G12 V/L |
| `skills/espn-fantasy-football/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/image-creation/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/configuration.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/cost-optimization.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/custom-operators.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/gitops.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/helm-charts.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/multi-cluster.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/networking.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/service-mesh.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/storage.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/troubleshooting.md` | G12 | Inspected | G12 V/L |
| `skills/kubernetes-specialist/references/workloads.md` | G12 | Inspected | G12 V/L |
| `skills/network-health-check/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/network-health-check/references/alarm-types.md` | G12 | Inspected | G12 V/L |
| `skills/network-health-check/references/device-states.md` | G12 | Inspected | G12 V/L |
| `skills/network-health-check/references/health-subsystems.md` | G12 | Inspected | G12 V/L |
| `skills/sre-engineer/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/sre-engineer/references/automation-toil.md` | G12 | Inspected | G12 V/L |
| `skills/sre-engineer/references/error-budget-policy.md` | G12 | Inspected | G12 V/L |
| `skills/sre-engineer/references/incident-chaos.md` | G12 | Inspected | G12 V/L |
| `skills/sre-engineer/references/monitoring-alerting.md` | G12 | Inspected | G12 V/L |
| `skills/sre-engineer/references/slo-sli-management.md` | G12 | Inspected | G12 V/L |
| `skills/unifi-network-setup/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/unifi-network/SKILL.md` | G12 | Inspected | G12 V/L |
| `skills/unifi-network/references/network-tools.md` | G12 | Inspected | G12 V/L |
| `test-fixtures/README.md` | G16 | Inspected | G16 V/L |
| `test-fixtures/code-audit-independent-20260909.json.gz` | G16 | Generated/resolved | G16 V/L |
| `uv.lock` | G01 | Generated/resolved | G01 V/L |

## Group accounting

| Group | Tracked paths |
|---|---:|
| G01 | 60 |
| G02 | 2 |
| G03 | 99 |
| G04 | 68 |
| G05 | 38 |
| G06 | 39 |
| G07 | 49 |
| G08 | 109 |
| G09 | 100 |
| G10 | 12 |
| G11 | 43 |
| G12 | 123 |
| G13 | 39 |
| G14 | 6 |
| G15 | 18 |
| G16 | 2 |
