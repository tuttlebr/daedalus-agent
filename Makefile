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
# Python jobs (builder, evals) install into and run from a venv that uv
# discovers automatically: an explicit VIRTUAL_ENV if active, otherwise the
# nearest `.venv/` walking up from the recipe's working directory (so
# `builder/.venv` is used for the builder job, `.venv` at repo root for evals).
# On externally-managed system Python (PEP 668 / Debian-Ubuntu) you must have
# one of those venvs in place — CI sidesteps the issue because its setup-python
# Python is not PEP-668 marked, so `uv pip install --system` works directly in
# ci.yml. To target a non-default interpreter or venv, set UV_PYTHON or
# VIRTUAL_ENV before invoking make.

SHELL := /bin/bash
TRIVY_RESULTS ?= /tmp/daedalus-trivy-results.sarif

.DEFAULT_GOAL := help

.PHONY: help ci builder test-integration frontend frontend-e2e helm redis-upgrade docker security evals tools-check clean

help: ## show available targets
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

ci: tools-check builder test-integration frontend frontend-e2e helm redis-upgrade docker security evals ## run every CI job sequentially

builder: ## Python builder pytest with coverage  (CI job: builder)
	cd builder && uv pip install -e ".[test]"
	cd builder && uv run python -m pytest --cov --cov-report=xml --cov-report=term-missing --cov-fail-under=65

test-integration: ## builder integration tests vs real Redis  (CI job: builder-integration)
	@set -eu; \
		compose_file="$(CURDIR)/frontend/e2e/docker-compose.yml"; \
		docker compose -f $$compose_file up -d --build --wait redis; \
		trap 'docker compose -f $$compose_file down --volumes --remove-orphans' EXIT; \
		cd builder; \
		uv pip install -e ".[test]" redis; \
		PYTEST_USE_REAL_REDIS=1 \
		REDIS_URL=redis://default:e2e-redis-password@localhost:16379 \
		uv run python -m pytest -m integration -v

frontend: ## frontend lint, typecheck, test, build  (CI job: frontend)
	cd frontend && npm ci --legacy-peer-deps
	cd frontend && npm run lint
	cd frontend && npx tsc --noEmit --incremental false
	cd frontend && SESSION_SECRET=ci-session-secret-for-build-only npm run coverage
	cd frontend && SESSION_SECRET=ci-session-secret-for-build-only npm run build

frontend-e2e: ## real-browser frontend workflows  (CI job: frontend-e2e)
	cd frontend && npm ci --legacy-peer-deps
	cd frontend && npx playwright install chromium
	cd frontend && npm run e2e

helm: ## helm lint + template render  (CI job: helm)
	helm lint helm/daedalus
	helm template daedalus helm/daedalus >/tmp/daedalus-rendered.yaml

redis-upgrade: ## persisted Redis Helm upgrade, ACL, and TLS rotation  (CI job: redis-upgrade)
	bash scripts/test_redis_helm_upgrade.sh

docker: ## docker compose config + build runtime images  (CI job: docker)
	@set -eu; \
		created_env=0; \
		if [ ! -f .env ]; then \
			cp .env.template .env; \
			created_env=1; \
		fi; \
		trap 'if [ "$$created_env" = 1 ]; then rm -f .env; fi' EXIT; \
		docker compose config --quiet; \
		docker compose build --provenance=mode=max --sbom=true backend frontend evals redis; \
		for service in backend frontend evals redis; do \
			image=$$(docker compose config --format json | jq -r ".services.\"$$service\".image"); \
			trivy image --severity CRITICAL,HIGH --exit-code 1 "$$image"; \
		done

security: ## gitleaks + trivy filesystem scans  (CI job: security)
	gitleaks detect --source . --verbose --redact
	trivy fs --severity CRITICAL,HIGH --exit-code 1 --format sarif . >$(TRIVY_RESULTS)
	test -s $(TRIVY_RESULTS)

evals: ## eval harness compile + dataset validation  (CI job: evals)
	uv pip install -r evals/requirements.txt
	uv run python -m py_compile evals/runner.py evals/evaluators/*.py
	uv run python evals/runner.py --validate-only --dataset routing --dataset factuality --dataset workflows

tools-check: ## verify required binaries are present
	@missing=0; \
	for t in uv helm kind kubectl openssl docker gitleaks trivy node npm python3.12; do \
		if ! command -v $$t >/dev/null 2>&1; then \
			echo "  missing: $$t"; \
			missing=$$((missing+1)); \
		fi; \
	done; \
	if [ $$missing -gt 0 ]; then \
		echo "==> $$missing required tool(s) missing"; \
		exit 1; \
	else \
		echo "==> all required tools present"; \
	fi

clean: ## remove generated test/scan artifacts
	rm -f builder/coverage.xml builder/.coverage trivy-results.sarif $(TRIVY_RESULTS) /tmp/daedalus-rendered.yaml
