# Local CI Runner
#
# Mirrors .github/workflows/ci.yml. When CI changes, update this file in the
# same commit so the local gate matches what GitHub Actions runs.
#
# Usage:
#   make              show this help
#   make ci           run every CI job sequentially (fail-fast)
#   make <job>        run a single job (builder, frontend, helm, docker, security, evals)
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

.PHONY: help ci builder test-integration frontend helm docker security evals tools-check clean

help: ## show available targets
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

ci: tools-check builder frontend helm docker security evals ## run every CI job sequentially

builder: ## Python builder pytest with coverage  (CI job: builder)
	cd builder && uv pip install -e ".[test]"
	cd builder && uv run python -m pytest --cov --cov-report=xml --cov-report=term-missing --cov-fail-under=65

test-integration: ## builder integration tests vs real Redis, opt-in  (CI job: builder-integration)
	cd builder && uv pip install -e ".[test]" redis
	cd builder && PYTEST_USE_REAL_REDIS=1 REDIS_URL=$${REDIS_URL:-redis://localhost:6379} uv run python -m pytest -m integration -v

frontend: ## frontend lint, typecheck, test, build  (CI job: frontend)
	cd frontend && npm ci --legacy-peer-deps
	cd frontend && npm run lint
	cd frontend && npx tsc --noEmit --incremental false
	cd frontend && SESSION_SECRET=ci-session-secret-for-build-only npm run coverage
	cd frontend && SESSION_SECRET=ci-session-secret-for-build-only npm run build

helm: ## helm lint + template render  (CI job: helm)
	helm lint helm/daedalus
	helm template daedalus helm/daedalus >/tmp/daedalus-rendered.yaml

docker: ## docker compose config + build runtime images  (CI job: docker)
	@if [ ! -f .env ]; then \
		echo "==> seeding .env from .env.template (local .env was missing)"; \
		cp .env.template .env; \
	else \
		echo "==> reusing existing .env"; \
	fi
	docker compose config --quiet
	docker compose build backend frontend evals

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
	for t in uv helm docker gitleaks trivy node npm python3.12; do \
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
