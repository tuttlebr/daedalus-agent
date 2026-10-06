"""Main-agent routing policy. No provider settings or conversation state."""

from dataclasses import dataclass
from typing import Annotated, Literal, cast

from nat_helpers.model_profile_types import MODEL_PROFILES, ModelProfile
from pydantic import BaseModel, Field, StringConstraints, model_validator

AutomaticProfile = Literal["default", "deep"]
RouteProfile = Literal["deep", "deep_max"]
RouteAlias = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=256),
]


class ModelRoutingConfig(BaseModel):
    model_routes: dict[RouteProfile, RouteAlias] = Field(default_factory=dict)
    request_model_profiles: dict[Literal["daily_summary"], AutomaticProfile] = Field(
        default_factory=dict
    )
    skill_model_profiles: dict[str, AutomaticProfile] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_model_mappings(self):
        if (
            "deep"
            in (
                *self.request_model_profiles.values(),
                *self.skill_model_profiles.values(),
            )
            and "deep" not in self.model_routes
        ):
            raise ValueError("Automatic deep mappings require model_routes.deep")
        return self


def requested_profile(additional_props: object) -> ModelProfile | None:
    if additional_props is None:
        return None
    if not isinstance(additional_props, dict):
        raise ValueError("additional_props must be an object")
    if "model_profile" not in additional_props:
        return None
    value = additional_props["model_profile"]
    if not isinstance(value, str) or value not in MODEL_PROFILES:
        raise ValueError("model_profile must be default, deep, or deep_max")
    return cast(ModelProfile, value)


@dataclass
class ModelSelection:
    requested: ModelProfile | None = None
    effective: ModelProfile = "default"
    source: Literal["default", "explicit", "request_profile", "skill_load"] = "default"
    promotion_count: int = 0
    triggering_skill: str | None = None

    @classmethod
    def resolve(
        cls, config: ModelRoutingConfig, additional_props: object, request_profile: str
    ):
        requested = requested_profile(additional_props)
        if requested is not None:
            if requested != "default" and requested not in config.model_routes:
                raise ValueError(f"model_profile '{requested}' is not configured")
            return cls(requested=requested, effective=requested, source="explicit")
        mapped = config.request_model_profiles.get(request_profile)
        return cls(
            effective=mapped or "default",
            source="request_profile" if mapped else "default",
        )

    @property
    def explicit(self) -> bool:
        return self.requested is not None

    def skill_loaded(self, event, config: ModelRoutingConfig) -> None:
        # There is no await in this transition: sibling tool tasks share this
        # invocation's object and converge before the graph's next model round.
        if (
            self.explicit
            or self.effective != "default"
            or event.operation != "load_skill"
        ):
            return
        if config.skill_model_profiles.get(event.skill_name) == "deep":
            self.effective = "deep"
            self.source = "skill_load"
            self.promotion_count += 1
            self.triggering_skill = event.skill_name

    def alias(self, config: ModelRoutingConfig, default_alias: str) -> str:
        return (
            default_alias
            if self.effective == "default"
            else config.model_routes[self.effective]
        )

    def metadata(self) -> dict:
        return {
            "requested_model_profile": self.requested or "automatic",
            "effective_model_profile": self.effective,
            "model_selection_source": self.source,
            "model_promotion_count": self.promotion_count,
            "model_triggering_skill": self.triggering_skill,
        }


def validate_skill_mappings(config: ModelRoutingConfig, builder) -> None:
    if not config.skill_model_profiles:
        return
    from agent_skills.agent_skills_function import AgentSkillsConfig

    names: set[str] = set()
    for tool_name in config.tools:
        try:
            tool_config = builder.get_function_config(tool_name)
        except (KeyError, ValueError):
            # Function groups are not skill dispatchers.
            continue
        if isinstance(tool_config, AgentSkillsConfig):
            if (
                tool_config.enabled_operations is None
                or "load_skill" in tool_config.enabled_operations
            ):
                names.update(tool_config.get_parser().get_skill_names())
    invalid = set(config.skill_model_profiles) - names
    if invalid:
        raise ValueError(
            "Unknown or unavailable skill_model_profiles: " + ", ".join(sorted(invalid))
        )
