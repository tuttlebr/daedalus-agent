"""Generated model-profile contract. Edit protocol/model-profile.schema.json."""

from typing import Literal

ModelProfile = Literal[
    "default",
    "deep",
    "deep_max",
]

MODEL_PROFILES: tuple[ModelProfile, ...] = (
    "default",
    "deep",
    "deep_max",
)
