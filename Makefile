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
# Override the pinned Python interpreters if your environment uses different
# names (e.g. pyenv shims, project venvs):
#   make builder PYTHON_BUILDER=./.venv/bin/python
#   make evals   PYTHON_EVALS=./.venv-3.12/bin/python

SHELL := /bin/bash

PYTHON_BUILDER ?= python3.11
PYTHON_EVALS   ?= python3.12

.DEFAULT_GOAL := help

.PHONY: help ci builder frontend helm docker security evals tools-check clean

help: ## show available targets
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

ci: tools-check builder frontend helm docker security evals ## run every CI job sequentially

builder: ## Python builder pytest with coverage  (CI job: builder)
	cd builder && uv pip install --python $(PYTHON_BUILDER) --system -e ".[test]"
	cd builder && $(PYTHON_BUILDER) -m pytest --cov --cov-report=xml --cov-report=term-missing

frontend: ## frontend lint, typecheck, test, build  (CI job: frontend)
	cd frontend && npm ci --legacy-peer-deps
	cd frontend && npm run lint
	cd frontend && npx tsc --noEmit --incremental false
	cd frontend && SESSION_SECRET=ci-session-secret-for-build-only npm test -- --run
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
	trivy fs --severity CRITICAL,HIGH --format sarif --output trivy-results.sarif .
	test -s trivy-results.sarif

evals: ## eval harness compile + dataset validation  (CI job: evals)
	$(PYTHON_EVALS) -m pip install -r evals/requirements.txt
	$(PYTHON_EVALS) -m py_compile evals/runner.py evals/evaluators/*.py
	$(PYTHON_EVALS) evals/runner.py --validate-only --dataset routing --dataset factuality --dataset workflows

tools-check: ## verify required binaries are present
	@missing=0; \
	for t in uv helm docker gitleaks trivy node npm $(PYTHON_BUILDER) $(PYTHON_EVALS); do \
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
	rm -f builder/coverage.xml builder/.coverage trivy-results.sarif /tmp/daedalus-rendered.yaml
