"""Validated contracts for responsibility-driven autonomy.

These contracts deliberately do not accept the retired research-feed output or
configuration. External observations are data; only operator configuration can
enable a responsibility or change its authority.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

TIMEZONE = "America/Detroit"
EASTERN = ZoneInfo(TIMEZONE)
Text = Annotated[str, StringConstraints(min_length=1, max_length=4000, pattern=r"\S")]
Identifier = Annotated[
    str, StringConstraints(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_.:-]+$")
]
Responsibility = Literal["calendar", "lighting", "cluster", "evolution"]
TaskKind = Literal[
    "calendar_discovery",
    "calendar_event",
    "sports_discovery",
    "game_lighting",
    "cluster_maintenance",
    "evolution",
    "daily_summary",
]
OutcomeStatus = Literal["completed", "partial", "failed", "deferred", "uncertain"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)


class ResponsibilityConfig(Contract):
    enabled: bool = True
    intervalSeconds: int = Field(default=3600, ge=300, le=604800)
    instructions: str = Field(default="", max_length=4000)
    # Python weekday numbering: Monday=0, Sunday=6. Months are inclusive.
    weekdays: list[Annotated[int, Field(ge=0, le=6)]] = Field(
        default_factory=lambda: list(range(7)), min_length=1, max_length=7
    )
    months: list[Annotated[int, Field(ge=1, le=12)]] = Field(
        default_factory=lambda: list(range(1, 13)), min_length=1, max_length=12
    )

    @field_validator("weekdays", "months")
    @classmethod
    def unique_window(cls, values: list[int]) -> list[int]:
        if len(set(values)) != len(values):
            raise ValueError("Window values must be unique")
        return values


class CalendarConfig(ResponsibilityConfig):
    intervalSeconds: int = Field(default=21600, ge=300, le=604800)
    calendarId: str = Field(default="", max_length=512)
    sources: list[str] = Field(
        default_factory=lambda: ["https://www.salinemi.gov/newslist.php"],
        min_length=1,
        max_length=30,
    )
    preferences: str = Field(default="", max_length=4000)
    reminderMinutes: list[int] = Field(default_factory=list, max_length=5)

    @field_validator("sources")
    @classmethod
    def public_sources(cls, values: list[str]) -> list[str]:
        for value in values:
            validate_source_url(value)
        return list(dict.fromkeys(values))

    @field_validator("reminderMinutes")
    @classmethod
    def reminder_bounds(cls, values: list[int]) -> list[int]:
        if any(value < 0 or value > 40320 for value in values):
            raise ValueError("Reminder minutes must be between zero and four weeks")
        return sorted(set(values))


class GameLightingConfig(ResponsibilityConfig):
    intervalSeconds: int = Field(default=21600, ge=300, le=604800)
    scene: str = Field(default="Go Green!", min_length=1, max_length=160)
    catchUpMinutes: int = Field(default=15, ge=0, le=60)
    # Empty means all household lights discoverable through the configured tool.
    lightIds: list[str] = Field(default_factory=list, max_length=500)
    team: str = Field(default="Michigan State", min_length=1, max_length=160)
    sports: list[Literal["football", "mens_basketball"]] = Field(
        default_factory=lambda: ["football", "mens_basketball"],
        min_length=1,
        max_length=2,
    )


class LightingRule(GameLightingConfig):
    id: Identifier
    title: Annotated[str, StringConstraints(min_length=1, max_length=80)]


class LightingConfig(GameLightingConfig):
    rules: list[LightingRule] = Field(default_factory=list, max_length=20)

    @field_validator("rules")
    @classmethod
    def unique_rules(cls, rules: list[LightingRule]) -> list[LightingRule]:
        if len({rule.id for rule in rules}) != len(rules):
            raise ValueError("Lighting rule IDs must be unique")
        return rules


class ClusterConfig(ResponsibilityConfig):
    intervalSeconds: int = Field(default=900, ge=300, le=604800)
    contexts: list[str] = Field(default_factory=list, max_length=30)
    excludedNamespaces: list[str] = Field(default_factory=list, max_length=100)
    configurationSource: Literal["cluster_managed"] = "cluster_managed"
    lanVerificationSource: str = Field(default="", max_length=2000)
    maintenancePolicy: str = Field(default="", max_length=4000)


class Responsibilities(Contract):
    calendar: CalendarConfig = Field(default_factory=CalendarConfig)
    lighting: LightingConfig = Field(default_factory=LightingConfig)
    cluster: ClusterConfig = Field(default_factory=ClusterConfig)
    evolution: ResponsibilityConfig = Field(
        default_factory=lambda: ResponsibilityConfig(intervalSeconds=86400)
    )


class SummaryConfig(Contract):
    time: str = Field(default="18:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    destination: Literal["autonomy_dashboard"] = "autonomy_dashboard"


class CharterConfig(Contract):
    version: Literal[2] = 2
    enabled: bool = True
    timezone: Literal["America/Detroit"] = TIMEZONE
    responsibilities: Responsibilities = Field(default_factory=Responsibilities)
    summary: SummaryConfig = Field(default_factory=SummaryConfig)
    # New kinds of actions require user activation. Model output cannot set this.
    expansionPolicy: Literal["propose"] = "propose"
    maxToolCalls: int = Field(default=40, ge=5, le=100)
    maxRunSeconds: int = Field(default=600, ge=60, le=1800)
    maxAttempts: int = Field(default=3, ge=1, le=5)
    maxPendingActions: int = Field(default=500, ge=10, le=2000)
    maxRunsStored: int = Field(default=500, ge=10, le=2000)
    maxSummariesStored: int = Field(default=90, ge=7, le=365)

    @model_validator(mode="after")
    def queue_capacity(self) -> CharterConfig:
        if self.maxPendingActions <= len(self.responsibilities.lighting.rules) + 5:
            raise ValueError("Leave queue capacity for discovery and game actions")
        return self


def validate_source_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or len(value) > 2048
    ):
        raise ValueError("A source must have an HTTP(S) URL without credentials")
    return value


def instant(value: str) -> datetime:
    """Reject naive instants rather than silently applying the host timezone."""
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("A timed event must include its UTC offset")
    return result


class CalendarEvent(Contract):
    sourceKey: Identifier
    sourceUrl: str
    title: Annotated[str, StringConstraints(min_length=1, max_length=300)]
    description: str = Field(default="", max_length=4000)
    applicability: Text
    allDay: bool
    # Date-only strings for all-day events; explicit offsets for timed events.
    # End is exclusive, including for multi-day collection windows.
    start: str
    end: str
    cancelled: bool = False

    _source = field_validator("sourceUrl")(validate_source_url)

    @model_validator(mode="after")
    def valid_dates(self) -> CalendarEvent:
        if self.allDay:
            start, end = date.fromisoformat(self.start), date.fromisoformat(self.end)
            if self.start != start.isoformat() or self.end != end.isoformat():
                raise ValueError("All-day events require ISO dates")
        else:
            start, end = instant(self.start), instant(self.end)
        if end <= start:
            raise ValueError("Event end must follow its start")
        return self

    def is_past(self, timestamp: int) -> bool:
        local = datetime.fromtimestamp(timestamp / 1000, EASTERN)
        if self.allDay:
            return date.fromisoformat(self.end) <= local.date()
        return instant(self.end) <= local

    def calendar_times(self) -> dict:
        if self.allDay:
            return {"start": {"date": self.start}, "end": {"date": self.end}}
        return {
            field: {
                "dateTime": instant(getattr(self, field))
                .astimezone(EASTERN)
                .isoformat(),
                "timeZone": TIMEZONE,
            }
            for field in ("start", "end")
        }


class Game(Contract):
    sourceKey: Identifier
    sourceUrl: str
    sport: Literal["football", "mens_basketball"]
    opponent: Annotated[str, StringConstraints(min_length=1, max_length=160)]
    start: str
    status: Literal["scheduled", "cancelled", "completed", "postponed"]

    _source = field_validator("sourceUrl")(validate_source_url)

    @field_validator("start")
    @classmethod
    def valid_start(cls, value: str) -> str:
        instant(value)
        return value


class Evidence(Contract):
    description: Text
    reference: str = Field(default="", max_length=2048)


class ActionOutcome(Contract):
    status: OutcomeStatus
    summary: Text
    # The runtime overwrites this field from actual dispatch history.
    mutationAttempted: bool = False
    evidence: list[Evidence] = Field(default_factory=list, max_length=30)
    externalId: str = Field(default="", max_length=512)
    # Captured remote state enables reconciliation while respecting user edits.
    observedState: dict = Field(default_factory=dict)
    skipped: list[str] = Field(default_factory=list, max_length=500)
    recommendations: list[Text] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def verified_completion(self) -> ActionOutcome:
        if self.status in {"completed", "partial"} and not self.evidence:
            raise ValueError("Completion requires verification evidence")
        if len(json.dumps(self.observedState, ensure_ascii=False).encode()) > 32768:
            raise ValueError(
                "Observed state must be a bounded normalized event, not raw tool output"
            )
        return self


class Proposal(Contract):
    id: Identifier
    title: Annotated[str, StringConstraints(min_length=1, max_length=160)]
    benefit: Text
    trigger: Text
    requiredAccess: Text
    actions: Text
    limits: Text


class CharterOutput(Contract):
    outcome: ActionOutcome
    calendarEvents: list[CalendarEvent] = Field(default_factory=list, max_length=50)
    games: list[Game] = Field(default_factory=list, max_length=100)
    proposals: list[Proposal] = Field(default_factory=list, max_length=5)
    notes: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def unique_observations(self) -> CharterOutput:
        for identities in (
            [event.sourceKey for event in self.calendarEvents],
            [(game.sport, game.sourceKey) for game in self.games],
            [proposal.id for proposal in self.proposals],
        ):
            if len(identities) != len(set(identities)):
                raise ValueError("Each observation identity must occur once per result")
        return self


def stable_id(kind: str, identity: str) -> str:
    digest = hashlib.sha256(f"{kind}:{identity}".encode()).hexdigest()[:32]
    return f"{kind}:{digest}"


def revision(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:32]


TASK_RESPONSIBILITY: dict[str, str] = {
    "calendar_discovery": "calendar",
    "calendar_event": "calendar",
    "sports_discovery": "lighting",
    "game_lighting": "lighting",
    "cluster_maintenance": "cluster",
    "evolution": "evolution",
}


def task_settings(config: CharterConfig, kind: str, payload: dict | None = None):
    name = TASK_RESPONSIBILITY.get(kind)
    if not name:
        return None
    settings = getattr(config.responsibilities, name)
    rule_id = (payload or {}).get("ruleId")
    if name == "lighting" and rule_id:
        return next((rule for rule in settings.rules if rule.id == rule_id), None)
    return settings


def in_window(settings: ResponsibilityConfig, timestamp: int) -> bool:
    local = datetime.fromtimestamp(timestamp / 1000, EASTERN)
    return local.weekday() in settings.weekdays and local.month in settings.months


def task_note_key(task: dict) -> str:
    rule_id = task.get("payload", {}).get("ruleId")
    return f"lighting:{rule_id}" if rule_id else task["responsibility"]


def task_enabled(
    config: CharterConfig,
    kind: str,
    payload: dict | None = None,
    timestamp: int | None = None,
) -> bool:
    if not config.enabled:
        return False
    if kind == "daily_summary":
        return True
    name = TASK_RESPONSIBILITY.get(kind)
    settings = task_settings(config, kind, payload)
    return bool(
        name
        and getattr(config.responsibilities, name).enabled
        and settings
        and settings.enabled
        and (timestamp is None or in_window(settings, timestamp))
    )
