"""Deterministic policy, isolation and trusted-dispatch tests."""

import asyncio
from types import SimpleNamespace

import pytest
from agent_skills.agent_skills_function import (
    AgentSkillsConfig,
    _list_skills,
    _load_skill,
)
from agent_skills.load_events import SkillLoadEvent, skill_load_scope
from nat_helpers.agent_loop_guard import agent_run_scope, current_agent_run
from nat_helpers.model_routing import (
    ModelRoutingConfig,
    ModelSelection,
    validate_skill_mappings,
)
from pydantic import ValidationError


def policy(**kwargs):
    return ModelRoutingConfig(
        model_routes={"deep": "test/deep", "deep_max": "test/max"},
        request_model_profiles={"daily_summary": "deep"},
        skill_model_profiles={"heavy": "deep", "light": "default"},
        **kwargs,
    )


@pytest.mark.parametrize(
    "bad", [None, "", "automatic", "daedalus/max", "DEEP", " deep", 1, True, {}, []]
)
def test_explicit_selection_rejects_invalid_json(bad):
    with pytest.raises(ValueError, match="model_profile"):
        ModelSelection.resolve(policy(), {"model_profile": bad}, "default")


@pytest.mark.parametrize(
    "profile,alias",
    [("default", "original"), ("deep", "test/deep"), ("deep_max", "test/max")],
)
def test_explicit_profile_wins_over_request_and_skill_policy(profile, alias):
    config = policy()
    selection = ModelSelection.resolve(
        config, {"model_profile": profile, "unrelated": 7}, "daily_summary"
    )
    selection.skill_loaded(SkillLoadEvent("heavy"), config)
    assert selection.alias(config, "original") == alias
    assert selection.explicit
    assert selection.source == "explicit"
    assert selection.promotion_count == 0


def test_optional_configuration_and_unconfigured_explicit_profile():
    config = ModelRoutingConfig()
    for props in (None, {}, {"enableIntermediateSteps": True}):
        selected = ModelSelection.resolve(config, props, "daily_summary")
        assert (
            selected.alias(config, "any-compatible-gateway") == "any-compatible-gateway"
        )
    for profile in ("deep", "deep_max"):
        with pytest.raises(ValueError, match="not configured"):
            ModelSelection.resolve(config, {"model_profile": profile}, "default")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"model_routes": {"default": "alias"}},
        {"model_routes": {"unknown": "alias"}},
        {"model_routes": {"deep": "   "}},
        {"model_routes": {"deep": 123}},
        {"request_model_profiles": {"research": "default"}},
        {"request_model_profiles": {"daily_summary": "deep"}},
        {"request_model_profiles": {"daily_summary": "deep_max"}},
        {"skill_model_profiles": {"heavy": "deep"}},
        {"skill_model_profiles": {"heavy": "deep_max"}},
    ],
)
def test_invalid_configuration_fails(kwargs):
    with pytest.raises(ValidationError):
        ModelRoutingConfig(**kwargs)


def test_initial_mapping_is_independent_of_monotonic_skill_promotion():
    config = policy()
    summary = ModelSelection.resolve(config, {}, "daily_summary")
    assert (summary.effective, summary.source) == ("deep", "request_profile")
    selection = ModelSelection.resolve(config, {}, "default")
    selection.skill_loaded(SkillLoadEvent("unmapped"), config)
    assert selection.effective == "default"
    for name in ("heavy", "light", "heavy"):
        selection.skill_loaded(SkillLoadEvent(name), config)
    assert (selection.effective, selection.source, selection.promotion_count) == (
        "deep",
        "skill_load",
        1,
    )
    assert selection.triggering_skill == "heavy"
    assert ModelSelection.resolve(config, {}, "default").effective == "default"


def test_parallel_loads_share_only_their_invocation():
    async def scenario():
        config = policy()

        async def request(explicit):
            with agent_run_scope() as run:
                run.model_selection = ModelSelection.resolve(
                    config, explicit, "default"
                )

                async def load(name):
                    await asyncio.sleep(0)
                    assert current_agent_run() is run
                    run.model_selection.skill_loaded(SkillLoadEvent(name), config)

                await asyncio.gather(load("heavy"), load("light"), load("heavy"))
                return run.model_selection

        selected = await asyncio.gather(
            request({}),
            request({"model_profile": "default"}),
            request({"model_profile": "deep_max"}),
        )
        assert [s.effective for s in selected] == ["deep", "default", "deep_max"]
        assert [s.promotion_count for s in selected] == [1, 0, 0]
        assert current_agent_run() is None

    asyncio.run(scenario())


def test_only_successful_main_load_notifies_and_output_is_preserved(
    tmp_path, monkeypatch
):
    directory = tmp_path / "heavy"
    directory.mkdir()
    (directory / "SKILL.md").write_text(
        "---\nname: heavy\ndescription: Test\n---\nInstructions."
    )
    (directory / "reference.md").write_text("Reference.")
    config = AgentSkillsConfig(skills_directory=str(tmp_path))
    parser = config.get_parser()
    events = []

    async def scenario():
        with skill_load_scope(events.append):
            await _list_skills(parser)
            assert await _load_skill(parser, "heavy", "reference.md") == "Reference."
            assert "not found" in await _load_skill(parser, "missing")
            assert "Error:" in await _load_skill(parser, "heavy", "missing.md")
            assert not events
            output = await _load_skill(parser, "heavy")
            assert output.startswith("Instructions.") and "reference.md" in output
            assert events == [SkillLoadEvent("heavy")]
            events.clear()

            def fail(_):
                raise ValueError("Cannot list resources")

            monkeypatch.setattr(parser, "list_skill_resources", fail)
            assert await _load_skill(parser, "heavy") == "Error: Cannot list resources"
            assert not events

    asyncio.run(scenario())


def test_skill_mappings_validate_against_dispatcher_catalog(tmp_path):
    skills = AgentSkillsConfig(skills_directory=str(tmp_path))
    config = SimpleNamespace(tools=["skills"], skill_model_profiles={"typo": "default"})
    builder = SimpleNamespace(get_function_config=lambda _: skills)
    with pytest.raises(ValueError, match="typo"):
        validate_skill_mappings(config, builder)
