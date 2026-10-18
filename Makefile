# Local CI Runner
#
# Mirrors .github/workflows/ci.yml. When CI changes, update this file in the
# same commit so the local gate matches what GitHub Actions runs.
#
# Usage:
#   make              show this help
#   make ci           run every CI job sequentially (fail-fast)
#   make <job>        run a single CI counterpart
#   make tools-check  verify required binaries are installed
#   make clean        remove generated test/scan artifacts
#
# Python jobs (builder) install into and run from a venv that uv
# discovers automatically: an explicit VIRTUAL_ENV if active, otherwise the
# nearest `.venv/` walking up from the recipe's working directory (so
# `builder/.venv` is used for the builder job.
# On externally-managed system Python (PEP 668 / Debian-Ubuntu) you must have
# one of those venvs in place — CI sidesteps the issue because its setup-python
# Python is not PEP-668 marked, so `uv pip install --system` works directly in
# ci.yml. To target a non-default interpreter or venv, set UV_PYTHON or
# VIRTUAL_ENV before invoking make.

SHELL := /bin/bash
TRIVY ?= trivy
TRIVY_RESULTS ?= /tmp/daedalus-trivy-results.sarif
TRIVY_INVENTORY ?= /tmp/daedalus-trivy-inventory.json
TRIVY_OCI_SAS_EXAMPLE_SKIP_FILES := /workspace/.venv/lib/python3.12/site-packages/oci/golden_gate/models/create_azure_data_lake_storage_connection_details.py,/workspace/.venv/lib/python3.12/site-packages/oci/golden_gate/models/update_azure_data_lake_storage_connection_details.py
RUNTIME_IMAGE ?= daedalus:runtime-check
RUNTIME_REDIS_IMAGE ?=
MIGRATION_BASELINE_SHA := 7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b
MIGRATION_BASELINE_IMAGE ?= daedalus:migration-baseline-7dc4e1d
MIGRATION_MINIMAL_IMAGE ?= daedalus:rust-minimal-check
MIGRATION_REDIS_IMAGE ?= daedalus:redis-migration-check
MIGRATION_PYTHON ?= python3
MIGRATION_REPORT_DIR ?= /tmp/daedalus-migration-reports
DEPLOY_ARGS ?=
DEPLOY_IMAGE_ARGS ?= --allow-unsigned-images

.DEFAULT_GOAL := help

.PHONY: help deploy ci hooks rust-check rust-coverage migration-baseline migration migration-benchmark candidate-browser runtime builder test-integration frontend frontend-e2e helm redis-upgrade docker security tools-check clean

# CI targets share frontend build output and disposable Compose services.
# Preserve the promised sequential gate even when invoked with make -j.
.NOTPARALLEL: ci

help: ## show available targets
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

deploy: ## build, verify, and deploy through the canonical development path
	./deploy.sh $(DEPLOY_IMAGE_ARGS) $(DEPLOY_ARGS)

ci: tools-check hooks builder test-integration frontend frontend-e2e rust-check rust-coverage migration candidate-browser helm redis-upgrade docker security ## run every CI job sequentially

hooks: ## run every pre-commit hook  (CI job: hooks)
	cd frontend && npm ci --legacy-peer-deps
	uvx --from pre-commit==3.6.2 pre-commit run --all-files --show-diff-on-failure

rust-check: ## Rust formatting, lint, unit and frozen contract tests
	cargo fmt --manifest-path builder/runtime/Cargo.toml --check
	cargo clippy --locked --manifest-path builder/runtime/Cargo.toml --all-targets -- -D warnings
	cargo test --locked --manifest-path builder/runtime/Cargo.toml
	python3 scripts/generate_protocol_types.py --check

rust-coverage: ## instrument Rust tests and retain LCOV evidence
	rustup component add llvm-tools-preview
	cargo install cargo-llvm-cov --version 0.9.1 --locked
	mkdir -p $(MIGRATION_REPORT_DIR)
	cargo llvm-cov --locked --manifest-path builder/runtime/Cargo.toml --fail-under-lines 40 --lcov --output-path $(MIGRATION_REPORT_DIR)/rust.lcov

runtime: rust-check ## build Rust and exercise the deployable backend over HTTP
	docker buildx build --load --target backend --build-context skills=./skills -t $(RUNTIME_IMAGE) ./builder
	python3 builder/runtime_http_check.py --image $(RUNTIME_IMAGE) $(if $(RUNTIME_REDIS_IMAGE),--redis-image $(RUNTIME_REDIS_IMAGE))

migration-baseline: ## rebuild a retained source baseline when no immutable image override is supplied
	@if [ "$(MIGRATION_BASELINE_IMAGE)" = "daedalus:migration-baseline-7dc4e1d" ]; then \
		set -eu; baseline_dir=$$(mktemp -d); trap 'rm -rf "$$baseline_dir"' EXIT; \
		git archive $(MIGRATION_BASELINE_SHA) | tar -x -C "$$baseline_dir"; \
		docker buildx build --load --target backend --build-context skills="$$baseline_dir/skills" \
			--label org.opencontainers.image.revision=$(MIGRATION_BASELINE_SHA) \
			-t $(MIGRATION_BASELINE_IMAGE) "$$baseline_dir/builder"; \
	fi

migration: migration-baseline ## differential, Python-free MCP/OAuth, TLS/ACL and rollback contracts
	docker build -t $(MIGRATION_REDIS_IMAGE) ./redis
	docker buildx build --load --target backend --build-context skills=./skills -t $(RUNTIME_IMAGE) ./builder
	docker buildx build --load --target rust-minimal --build-context skills=./skills -t $(MIGRATION_MINIMAL_IMAGE) ./builder
	docker run --rm --network none -e PYTHONPATH=/workspace -v $(CURDIR)/builder/migration:/migration:ro -v $(CURDIR)/builder/runtime/tests/fixtures:/fixtures:ro --entrypoint python $(RUNTIME_IMAGE) /migration/executor_contract.py
	mkdir -p $(MIGRATION_REPORT_DIR)
	$(MIGRATION_PYTHON) builder/migration/differential.py --baseline $(MIGRATION_BASELINE_IMAGE) --candidate $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --output $(MIGRATION_REPORT_DIR)/differential
	$(MIGRATION_PYTHON) builder/migration/leaf_check.py --image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/leaf.json
	$(MIGRATION_PYTHON) builder/migration/response_check.py --image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE)
	$(MIGRATION_PYTHON) builder/migration/research_check.py --image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/research.json
	$(MIGRATION_PYTHON) builder/migration/image_check.py --image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --rollback-image $(MIGRATION_BASELINE_IMAGE) --compare-image $(MIGRATION_BASELINE_IMAGE) --current-python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/minimal.json
	$(MIGRATION_PYTHON) builder/migration/output_retriever_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/output-retriever.json
	$(MIGRATION_PYTHON) builder/migration/memory_tools_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/memory-tools.json
	$(MIGRATION_PYTHON) builder/migration/memory_api_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/memory-api.json
	$(MIGRATION_PYTHON) builder/migration/profile_import_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/profile-import.json
	$(MIGRATION_PYTHON) builder/migration/documents_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/documents.json
	$(MIGRATION_PYTHON) builder/migration/collections_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/collections.json
	$(MIGRATION_PYTHON) builder/migration/index_transport_check.py --sdk-image $(MIGRATION_BASELINE_IMAGE) --report $(MIGRATION_REPORT_DIR)/index-transport.json
	$(MIGRATION_PYTHON) builder/migration/document_runner_check.py --sdk-image $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-runner.json
	$(MIGRATION_PYTHON) builder/migration/document_reservations_check.py --python-image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-reservations-redis.json
	$(MIGRATION_PYTHON) builder/migration/document_tool_ingestion_check.py --python-image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-tool-coordinator.json
	$(MIGRATION_PYTHON) builder/migration/document_tool_extraction_check.py --python-image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-tool-extraction.json
	$(MIGRATION_PYTHON) builder/migration/document_tool_listing_check.py --python-image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-tool-listing.json
	$(MIGRATION_PYTHON) builder/migration/embeddings_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/embeddings.json
	$(MIGRATION_PYTHON) builder/migration/milvus_search_check.py --sdk-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/milvus-search.json
	$(MIGRATION_PYTHON) builder/migration/document_search_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-search-coordinator.json
	$(MIGRATION_PYTHON) builder/migration/domain_retriever_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/domain-retriever-services.json
	$(MIGRATION_PYTHON) builder/migration/domain_retriever_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/domain-retriever-http.json
	$(MIGRATION_PYTHON) builder/migration/nvidia_docs_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/nvidia-docs-services.json
	$(MIGRATION_PYTHON) builder/migration/nvidia_docs_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/nvidia-docs-http.json
	$(MIGRATION_PYTHON) builder/migration/perplexity_search_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/perplexity-search-services.json
	$(MIGRATION_PYTHON) builder/migration/perplexity_search_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/perplexity-search-http.json
	$(MIGRATION_PYTHON) builder/migration/user_interaction_check.py --python-image $(RUNTIME_IMAGE) --fixture-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/user-interaction-services.json
	$(MIGRATION_PYTHON) builder/migration/user_interaction_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/user-interaction-http.json
	$(MIGRATION_PYTHON) builder/migration/agent_skills_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/agent-skills-processes.json
	$(MIGRATION_PYTHON) builder/migration/agent_skills_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/agent-skills-http.json
	$(MIGRATION_PYTHON) builder/migration/llm_sandbox_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/llm-sandbox-services.json
	$(MIGRATION_PYTHON) builder/migration/llm_sandbox_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/llm-sandbox-http.json
	$(MIGRATION_PYTHON) builder/migration/public_http_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/public-http-services.json
	$(MIGRATION_PYTHON) builder/migration/nws_weather_check.py --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/nws-point-services.json
	$(MIGRATION_PYTHON) builder/migration/nws_weather_check.py --weather --python-image $(RUNTIME_IMAGE) --report $(MIGRATION_REPORT_DIR)/nws-weather-services.json
	$(MIGRATION_PYTHON) builder/migration/nws_weather_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/nws-weather-http.json
	$(MIGRATION_PYTHON) builder/migration/document_tools_http_check.py --python-image $(RUNTIME_IMAGE) --image $(RUNTIME_IMAGE) --minimal-image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-tools-http.json
	$(MIGRATION_PYTHON) builder/migration/document_tool_receipts_check.py --image $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-tool-receipts-wire.json
	$(MIGRATION_PYTHON) builder/migration/ingestion_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/ingestion.json
	$(MIGRATION_PYTHON) builder/migration/document_workers_check.py --image $(MIGRATION_MINIMAL_IMAGE) --full-image $(RUNTIME_IMAGE) --baseline $(MIGRATION_BASELINE_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --report $(MIGRATION_REPORT_DIR)/document-workers.json
	$(MIGRATION_PYTHON) builder/migration/authorization_check.py --image $(MIGRATION_MINIMAL_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --rollback-image $(MIGRATION_BASELINE_IMAGE) --report $(MIGRATION_REPORT_DIR)/authorization.json

candidate-browser: ## real frontend/stream worker against the full deployable candidate image
	cd frontend && E2E_CANDIDATE_IMAGE=$(RUNTIME_IMAGE) E2E_CANDIDATE_REDIS_IMAGE=$(MIGRATION_REDIS_IMAGE) E2E_MILVUS_PEER_IMAGE=$(MIGRATION_BASELINE_IMAGE) E2E_PYTHON=$(MIGRATION_PYTHON) npm run e2e -- --project=chromium

migration-benchmark: ## frozen synthetic performance gates; run on an idle host after make migration
	$(MIGRATION_PYTHON) builder/migration/benchmark.py --baseline $(MIGRATION_BASELINE_IMAGE) --candidate $(RUNTIME_IMAGE) --redis-image $(MIGRATION_REDIS_IMAGE) --output $(MIGRATION_REPORT_DIR)/performance

builder: ## Python builder pytest with coverage  (CI job: builder)
	cd builder && uv pip install -e ".[test]"
	cd builder && uv run --no-project --active python -m pytest --cov --cov-report=xml --cov-report=term-missing --cov-fail-under=65

test-integration: ## Python + frontend persistence tests vs real Redis  (CI job: builder-integration)
	@set -eu; \
		compose_file="$(CURDIR)/frontend/e2e/docker-compose.yml"; \
		docker compose -f $$compose_file up -d --build --wait redis; \
		trap 'docker compose -f $$compose_file down --volumes --remove-orphans' EXIT; \
		cd builder; \
		uv pip install -e ".[test]" redis; \
		PYTEST_USE_REAL_REDIS=1 \
		REDIS_URL=redis://default:e2e-redis-password@localhost:16379 \
		uv run --no-project --active python -m pytest -m integration -v; \
		cd ../frontend; \
		npm ci --legacy-peer-deps; \
		REDIS_URL=redis://default:e2e-redis-password@localhost:16379 \
		SESSION_SECRET=ci-session-secret-for-build-only \
		npm run test:integration

frontend: ## frontend lint, typecheck, test, build  (CI job: frontend)
	cd frontend && npm ci --legacy-peer-deps
	cd frontend && npm run lint
	cd frontend && npx tsc --noEmit --incremental false
	cd frontend && SESSION_SECRET=ci-session-secret-for-build-only npm run coverage
	cd frontend && SESSION_SECRET=ci-session-secret-for-build-only npm run build

frontend-e2e: ## real-browser frontend workflows  (CI job: frontend-e2e)
	cd frontend && npm ci --legacy-peer-deps
	cd frontend && npx playwright install chromium webkit
	cd frontend && npm run e2e

helm: ## helm lint + template render  (CI job: helm)
	helm lint helm/daedalus
	helm template daedalus helm/daedalus >/tmp/daedalus-rendered.yaml
	helm template daedalus helm/daedalus -f custom-values.yaml >/tmp/daedalus-rendered-custom.yaml
	python3 scripts/check_rendered_pod_security.py /tmp/daedalus-rendered.yaml /tmp/daedalus-rendered-custom.yaml

redis-upgrade: ## persisted Redis Helm upgrade, ACL, and TLS rotation  (CI job: redis-upgrade)
	bash scripts/test_redis_helm_upgrade.sh

docker: ## validate all shipped image references, build and scan runtime images
	python3 scripts/check_image_inventory.py
	@set -eu; \
		created_env=0; \
		if [ ! -f .env ]; then \
			cp .env.template .env; \
			created_env=1; \
		fi; \
		trap 'if [ "$$created_env" = 1 ]; then rm -f .env; fi' EXIT; \
		docker compose config --quiet; \
		docker compose build --provenance=mode=max --sbom=true backend frontend redis; \
		python3 builder/runtime_http_check.py --image "$$(docker compose config --format json | jq -r .services.backend.image)" --redis-image "$$(docker compose config --format json | jq -r .services.redis.image)"; \
		for service in backend frontend redis; do \
			image=$$(docker compose config --format json | jq -r ".services.\"$$service\".image"); \
			$(TRIVY) image --severity CRITICAL,HIGH --exit-code 1 \
				--skip-files "$(TRIVY_OCI_SAS_EXAMPLE_SKIP_FILES)" "$$image"; \
		done; \
		python3 scripts/test_compose_redis.py --image "$$image"
	TRIVY=$(TRIVY) python3 scripts/check_image_inventory.py --scan-upstream

security: ## secret, production dependency, and filesystem vulnerability scans  (CI job: security)
	gitleaks detect --source . --verbose --redact
	git ls-files 'builder/*.py' 'builder/**/*.py' | rg -v '(^|/)tests/' | xargs -r uvx --from bandit==1.8.6 bandit -ll -c pyproject.toml
	cd frontend && npm run audit:production
	$(TRIVY) fs --scanners vuln --list-all-pkgs --format json frontend/package-lock.json >$(TRIVY_INVENTORY)
	jq -e '[.Results[]? | select(.Target | endswith("package-lock.json"))] | length > 0' $(TRIVY_INVENTORY) >/dev/null || { echo "Trivy did not inventory frontend/package-lock.json" >&2; exit 1; }
	$(TRIVY) fs --scanners vuln --severity CRITICAL,HIGH --exit-code 1 --format sarif . >$(TRIVY_RESULTS)
	test -s $(TRIVY_RESULTS)

tools-check: ## verify required binaries are present
	@missing=0; \
	for t in uv helm kind kubectl openssl docker gitleaks trivy jq node npm python3.12 cargo rustup rg; do \
		if ! command -v $$t >/dev/null 2>&1; then \
			echo "  missing: $$t"; \
			missing=$$((missing+1)); \
		fi; \
	done; \
	if command -v docker >/dev/null 2>&1 && ! docker buildx inspect | rg -q '^Platforms:.*linux/arm64'; then \
		echo "  missing: ARM binfmt for vendor image scans (see vendor-images/README.md)"; \
		missing=$$((missing+1)); \
	fi; \
	if [ $$missing -gt 0 ]; then \
		echo "==> $$missing required tool(s) missing"; \
		exit 1; \
	else \
		echo "==> all required tools present"; \
	fi

clean: ## remove generated test/scan artifacts
	rm -f builder/coverage.xml builder/.coverage trivy-results.sarif $(TRIVY_RESULTS) $(TRIVY_INVENTORY) /tmp/daedalus-rendered.yaml /tmp/daedalus-rendered-custom.yaml
