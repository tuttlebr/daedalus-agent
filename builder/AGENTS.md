# Repository Guidelines

## Project Structure & Module Organization

This directory contains the Daedalus builder component: Python NeMo Agent Toolkit tool packages plus their shared test harness. Each top-level package, such as `webscrape/`, `smart_milvus/`, `visual_media/`, `nat_nv_ingest/`, and `rss_feed/`, is independently installable with code under `src/<package>/`, metadata in `pyproject.toml`, and NAT config in `src/<package>/configs/config.yml`. Shared helpers live in `nat_helpers/src/nat_helpers/`. Root services and patches include `entrypoint.py`, `image_api.py`, `document_ingest_api.py`, `mcp_patches.py`, and `llm_diagnostics.py`. Tests live in `tests/`.

## Build, Test, and Development Commands

Run from `builder/` unless noted.

```bash
uv pip install -e ".[test]"                         # install test dependencies
python3 -m pytest tests                              # run the test suite
pytest --cov --cov-report=xml --cov-report=term-missing # CI-style coverage run
python3 -m pytest tests/test_webscrape_utils.py      # run one test file
python3 -m pytest tests -k smart_milvus              # run focused tests
cd .. && pre-commit run --all-files                  # format, lint, security checks
cd .. && make builder                                # local CI mirror
```

## Coding Style & Naming Conventions

Target Python 3.11+. Pre-commit enforces Ruff fixes, Ruff format, isort with the Black profile, pyupgrade `--py311-plus`, and Bandit. Keep package code in `src/<package>/` and name tests `test_*.py`. NAT packages should expose a `nat.components` entry point to `<package>.register`; `register.py` imports function modules for registration side effects. Keep config fields aligned between config classes, package `config.yml`, and backend workflow YAML.

## Testing Guidelines

The suite is pytest-based. Add focused unit tests under `tests/` for pure helpers inside `*_function.py` or shared modules. Do not require a local NAT install; `conftest.py` provides fakes for NAT, Redis, FastAPI, OpenAI, Playwright, Milvus, and related services. Prefer testing returned strings, parsed structures, validation behavior, and error handling. Run coverage before PRs that touch shared helpers, runtime patches, or HTTP routes.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Fix optional Exa search config validation` and `Expose autonomous queue visibility`. Keep commits focused and mention tests when behavior changes. PRs should include the problem, implementation summary, linked issue when applicable, and exact test commands run. Include screenshots or API examples for frontend-facing HTTP routes or generated output formats.

## Security & Configuration Tips

Do not commit secrets, API keys, coverage artifacts, or local virtualenv files. Configuration often flows through environment-variable interpolation in YAML; document new variables and provide safe defaults where startup requires them. Tools generally return readable `Error: ...` strings instead of raising because the agent consumes tool output directly.
