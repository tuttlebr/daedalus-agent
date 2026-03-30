"""Tests for the mas_optimizer package -- capability gate, task analyzer, and NAT tools."""

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from mas_optimizer.capability_gate import CapabilityGate
from mas_optimizer.task_analyzer import TaskAnalyzer


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# CapabilityGate
# ---------------------------------------------------------------------------


class TestCapabilityGate:
    def test_no_history_returns_zero_accuracy(self):
        gate = CapabilityGate(threshold=0.45)
        assert gate.estimate_sas_accuracy([]) == 0.0

    def test_all_successes_above_threshold(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"success": 0.8}, {"success": 0.9}, {"success": 0.7}]
        accuracy = gate.estimate_sas_accuracy(memories)
        assert accuracy == pytest.approx(0.8, abs=0.01)

    def test_mixed_results_below_threshold(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"success": 0.2}, {"success": 0.1}, {"success": 0.3}]
        accuracy = gate.estimate_sas_accuracy(memories)
        assert accuracy == pytest.approx(0.2, abs=0.01)

    def test_missing_success_key_treated_as_zero(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"other": "data"}, {"success": 0.6}]
        accuracy = gate.estimate_sas_accuracy(memories)
        assert accuracy == pytest.approx(0.3, abs=0.01)

    def test_invalid_success_value_treated_as_zero(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"success": "bad"}, {"success": 0.8}]
        accuracy = gate.estimate_sas_accuracy(memories)
        assert accuracy == pytest.approx(0.4, abs=0.01)

    def test_evaluate_eligible_when_below_threshold(self):
        gate = CapabilityGate(threshold=0.45)
        result = gate.evaluate([])
        assert result.mas_eligible is True
        assert result.sas_accuracy_estimate == 0.0
        assert "MAS may improve" in result.reason

    def test_evaluate_not_eligible_when_above_threshold(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"success": 0.9}, {"success": 0.8}]
        result = gate.evaluate(memories)
        assert result.mas_eligible is False
        assert result.sas_accuracy_estimate >= 0.45
        assert "SAS sufficient" in result.reason

    def test_evaluate_at_exact_threshold_not_eligible(self):
        """Threshold comparison is strict less-than; equal means ineligible."""
        gate = CapabilityGate(threshold=0.45)
        memories = [{"success": 0.45}]
        result = gate.evaluate(memories)
        assert result.mas_eligible is False

    def test_custom_threshold(self):
        gate = CapabilityGate(threshold=0.7)
        memories = [{"success": 0.6}]
        result = gate.evaluate(memories)
        assert result.mas_eligible is True
        assert result.threshold == 0.7


# ---------------------------------------------------------------------------
# TaskAnalyzer
# ---------------------------------------------------------------------------


class TestTaskAnalyzer:
    def test_empty_text_zero_decomposability(self):
        d = TaskAnalyzer.compute_decomposability("")
        assert d == 0.0

    def test_single_verb_low_decomposability(self):
        d = TaskAnalyzer.compute_decomposability("search for documents")
        # One action verb, no parallel indicators: D should be low
        assert d < 0.35

    def test_parallel_verbs_high_decomposability(self):
        d = TaskAnalyzer.compute_decomposability(
            "search the database and also compare results and summarize findings"
        )
        assert d > 0.35

    def test_sequential_task_lower_decomposability(self):
        d_seq = TaskAnalyzer.compute_decomposability(
            "first search then analyze then summarize"
        )
        d_par = TaskAnalyzer.compute_decomposability(
            "search and analyze and summarize simultaneously"
        )
        assert d_par > d_seq

    def test_count_tools(self):
        assert TaskAnalyzer.count_tools(["a", "b", "c"]) == 3
        assert TaskAnalyzer.count_tools([]) == 0

    def test_evaluate_eligible(self):
        analyzer = TaskAnalyzer(decomposability_threshold=0.35, tool_count_threshold=12)
        result = analyzer.evaluate(
            "search and compare and summarize findings concurrently",
            ["tool1", "tool2", "tool3"],
        )
        assert result.mas_eligible is True
        assert result.decomposability_score > 0.35
        assert result.tool_count == 3
        assert "suitable for MAS" in result.reason

    def test_evaluate_ineligible_low_decomposability(self):
        analyzer = TaskAnalyzer(decomposability_threshold=0.35, tool_count_threshold=12)
        result = analyzer.evaluate("describe the system", ["tool1"])
        assert result.mas_eligible is False
        assert "low decomposability" in result.reason

    def test_evaluate_ineligible_high_tool_count(self):
        analyzer = TaskAnalyzer(decomposability_threshold=0.01, tool_count_threshold=5)
        tools = [f"tool{i}" for i in range(10)]
        result = analyzer.evaluate("search and compare results", tools)
        assert result.mas_eligible is False
        assert "coordination overhead" in result.reason

    def test_evaluate_ineligible_both(self):
        analyzer = TaskAnalyzer(decomposability_threshold=0.99, tool_count_threshold=1)
        result = analyzer.evaluate("describe it", ["t1", "t2"])
        assert result.mas_eligible is False
        assert "low decomposability" in result.reason
        assert "coordination overhead" in result.reason


# ---------------------------------------------------------------------------
# MAS optimizer registered function (NAT integration)
# ---------------------------------------------------------------------------


class TestMasOptimizerFunction:
    def test_generator_yields_three_function_infos(self):
        """The generator should yield exactly three FunctionInfo objects."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)
            assert len(items) == 3
            return items

        items = run(_run())
        # All should have .fn and .description
        for item in items:
            assert item.fn is not None
            assert item.description

    def test_mas_evaluate_recommends_mas(self):
        """With no history and a decomposable task, should recommend MAS."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            evaluate_fn = items[0].fn
            result = await evaluate_fn(
                task_description="search and compare and analyze results concurrently",
                active_tool_names="tool1,tool2,tool3",
                memory_results="",
            )
            data = json.loads(result)
            assert data["recommendation"] == "MAS"
            assert data["capability_gate"]["eligible"] is True
            assert data["task_analysis"]["eligible"] is True
            assert data["architecture"]["type"] == "centralized_mas_with_verifier"
            return data

        run(_run())

    def test_mas_evaluate_recommends_sas_high_accuracy(self):
        """With high SAS accuracy, should recommend SAS."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            evaluate_fn = items[0].fn
            memories = json.dumps(
                [
                    {"success": 0.9},
                    {"success": 0.8},
                    {"success": 0.85},
                ]
            )
            result = await evaluate_fn(
                task_description="search and compare results",
                active_tool_names="tool1,tool2",
                memory_results=memories,
            )
            data = json.loads(result)
            assert data["recommendation"] == "SAS"
            assert data["capability_gate"]["eligible"] is False
            return data

        run(_run())

    def test_mas_verify_passes_clean_response(self):
        """A clean response should pass verification."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            verify_fn = items[1].fn
            result = await verify_fn(
                draft_response="The system uses a centralized architecture with gated tools.",
                original_task="Describe the system architecture",
                task_type="general",
            )
            data = json.loads(result)
            assert data["passed"] is True
            assert data["issues_found"] == 0
            return data

        run(_run())

    def test_mas_verify_catches_topic_drift(self):
        """Should detect drift keywords present in response but not task."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            verify_fn = items[1].fn
            result = await verify_fn(
                draft_response="Here is a great VLM for vision language tasks using Qwen3-VL.",
                original_task="Describe how the MAS orchestrator works",
                task_type="general",
            )
            data = json.loads(result)
            assert data["passed"] is False
            assert data["issues_found"] >= 1
            assert any("topic_drift" in i for i in data["issues"])
            return data

        run(_run())

    def test_mas_verify_catches_missing_architecture_content(self):
        """Meta-correction task should flag missing architecture keywords."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            verify_fn = items[1].fn
            result = await verify_fn(
                draft_response="The weather is nice today.",
                original_task="Improve your own architecture",
                task_type="meta_correction",
            )
            data = json.loads(result)
            assert data["passed"] is False
            assert any("missing_content" in i for i in data["issues"])
            return data

        run(_run())

    def test_mas_verify_catches_verbosity(self):
        """Should flag responses exceeding verbosity ceiling."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig(verbosity_ceiling=10)
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            verify_fn = items[1].fn
            result = await verify_fn(
                draft_response=" ".join(["word"] * 20),
                original_task="Be concise",
                task_type="general",
            )
            data = json.loads(result)
            assert data["passed"] is False
            assert any("verbosity" in i for i in data["issues"])
            return data

        run(_run())

    def test_mas_log_outcome_returns_structured_entry(self):
        """Should return a complete log entry with add_memory instruction."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            log_fn = items[2].fn
            result = await log_fn(
                task_type="meta_correction",
                architecture_used="centralized_mas_with_verifier",
                decomposability_score=0.6,
                tool_count=5,
                success_score=0.8,
                notes="Verifier caught drift",
            )
            data = json.loads(result)
            assert data["logged"] is True
            assert data["metadata"]["task_type"] == "meta_correction"
            assert data["metadata"]["success_score"] == 0.8
            assert "add_memory" in data["add_memory_instruction"]
            assert "MAS outcome" in data["memory_entry"]
            return data

        run(_run())

    def test_mas_evaluate_handles_invalid_json_memory(self):
        """Should gracefully handle malformed memory_results JSON."""

        async def _run():
            from mas_optimizer.mas_optimizer_function import (
                MasOptimizerConfig,
                mas_optimizer_function,
            )

            config = MasOptimizerConfig()
            builder = MagicMock()
            items = []
            async for item in mas_optimizer_function(config, builder):
                items.append(item)

            evaluate_fn = items[0].fn
            result = await evaluate_fn(
                task_description="search and compare",
                active_tool_names="tool1",
                memory_results="not valid json{{{",
            )
            data = json.loads(result)
            # Should still return a valid assessment (treats as empty memories)
            assert "recommendation" in data
            return data

        run(_run())
