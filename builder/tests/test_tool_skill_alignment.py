"""Cross-surface contracts that isolated operation tests cannot establish."""

import ast
import asyncio
import json
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import yaml
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]


def configuration():
    return yaml.safe_load((ROOT / "backend/tool-calling-config.yaml").read_text())


def test_all_native_tools_have_runtime_catalog_fixtures():
    from tool_catalog_contract_check import FACTORIES, SAMPLES, check_configuration

    check_configuration(configuration())
    assert set(FACTORIES) == set(SAMPLES)


def test_source_ids_agree_across_verifier_chat_and_autonomous_runs():
    from autonomous_agent.prompt import _SOURCE_POLICY_IDS
    from source_verifier.source_verifier_function import _default_source_registry

    config = configuration()
    registry = config["functions"]["source_verifier_tool"]["source_registry"]
    default_registry = _default_source_registry()
    ids = {source["id"] for source in registry}
    ui_ids = set(
        re.findall(
            r"'([a-z_]+)'", (ROOT / "frontend/types/sourcePolicy.ts").read_text()
        )
    )
    assert ids == ui_ids == _SOURCE_POLICY_IDS
    assert {
        source["id"]: (
            source["tools"],
            source["default_enabled"],
            source["requires_auth"],
        )
        for source in registry
    } == {
        source["id"]: (
            source["tools"],
            source["default_enabled"],
            source["requires_auth"],
        )
        for source in default_registry
    }


def test_all_skill_tool_references_resolve_to_exposed_capabilities():
    available = set(configuration()["workflow"]["nat_tools"])
    for path in (ROOT / "skills").rglob("*.md"):
        # The only similarly named bundled helper is a Python operator script.
        text = path.read_text().replace("recipe_tool.py", "")
        references = set(re.findall(r"\b[a-z][a-z0-9_]*(?:_tool|_mcp_server)\b", text))
        assert references <= available, (path, references - available)


def test_registered_native_factories_have_exactly_one_yield():
    class FactoryYields(ast.NodeVisitor):
        def __init__(self, root):
            self.root = root
            self.count = 0

        def visit_AsyncFunctionDef(self, node):
            if node is self.root:
                self.generic_visit(node)

        def visit_FunctionDef(self, node):
            pass

        def visit_Yield(self, node):
            self.count += 1

    checked = []
    for path in (ROOT / "builder").glob("*/src/**/*.py"):
        tree = ast.parse(path.read_text())
        for node in tree.body:
            if not isinstance(node, ast.AsyncFunctionDef):
                continue
            if not any(
                isinstance(d, ast.Call)
                and isinstance(d.func, ast.Name)
                and d.func.id == "register_function"
                for d in node.decorator_list
            ):
                continue
            visitor = FactoryYields(node)
            visitor.visit(node)
            assert visitor.count == 1, (path, node.name, visitor.count)
            checked.append(node.name)
    assert "source_verifier_function" in checked
    assert len(checked) >= 16


def test_verifier_combined_registration_executes_all_operations(monkeypatch):
    import source_verifier.source_verifier_function as mod

    monkeypatch.setattr(
        mod,
        "_fetch_source",
        AsyncMock(
            return_value=mod.FetchResult(
                status="ok", content="The feature is supported."
            )
        ),
    )
    monkeypatch.setattr(
        mod,
        "_call_llm",
        AsyncMock(
            return_value=json.dumps(
                {
                    "verdict": "supported",
                    "confidence": 0.9,
                    "evidence": "The feature is supported.",
                    "reasoning": "Direct evidence",
                    "claim_issues": [],
                }
            )
        ),
    )

    async def run():
        config = mod.SourceVerifierConfig(
            **configuration()["functions"]["source_verifier_tool"]
        )
        infos = [
            info async for info in mod.source_verifier_function(config, MagicMock())
        ]
        assert len(infos) == 1
        info = infos[0]
        assert info.description == config.description
        assert info.input_schema is mod.SourceVerifierInput
        plan = json.loads(
            await info.fn(
                operation="plan_sources",
                research_question="Current cluster and UniFi briefing",
                selected_sources_json='["cluster_state", "network_state", "perplexity_search"]',
                disabled_sources_json='["perplexity_search"]',
                depth="quick",
            )
        )
        assert [s["id"] for s in plan["selected_sources"]] == [
            "cluster_state",
            "network_state",
        ]
        assert plan["blocked_tools"] == ["perplexity_search_tool"]
        verified = json.loads(
            await info.fn(
                operation="verify_claim",
                claim="The feature is supported.",
                source_url="https://8.8.8.8/source",
            )
        )
        assert verified["verdict"] == "supported"
        audit = json.loads(
            await info.fn(
                operation="audit_citations",
                answer_markdown="Supported [1].\n\n## References\n- [1] https://8.8.8.8/source",
                source_urls_json='["https://8.8.8.8/source"]',
            )
        )
        assert audit["passed"]

    asyncio.run(run())


@pytest.mark.parametrize("enabled", [[], ["verify_claim"]])
def test_disabled_verifier_operations_never_fall_through(enabled):
    import source_verifier.source_verifier_function as mod

    async def run():
        infos = [
            info
            async for info in mod.source_verifier_function(
                mod.SourceVerifierConfig(enabled_operations=enabled), MagicMock()
            )
        ]
        result = json.loads(
            await infos[0].fn(operation="plan_sources", research_question="Test")
        )
        assert result["error"] == "operation_disabled"
        assert result["enabled_operations"] == enabled

    asyncio.run(run())


@pytest.mark.parametrize(
    "operation", ["verify_claim", "plan_sources", "audit_citations"]
)
def test_missing_verifier_arguments_fail_before_io(operation, monkeypatch):
    import source_verifier.source_verifier_function as mod

    fetch = AsyncMock(side_effect=AssertionError("Unexpected source fetch"))
    monkeypatch.setattr(mod, "_fetch_source", fetch)

    async def run():
        infos = [
            info
            async for info in mod.source_verifier_function(
                mod.SourceVerifierConfig(), MagicMock()
            )
        ]
        result = json.loads(await infos[0].fn(operation=operation))
        assert result["error"] == "missing_arguments"
        fetch.assert_not_called()

    asyncio.run(run())


def test_verifier_rejects_unknown_operations_and_arguments():
    from source_verifier.source_verifier_function import (
        SourceVerifierConfig,
        SourceVerifierInput,
    )

    with pytest.raises(ValidationError):
        SourceVerifierInput(operation="invented")
    with pytest.raises(ValidationError):
        SourceVerifierInput(operation="plan_sources", query="wrong field")
    with pytest.raises(ValidationError):
        SourceVerifierConfig(enabled_operations=["invented"])
