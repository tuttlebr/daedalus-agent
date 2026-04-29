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
    def test_no_history_returns_neutral_threshold(self):
        """No history should be neutral, not a synthetic SAS success."""
        gate = CapabilityGate(threshold=0.45)
        assert gate.estimate_sas_accuracy([]) == 0.45

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

    def test_missing_success_key_is_ignored(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"other": "data"}, {"success": 0.6}]
        accuracy = gate.estimate_sas_accuracy(memories)
        assert accuracy == pytest.approx(0.6, abs=0.01)

    def test_invalid_success_value_is_ignored(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"success": "bad"}, {"success": 0.8}]
        accuracy = gate.estimate_sas_accuracy(memories)
        assert accuracy == pytest.approx(0.8, abs=0.01)

    def test_boolean_success_flag_is_ignored(self):
        gate = CapabilityGate(threshold=0.45)
        result = gate.evaluate([{"success": True}])
        assert result.has_calibration is False
        assert result.sas_accuracy_estimate is None

    def test_evaluate_neutral_when_no_history(self):
        """No history should not veto MAS; task analysis decides."""
        gate = CapabilityGate(threshold=0.45)
        result = gate.evaluate([])
        assert result.mas_eligible is True
        assert result.sas_accuracy_estimate is None
        assert result.has_calibration is False
        assert result.sample_count == 0
        assert "neutral" in result.reason

    def test_evaluate_eligible_when_below_threshold(self):
        """Low historical accuracy should enable MAS."""
        gate = CapabilityGate(threshold=0.45)
        memories = [{"success": 0.2}, {"success": 0.1}, {"success": 0.3}]
        result = gate.evaluate(memories)
        assert result.mas_eligible is True
        assert result.sas_accuracy_estimate < 0.45
        assert result.has_calibration is True
        assert result.sample_count == 3
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

    def test_nested_success_score_is_supported(self):
        gate = CapabilityGate(threshold=0.45)
        memories = [{"metadata": {"key_value_pairs": {"success_score": "0.7"}}}]
        result = gate.evaluate(memories)
        assert result.sas_accuracy_estimate == pytest.approx(0.7, abs=0.01)
        assert result.sample_count == 1


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

    def test_count_tools_dedupes_and_ignores_meta_tools(self):
        tools = [
            "research_agent",
            "research_agent",
            "get_memory",
            "add_memory",
            "agent_skills_tool",
            "current_datetime_tool",
        ]
        assert TaskAnalyzer.count_tools(tools) == 1

    def test_production_tool_catalog_counts_routing_domains(self):
        tools = [
            "research_agent",
            "ops_agent",
            "media_agent",
            "user_data_agent",
            "agent_skills_tool",
            "get_memory",
            "add_memory",
            "user_interaction_tool",
            "think_tool",
            "current_datetime_tool",
            "nvidia_retriever_tool",
            "semianalysis_retriever_tool",
            "kubernetes_retriever_tool",
            "serpapi_search_tool",
            "webscrape_tool",
            "content_distiller_tool",
            "source_verifier_tool",
            "nv_ingest_tool",
            "user_uploaded_files_retriever_tool",
        ]
        assert TaskAnalyzer.count_tools(tools) == 4

    # -- Sequential interdependence tests --------------------------------

    def test_no_interdependence_returns_zero(self):
        si = TaskAnalyzer.compute_sequential_interdependence(
            "analyze revenue and compare costs"
        )
        assert si == 0.0 or si < 0.15

    def test_high_interdependence_for_chained_tasks(self):
        si = TaskAnalyzer.compute_sequential_interdependence(
            "craft a pickaxe, then using the result of that craft a shovel, "
            "which depends on the output of the previous step"
        )
        assert si > 0.3

    def test_pipeline_task_has_interdependence(self):
        si = TaskAnalyzer.compute_sequential_interdependence(
            "build a data pipeline step by step: first extract, "
            "then using the result transform, then load sequentially"
        )
        assert si > 0.2

    def test_interdependence_penalises_effective_d(self):
        """A task with both parallel words and tight coupling should have
        effective_d lower than raw d."""
        analyzer = TaskAnalyzer()
        # Has "and" (parallel) but also "using the result of" (interdependence)
        result = analyzer.evaluate(
            "search and compare, then using the result of the search "
            "build a report step by step based on the previous output",
            ["tool1", "tool2"],
        )
        assert result.effective_decomposability < result.decomposability_score
        assert result.sequential_interdependence > 0.0

    # -- Task type classification ----------------------------------------

    def test_exploratory_task_classified_correctly(self):
        task_type = TaskAnalyzer.classify_task_type(
            "search for the latest news about NVIDIA and find out "
            "what is happening with their GPU launch"
        )
        assert task_type == "exploratory"

    def test_analysis_task_classified_correctly(self):
        task_type = TaskAnalyzer.classify_task_type(
            "analyze the cost-benefit of migrating to Kubernetes "
            "and evaluate the tradeoff between EKS and GKE"
        )
        assert task_type == "structured_analysis"

    def test_ambiguous_task_defaults_to_analysis(self):
        task_type = TaskAnalyzer.classify_task_type("do something")
        assert task_type == "structured_analysis"

    # -- Full evaluate tests ---------------------------------------------

    def test_evaluate_eligible(self):
        analyzer = TaskAnalyzer(decomposability_threshold=0.35, tool_count_threshold=12)
        result = analyzer.evaluate(
            "search and compare and summarize findings concurrently",
            ["tool1", "tool2", "tool3"],
        )
        assert result.mas_eligible is True
        assert result.effective_decomposability > 0.35
        assert result.tool_count == 3
        assert "suitable for MAS" in result.reason

    def test_evaluate_ineligible_low_decomposability(self):
        analyzer = TaskAnalyzer(decomposability_threshold=0.35, tool_count_threshold=12)
        result = analyzer.evaluate("describe the system", ["tool1"])
        assert result.mas_eligible is False
        assert "effective_D" in result.reason or "low decomposability" in result.reason

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

    def test_evaluate_returns_architecture_recommendation(self):
        analyzer = TaskAnalyzer()
        result = analyzer.evaluate(
            "search and compare and analyze results concurrently",
            ["tool1"],
        )
        assert result.recommended_architecture in ("centralized", "decentralized")

    def test_evaluate_exploratory_recommends_decentralized(self):
        analyzer = TaskAnalyzer()
        result = analyzer.evaluate(
            "research and find out the latest news about NVIDIA "
            "and investigate what is happening concurrently",
            ["tool1", "tool2"],
        )
        assert result.recommended_architecture == "decentralized"

    def test_evaluate_analysis_recommends_centralized(self):
        analyzer = TaskAnalyzer()
        result = analyzer.evaluate(
            "analyze and compare and evaluate the cost-benefit concurrently",
            ["tool1", "tool2"],
        )
        assert result.recommended_architecture == "centralized"

    def test_sequential_task_blocked_by_interdependence(self):
        """PlanCraft-style task: has verbs + 'and' but tight coupling."""
        analyzer = TaskAnalyzer(decomposability_threshold=0.35)
        result = analyzer.evaluate(
            "craft a wooden plank, then using the result of that craft "
            "a stick, which depends on the output of the previous step, "
            "and finally build a pickaxe step by step",
            ["tool1"],
        )
        # Should be blocked: high SI penalises effective_d below threshold
        assert result.sequential_interdependence > 0.2
        assert result.effective_decomposability < result.decomposability_score


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
        """With low-accuracy history and a decomposable task, should recommend MAS."""

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
            low_accuracy_history = json.dumps(
                [
                    {"success": 0.2},
                    {"success": 0.1},
                    {"success": 0.3},
                ]
            )
            result = await evaluate_fn(
                task_description="search and compare and analyze results concurrently",
                active_tool_names="tool1,tool2,tool3",
                memory_results=low_accuracy_history,
            )
            data = json.loads(result)
            assert data["recommendation"] == "MAS"
            assert data["capability_gate"]["eligible"] is True
            assert data["capability_gate"]["has_calibration"] is True
            assert data["task_analysis"]["eligible"] is True
            assert "sequential_interdependence" in data["task_analysis"]
            assert "effective_decomposability" in data["task_analysis"]
            assert data["architecture"]["skill_name"] == "mas-procedure"
            return data

        run(_run())

    def test_mas_evaluate_balanced_no_calibration_allows_decomposable_task(self):
        """No valid calibration should not block a clearly decomposable task."""

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
                task_description=(
                    "research and compare the latest NVIDIA and AMD AI "
                    "accelerator roadmaps and summarize implications concurrently"
                ),
                active_tool_names=(
                    "research_agent,ops_agent,media_agent,user_data_agent,"
                    "agent_skills_tool,get_memory,add_memory,user_interaction_tool,"
                    "think_tool,current_datetime_tool,nvidia_retriever_tool,"
                    "semianalysis_retriever_tool,kubernetes_retriever_tool,"
                    "serpapi_search_tool,webscrape_tool,content_distiller_tool,"
                    "source_verifier_tool,nv_ingest_tool,"
                    "user_uploaded_files_retriever_tool"
                ),
                memory_results="[]",
            )
            data = json.loads(result)
            assert data["recommendation"] == "MAS"
            assert data["capability_gate"]["has_calibration"] is False
            assert data["capability_gate"]["sample_count"] == 0
            assert data["task_analysis"]["tool_count"] == 4
            assert data["architecture"]["skill_name"] == "mas-procedure"
            return data

        run(_run())

    def test_mas_evaluate_no_calibration_still_blocks_simple_task(self):
        """Balanced routing should not turn simple work into MAS."""

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
                task_description="Describe the Kubernetes networking configuration",
                active_tool_names="research_agent,ops_agent,media_agent,user_data_agent",
                memory_results="[]",
            )
            data = json.loads(result)
            assert data["recommendation"] == "SAS"
            assert data["capability_gate"]["eligible"] is True
            assert data["task_analysis"]["eligible"] is False
            assert data["architecture"]["skill_name"] is None
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

    def test_mas_evaluate_selects_decentralized_for_exploratory(self):
        """Exploratory tasks with low SAS accuracy should get decentralized architecture."""

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
            low_accuracy_history = json.dumps(
                [
                    {"success": 0.2},
                    {"success": 0.1},
                    {"success": 0.3},
                ]
            )
            result = await evaluate_fn(
                task_description=(
                    "research and find out the latest news about NVIDIA "
                    "and investigate what is happening concurrently"
                ),
                active_tool_names="tool1,tool2",
                memory_results=low_accuracy_history,
            )
            data = json.loads(result)
            assert data["recommendation"] == "MAS"
            assert data["architecture"]["type"] == "decentralized_mas"
            assert data["task_analysis"]["recommended_architecture"] == "decentralized"
            return data

        run(_run())

    def test_mas_evaluate_selects_centralized_for_analysis(self):
        """Structured analysis tasks with low SAS accuracy should get centralized architecture."""

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
            low_accuracy_history = json.dumps(
                [
                    {"success": 0.2},
                    {"success": 0.1},
                    {"success": 0.3},
                ]
            )
            result = await evaluate_fn(
                task_description=(
                    "analyze and compare and evaluate the tradeoff "
                    "between EKS and GKE concurrently"
                ),
                active_tool_names="tool1,tool2",
                memory_results=low_accuracy_history,
            )
            data = json.loads(result)
            assert data["recommendation"] == "MAS"
            assert data["architecture"]["type"] == "centralized_mas_with_verifier"
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

    def test_mas_verify_catches_weak_alignment(self):
        """Should flag responses that don't address the task entities."""

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
                draft_response="The weather is sunny and warm today in Portland.",
                original_task="Analyze the Kubernetes cluster networking configuration",
                task_type="general",
            )
            data = json.loads(result)
            assert data["passed"] is False
            assert any("weak_alignment" in i for i in data["issues"])
            return data

        run(_run())

    def test_mas_verify_passes_aligned_response(self):
        """Response addressing task entities should pass alignment check."""

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
                draft_response=(
                    "The Kubernetes cluster networking uses Calico CNI "
                    "with a configuration that enables pod-to-pod communication."
                ),
                original_task="Analyze the Kubernetes cluster networking configuration",
                task_type="general",
            )
            data = json.loads(result)
            assert data["passed"] is True
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

    def test_mas_log_outcome_computes_runtime_metrics(self):
        """When turn_count is provided, should compute O% and E_c."""

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
                task_type="research",
                architecture_used="centralized_mas_with_verifier",
                decomposability_score=0.5,
                tool_count=4,
                success_score=0.7,
                turn_count=28,
                sas_baseline_turns=7,
            )
            data = json.loads(result)
            metrics = data["runtime_metrics"]
            assert metrics["turn_count"] == 28
            assert metrics["overhead_pct"] == 300.0  # (28-7)/7 * 100
            assert metrics["coordination_efficiency"] is not None
            assert metrics["coordination_efficiency"] == pytest.approx(0.175, abs=0.01)
            # E_c = 0.7 / (28/7) = 0.7 / 4.0 = 0.175
            assert "O%=300" in data["memory_entry"]
            return data

        run(_run())

    def test_mas_log_outcome_no_metrics_when_no_turns(self):
        """Without turn_count, runtime metrics should be None."""

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
                task_type="research",
                architecture_used="SAS",
                success_score=0.9,
            )
            data = json.loads(result)
            metrics = data["runtime_metrics"]
            assert metrics["overhead_pct"] is None
            assert metrics["coordination_efficiency"] is None
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
