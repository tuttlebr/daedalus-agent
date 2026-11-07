"""Generated model-profile contract. Edit protocol/model-profile.schema.json."""

from typing import Literal

ModelProfile = Literal[
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "instant",
]

MODEL_PROFILES: tuple[ModelProfile, ...] = (
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "instant",
)
