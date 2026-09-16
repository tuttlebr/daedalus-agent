"""Internal request-scoped notifications; independent of consumers and SDKs."""

from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class SkillLoadEvent:
    skill_name: str
    operation: Literal["load_skill"] = "load_skill"


_LISTENER: ContextVar[Callable[[SkillLoadEvent], None] | None] = ContextVar(
    "skill_load_listener", default=None
)


@contextmanager
def skill_load_scope(listener: Callable[[SkillLoadEvent], None]):
    token = _LISTENER.set(listener)
    try:
        yield
    finally:
        _LISTENER.reset(token)


def main_skill_loaded(skill_name: str) -> None:
    listener = _LISTENER.get()
    if listener is not None:
        listener(SkillLoadEvent(skill_name=skill_name))
