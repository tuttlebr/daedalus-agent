"""The shipped workflows load through the production factory catalogue.

``tool_catalog_contract_check`` compares names with its own map. This test
instead resolves every configured ``_type`` through
``daedalus_runtime.tools.load_tool_factories()`` and runs the tool service's
startup validation, so a mistyped type or a module dropped from the fixed
catalogue fails here rather than only at built-image startup.
"""

import re
from pathlib import Path

import pytest
from daedalus_runtime.config import load_config, validate_config
from daedalus_runtime.tools import ToolRegistry, load_tool_factories

ROOT = Path(__file__).parents[2]
_VARIABLE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)")


def _synthetic(name: str) -> str:
    """Offline, non-secret stand-ins shaped like each deployment setting."""
    if name == "REDIS_URL":
        return "redis://redis.invalid:6379"
    if name == "MILVUS_DATABASE":
        return "default"
    if name.endswith("_PORT"):
        return "7670"
    if "TIMEOUT" in name:
        return "10"
    if "RETRIES" in name:
        return "2"
    if name.endswith(("_URL", "_URI", "_ENDPOINT", "_SERVER")):
        return "http://synthetic.invalid:8080"
    if name.endswith("_HOST"):
        return "synthetic.invalid"
    return f"synthetic-{name.lower()}"


@pytest.mark.parametrize(
    "workflow", ["tool-calling-config.yaml", "local-chat-config.yaml"]
)
def test_shipped_workflow_passes_tool_service_startup_validation(monkeypatch, workflow):
    path = ROOT / "backend" / workflow
    for name in set(_VARIABLE.findall(path.read_text(encoding="utf-8"))):
        monkeypatch.setenv(name, _synthetic(name))
    monkeypatch.delenv("DOCUMENT_INGEST_DEFAULT_COLLECTION", raising=False)
    load_tool_factories()
    config = load_config(path)
    # The image mounts the repository's skills at /skills.
    for function in config.get("functions", {}).values():
        if function.get("_type") == "agent_skills":
            function["skills_directory"] = str(ROOT / "skills")
    registry = ToolRegistry(config)

    for name, function in config.get("functions", {}).items():
        assert registry.supports(function.get("_type")), name
    validate_config(config, registry)
