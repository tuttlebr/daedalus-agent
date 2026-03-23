# NeMo Agent Toolkit Testing Guidelines

Rules and patterns for writing unit tests, integration tests, and using the test LLM.

---

## General Rules

All tests use **pytest**. See also the general coding guidelines for baseline requirements.

- Name test files `test_*.py`
- Use `@pytest.fixture(name="fixture_name")` decorator pattern; prefix fixture functions with `fixture_`
- Mock external services with `pytest_httpserver` or `unittest.mock`
- Maintain ≥ 80% code coverage
- Mark slow tests with `@pytest.mark.slow`
- Mark integration tests with `@pytest.mark.integration`

```python
@pytest.fixture(name="my_fixture")
def fixture_my_fixture():
    pass
```

### Running Tests

```bash
pytest                              # unit tests only
pytest --run_slow                   # include slow tests
pytest --run_integration            # include integration tests
pytest --run_slow --run_integration # all tests
```

---

## Integration Tests

### Required Structure

Every integration test must use `@pytest.mark.integration`. Add `@pytest.mark.slow` for tests exceeding 30 seconds.

```python
@pytest.mark.slow
@pytest.mark.integration
@pytest.mark.usefixtures("nvidia_api_key")
async def test_workflow():
    from nat.test.utils import locate_example_config, run_workflow
    from workflow_package.register import WorkflowConfig

    config_file = locate_example_config(WorkflowConfig)
    await run_workflow(config_file=config_file, question="test", expected_answer="answer")
```

### API Key Fixtures

Available from the `nvidia-nat-test` package:

`nvidia_api_key`, `openai_api_key`, `tavily_api_key`, `mem0_api_key`, `azure_openai_api_key`, `serp_api_key`, `serperdev_api_key`

```python
@pytest.mark.usefixtures("nvidia_api_key", "tavily_api_key")
```

### Test Utilities

**`locate_example_config(ConfigClass, filename="config.yml")`** — finds config relative to the workflow class

```python
from nat.test.utils import locate_example_config
config_file = locate_example_config(WorkflowConfig)
config_file = locate_example_config(WorkflowConfig, "config-alt.yml")
```

**`run_workflow(config_file, question, expected_answer)`** — runs and validates

```python
from nat.test.utils import run_workflow

# Basic — case-insensitive match
await run_workflow(config_file=config_file, question="What are LLMs?", expected_answer="Large Language Model")

# Custom validation
result = await run_workflow(
    config_file=config_file,
    question="What are LLMs?",
    expected_answer="",
    assert_expected_answer=False
)
assert "large language model" in result.lower()

# Using a config object (to inject service URIs from fixtures)
from nat.runtime.loader import load_config
from pydantic import HttpUrl
config = load_config(config_file)
config.retrievers['retriever'].uri = HttpUrl(url=milvus_uri)
await run_workflow(config=config, question="...", expected_answer="...")
```

**YAML-only workflows** (no config class):
```python
from pathlib import Path
config_file = Path(__file__).parent / "configs/config.yml"
await run_workflow(config_file=config_file, question="...", expected_answer="...")
```

### Service Fixtures

`milvus_uri`, `etcd_url`, `redis_url`, `mysql_connection_info`, `opensearch_url`, `phoenix_url`, `minio_client`

```python
@pytest.mark.slow
@pytest.mark.integration
@pytest.mark.usefixtures("nvidia_api_key")
async def test_workflow(milvus_uri: str):
    from pydantic import HttpUrl
    from nat.runtime.loader import load_config
    from nat.test.utils import locate_example_config, run_workflow

    config_file = locate_example_config(WorkflowConfig)
    config = load_config(config_file)
    config.retrievers['retriever'].uri = HttpUrl(url=milvus_uri)
    await run_workflow(config=config, question="test", expected_answer="answer")
```

### Custom Service Fixture Pattern

```python
import os
import pytest

@pytest.fixture(name="service_uri", scope="session")
def fixture_service_uri(fail_missing: bool = False) -> str:
    """Ensure service is running and provide connection URI."""
    host = os.getenv("NAT_CI_SERVICE_HOST", "localhost")
    port = os.getenv("NAT_CI_SERVICE_PORT", "1234")
    uri = f"http://{host}:{port}"

    try:
        from service_library import ServiceClient
        ServiceClient(uri=uri).ping()
        return uri
    except Exception:
        reason = f"Unable to connect to Service at {uri}"
        if fail_missing:
            raise RuntimeError(reason)
        pytest.skip(reason=reason)
```

Key practices:
- Use `scope="session"` for service fixtures
- Lazy import service libraries inside fixtures
- Use `NAT_CI_` prefix for environment variables
- Skip tests if service unavailable (unless `--fail_missing`)

### Running Integration Tests

```bash
export NVIDIA_API_KEY=<key>
docker compose -f tests/test_data/docker-compose.services.yml up -d
pytest --run_slow --run_integration
docker compose -f tests/test_data/docker-compose.services.yml down
```

### DO / DON'T

**DO**
- Use `@pytest.mark.integration` and optionally `@pytest.mark.slow`
- Use `locate_example_config()` for workflows with config classes
- Use `run_workflow()` for consistent execution
- Override config values with test service URIs from fixtures
- Import test utilities within test functions (not at module level)
- Use `async def` and session-scoped service fixtures

**DON'T**
- Hard-code service URLs
- Use complex questions with unpredictable LLM responses
- Import third-party service libraries at module level in fixtures
- Use function scope for service fixtures
- Fail tests when services are unavailable — skip them

---

## Test LLM (nat_test_llm)

Stub LLM responses for deterministic, API-free testing.

**YAML usage**
```yaml
llms:
  main:
    _type: nat_test_llm
    response_seq: [alpha, 2, "gamma"]
    delay_ms: 0
workflow:
  _type: chat_completion
  llm_name: main
```

**Fields**
- `response_seq`: list of strings; cycles per call; `[]` returns empty string
- `delay_ms`: per-call artificial latency in milliseconds

**Programmatic usage**
```python
from nat.test.llm import TestLLMConfig
from nat.builder.workflow_builder import WorkflowBuilder
from nat.builder.framework_enum import LLMFrameworkEnum

async def main():
    async with WorkflowBuilder() as builder:
        await builder.add_llm(
            "main",
            TestLLMConfig(response_seq=["alpha", "beta", "gamma"], delay_ms=0),
        )
        llm = await builder.get_llm("main", wrapper_type=LLMFrameworkEnum.LANGCHAIN)
        print(await llm.ainvoke("hello"))  # alpha
        print(llm.invoke("world"))         # beta
```

**Notes**
- `response_seq` cycles within a loaded workflow instance and resets on reload
- Returns plain strings; no NAT retry/thinking patches applied
- Requires the `nvidia-nat-test` package (`import nat.test.llm` once to register)

---

## Quick Reference

| Decorator | Purpose |
|---|---|
| `@pytest.mark.slow` | Tests taking >30 seconds |
| `@pytest.mark.integration` | Tests requiring external services |
| `@pytest.mark.usefixtures("api_key_name")` | Requires a specific API key |

| Fixture | Type |
|---|---|
| `nvidia_api_key`, `openai_api_key`, `tavily_api_key` | API keys |
| `milvus_uri`, `redis_url`, `mysql_connection_info`, `phoenix_url` | Services |
| `root_repo_dir`, `examples_dir` | Directories (NAT repo only) |
