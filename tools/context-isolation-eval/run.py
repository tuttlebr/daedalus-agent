#!/usr/bin/env python3
"""Run bounded, synthetic briefing comparisons through an existing runtime image.

The default is a plan: no Docker process, provider request, or credential lookup
is needed. Execution produces unreviewed measurements and local capture files.
Independent, hash-bound editorial and privacy reviews are required before the
comparator can accept those measurements. No live user source is connected.
"""

from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import ipaddress
import json
import math
import os
import re
import sys
import threading
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORKLOAD = HERE / "workload.json"
ROLES = frozenset({"baseline", "local", "medium", "high", "xhigh"})
PRIVACY_CHECKS = tuple(f"AC-{number:02d}" for number in range(1, 9))
REVIEW_EVIDENCE_REFS = ("fixture.manifest", "capture.source_calls")
PROHIBITED = frozenset(
    {
        "chat_history",
        "previous_response_id",
        "conversation",
        "conversation_id",
        "attachments",
        "private_profile",
        "credentials",
        "metadata",
        "system_prompt",
    }
)


class RunnerError(ValueError):
    """Fixed diagnostics only: never interpolate provider payloads or secrets."""


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def redact(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[credential omitted]")
        return value
    if isinstance(value, dict):
        return {
            redact(key, secrets): redact(item, secrets) for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    return value


def credential_free_config(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: credential_free_config(item)
            for key, item in value.items()
            if key.lower()
            not in {
                "api_key",
                "api_token",
                "access_token",
                "refresh_token",
                "token",
                "password",
                "client_secret",
                "secret",
                "authorization",
            }
        }
    if isinstance(value, list):
        return [credential_free_config(item) for item in value]
    return value


class AttemptBudget:
    """A single ceiling shared by both variants, every case, and all retries."""

    def __init__(self, max_model_attempts: int, timeout_seconds: float):
        if type(max_model_attempts) is not int or max_model_attempts <= 0:
            raise RunnerError("a positive integer model-attempt ceiling is required")
        if (
            type(timeout_seconds) not in (int, float)
            or not math.isfinite(timeout_seconds)
            or timeout_seconds <= 0
        ):
            raise RunnerError("a finite positive execution deadline is required")
        self.maximum = max_model_attempts
        self.deadline = time.monotonic() + timeout_seconds
        self._count = 0
        self._lock = threading.Lock()

    @property
    def count(self) -> int:
        with self._lock:
            return self._count

    def remaining(self) -> float:
        return max(0.0, self.deadline - time.monotonic())

    def reserve(self) -> str:
        with self._lock:
            if self.remaining() <= 0:
                raise RunnerError("global evaluation deadline exhausted")
            if self._count >= self.maximum:
                raise RunnerError("global model-attempt ceiling exhausted")
            self._count += 1
            return uuid.uuid4().hex


@dataclass(frozen=True)
class Route:
    role: str
    base_url: str
    api_type: str
    model_name: str
    api_key_env: str
    trust: str
    extra_body: dict[str, Any] = field(default_factory=dict)
    model_revision: str | None = None
    secret: str = field(default="", repr=False, compare=False)

    def public(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "base_url": self.base_url,
            "api_type": self.api_type,
            "model_name": self.model_name,
            "api_key_env": self.api_key_env,
            "trust": self.trust,
            "extra_body": self.extra_body,
            "model_revision": self.model_revision,
        }


def load_routes(path: Path, environ: Mapping[str, str]) -> dict[str, Route]:
    try:
        config = json.loads(path.read_text())
        if set(config) != {"schema_version", "routes"} or config["schema_version"] != 1:
            raise RunnerError("unsupported route configuration")
        if set(config["routes"]) != ROLES:
            raise RunnerError(
                "baseline, local, medium, high and xhigh routes are required"
            )
        result = {}
        required = {"base_url", "api_type", "model_name", "api_key_env", "trust"}
        optional = {"extra_body", "model_revision"}
        for role, raw in config["routes"].items():
            if (
                not isinstance(raw, dict)
                or not required <= set(raw) <= required | optional
            ):
                raise RunnerError("route fields must use the bounded route schema")
            url = urlsplit(raw["base_url"])
            if (
                url.scheme not in {"http", "https"}
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
            ):
                raise RunnerError(
                    "provider origins must exclude credentials and parameters"
                )
            _ = url.port
            if raw["api_type"] not in {"responses", "chat"}:
                raise RunnerError("unsupported provider API type")
            if not isinstance(raw["model_name"], str) or not raw["model_name"].strip():
                raise RunnerError("a configured model identity is required")
            if raw["trust"] not in {"trusted_local", "approved_cloud"}:
                raise RunnerError("unknown provider trust designation")
            if role == "local" and raw["trust"] != "trusted_local":
                raise RunnerError(
                    "the coordinator requires a trusted local destination"
                )
            try:
                address = ipaddress.ip_address(url.hostname)
                private = address.is_private and not address.is_unspecified
            except ValueError:
                private = url.hostname == "localhost" or url.hostname.endswith(
                    ".svc.cluster.local"
                )
            if raw["trust"] == "trusted_local" and not private:
                raise RunnerError(
                    "trusted local routes require an explicit local origin"
                )
            if url.scheme == "http" and raw["trust"] == "approved_cloud":
                if url.hostname != "localhost" and url.hostname not in {
                    "127.0.0.1",
                    "::1",
                }:
                    raise RunnerError("external provider transport requires HTTPS")
            variable = raw["api_key_env"]
            if not isinstance(variable, str) or not re.fullmatch(
                r"[A-Z_][A-Z0-9_]*", variable
            ):
                raise RunnerError(
                    "credentials must be referenced by environment variable"
                )
            secret = environ.get(variable, "")
            if not secret or any(char in secret for char in "\r\n\0"):
                raise RunnerError(
                    "a provider credential environment variable is unavailable"
                )
            if secret in json.dumps(raw):
                raise RunnerError(
                    "credential values cannot appear in public route configuration"
                )
            extra = raw.get("extra_body", {})
            if not isinstance(extra, dict) or set(extra) - {
                "reasoning_effort",
                "reasoning",
                "verbosity",
                "temperature",
                "top_p",
                "chat_template_kwargs",
                "thinking_token_budget",
            }:
                raise RunnerError(
                    "provider options cannot replace context or routing fields"
                )
            if "thinking_token_budget" in extra and (
                type(extra["thinking_token_budget"]) is not int
                or not 0 <= extra["thinking_token_budget"] <= 8192
            ):
                raise RunnerError(
                    "thinking token budget must be an integer from 0 to 8192"
                )
            if "thinking_token_budget" in extra and raw["api_type"] != "chat":
                raise RunnerError("thinking token budget requires the Chat API")
            if "reasoning" in extra and (
                not isinstance(extra["reasoning"], dict)
                or set(extra["reasoning"]) != {"effort"}
            ):
                raise RunnerError("reasoning options must declare only effort")
            if "chat_template_kwargs" in extra:
                if raw["api_type"] != "chat":
                    raise RunnerError("chat template options require the Chat API")
                template = extra["chat_template_kwargs"]
                if not isinstance(template, dict) or set(template) - {
                    "enable_thinking",
                    "medium_effort",
                }:
                    raise RunnerError(
                        "chat template options must be bounded capability settings"
                    )
                if type(template.get("enable_thinking")) is not bool or (
                    "medium_effort" in template
                    and type(template["medium_effort"]) is not bool
                ):
                    raise RunnerError("chat thinking settings must be boolean")
            effort = extra.get(
                "reasoning_effort", extra.get("reasoning", {}).get("effort")
            )
            if effort is not None and effort not in {
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
            }:
                raise RunnerError("unknown reasoning effort")
            if "verbosity" in extra and extra["verbosity"] not in {
                "low",
                "medium",
                "high",
            }:
                raise RunnerError("unknown verbosity")
            for key in {"temperature", "top_p"} & set(extra):
                if (
                    type(extra[key]) not in {int, float}
                    or not math.isfinite(extra[key])
                    or not 0 <= extra[key] <= 2
                ):
                    raise RunnerError("invalid numeric provider option")
            revision = raw.get("model_revision")
            if revision is not None and (
                not isinstance(revision, str) or not revision.strip()
            ):
                raise RunnerError("model revision must be an identity or null")
            result[role] = Route(role=role, secret=secret, **raw)
        return result
    except RunnerError:
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise RunnerError("route configuration could not be validated") from None


def load_credential_environment(
    paths: list[Path], environ: Mapping[str, str]
) -> dict[str, str]:
    """Load explicit dotenv inputs as data; never source a shell or write keys."""
    values = dict(environ)
    try:
        for path in paths:
            for raw in path.read_text().splitlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                key, separator, value = line.removeprefix("export ").partition("=")
                key, value = key.strip(), value.strip()
                if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                    raise RunnerError(
                        "credential environment input is not a dotenv mapping"
                    )
                if value.startswith(("'", '"')):
                    value = ast.literal_eval(value)
                    if not isinstance(value, str):
                        raise RunnerError(
                            "credential environment values must be strings"
                        )
                else:
                    value = value.split(" #", 1)[0].rstrip()
                values.setdefault(key, value)
        return values
    except RunnerError:
        raise
    except (OSError, SyntaxError, ValueError, TypeError):
        raise RunnerError("credential environment input could not be loaded") from None


def scan_external_request(
    body: dict[str, Any], private_fragments: list[str]
) -> list[str]:
    """A capture check in addition to runtime enforcement, never a redactor."""
    diagnostics = set()
    serialized = json.dumps(body, ensure_ascii=False)
    if any(fragment and fragment in serialized for fragment in private_fragments):
        diagnostics.add("private_fixture_content")

    def visit(value: Any, depth: int = 0) -> None:
        if depth > 40:
            diagnostics.add("context_nesting_limit")
            return
        if isinstance(value, dict):
            if PROHIBITED & set(value):
                diagnostics.add("prohibited_context_field")
            for item in value.values():
                visit(item, depth + 1)
        elif isinstance(value, list):
            for item in value:
                visit(item, depth + 1)
        elif isinstance(value, str) and value.lstrip().startswith(("{", "[")):
            try:
                embedded = json.loads(value)
            except (ValueError, RecursionError):
                return
            visit(embedded, depth + 1)

    visit(body)
    if "user" in body and not re.fullmatch(r"[0-9a-f]{64}", str(body["user"])):
        diagnostics.add("nonopaque_provider_identity")
    return sorted(diagnostics)


def private_fragments(case: dict[str, Any]) -> list[str]:
    result = []
    for value in case.get("local_inputs", {}).values():
        if isinstance(value, str) and value:
            result.append(value)
            # Also check markers independently of surrounding explanatory text.
            result.extend(re.findall(r"PRIVATE_[A-Z0-9_]+", value))
        elif isinstance(value, dict) and isinstance(value.get("text"), str):
            result.extend(
                [value["text"], *re.findall(r"PRIVATE_[A-Z0-9_]+", value["text"])]
            )
    return result


def make_synthetic_bundle(destination: Path) -> dict[str, str]:
    """Copy reviewed canonical mechanics with wholly fictional personalization."""
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    from synthetic_skill import build_bundle

    return build_bundle(ROOT / "skills/daily-summary", destination)


def _counts(observations: Any, field: str) -> tuple[int, int]:
    if not isinstance(observations, list) or any(
        not isinstance(item, dict)
        or type(item.get(field)) is not bool
        or not isinstance(item.get("reason"), str)
        or not item["reason"].strip()
        for item in observations
    ):
        raise RunnerError("reviewed observations require boolean decisions and reasons")
    return sum(item[field] for item in observations), len(observations)


def _unbound_measurements(measurements: dict[str, Any]) -> dict[str, Any]:
    """Recover the exact observation document before evidence annotations."""
    original = copy.deepcopy(measurements)
    binding = original.pop("review_evidence_binding", None)
    for row in original.get("cases", []):
        refs = row.get("evidence_refs", [])
        if any(
            ref.startswith(("fixture.", "capture.")) and ref not in REVIEW_EVIDENCE_REFS
            for ref in refs
        ):
            raise RunnerError("unknown reserved review evidence identity")
        reserved = [ref for ref in refs if ref in REVIEW_EVIDENCE_REFS]
        evidence = row.pop("review_evidence", None)
        if binding is None:
            if reserved or evidence is not None:
                raise RunnerError("review evidence has no artifact binding")
            continue
        if reserved != list(REVIEW_EVIDENCE_REFS) or not isinstance(evidence, dict):
            raise RunnerError("review evidence binding is incomplete")
        if set(evidence) != set(REVIEW_EVIDENCE_REFS):
            raise RunnerError("review evidence binding has unknown identities")
        for identity, item in evidence.items():
            if (
                item.get("identity") != identity
                or item.get("case_id") != row["case_id"]
                or item.get("repetition") != row["repetition"]
                or item.get("variant") != measurements["variant"]
                or item.get("workload_sha256") != measurements["workload_sha256"]
            ):
                raise RunnerError("review evidence identity does not match case")
        row["evidence_refs"] = [ref for ref in refs if ref not in REVIEW_EVIDENCE_REFS]
    if binding is not None:
        if (
            binding.get("schema_version") != 1
            or binding.get("artifact_manifest_sha256")
            != measurements["privacy_evidence"]["artifact_sha256"]
            or binding.get("original_measurements_sha256") != digest(original)
            or binding.get("descriptors_sha256")
            != digest([row["review_evidence"] for row in measurements["cases"]])
        ):
            raise RunnerError("review evidence does not match measured artifacts")
    return original


def bind_review_evidence(
    measurements: dict[str, Any], artifact_directory: Path
) -> dict[str, Any]:
    """Annotate pending observations using only verified archived local files.

    The manifest proves supplied fixture scope, not real account emptiness.
    Source calls prove only recorded calls/outcomes, not that a missing call ran.
    """
    try:
        if (
            measurements.get("review_status") != "pending"
            or measurements.get("review_evidence_binding") is not None
        ):
            raise RunnerError("only unbound pending measurements can be annotated")
        original = _unbound_measurements(measurements)
        root = artifact_directory.resolve()
        manifest = json.loads((root / "artifacts.json").read_text())
        manifest_hash = digest(manifest)
        if (
            manifest_hash != measurements["privacy_evidence"]["artifact_sha256"]
            or manifest["workload_sha256"] != measurements["workload_sha256"]
        ):
            raise RunnerError("review artifact manifest does not match measurements")

        def archived(relative: str) -> tuple[dict[str, Any], str]:
            path = (root / relative).resolve()
            if not path.is_relative_to(root) or Path(relative).is_absolute():
                raise RunnerError("review artifact path is outside its archive")
            payload = path.read_bytes()
            checksum = hashlib.sha256(payload).hexdigest()
            if checksum != manifest["files"][relative]:
                raise RunnerError("review artifact checksum does not match manifest")
            return json.loads(payload), checksum

        workload, workload_file_hash = archived("workload.json")
        if digest(workload) != measurements["workload_sha256"]:
            raise RunnerError("review fixture does not match measured workload")
        cases = {case["id"]: case for case in workload["cases"]}
        result = copy.deepcopy(original)
        for row in result["cases"]:
            case = cases[row["case_id"]]
            expected_refs = [source["id"] for source in case["public_sources"]] + [
                "local." + key for key in case.get("local_inputs", {})
            ]
            if (
                row["evidence_refs"] != expected_refs
                or row["required_facts"] != case["required_facts"]
            ):
                raise RunnerError("case evidence does not match the frozen fixture")
            expected_capture = f"{measurements['variant']}-{row['case_id']}-{row['repetition']}/capture.json"
            if row["capture_file"] != expected_capture:
                raise RunnerError("capture identity does not match the measured case")
            capture, capture_hash = archived(row["capture_file"])
            source_calls = capture["source_calls"]
            if not isinstance(source_calls, list) or any(
                not isinstance(call, dict) for call in source_calls
            ):
                raise RunnerError("source-call capture is missing or malformed")
            common = {
                "case_id": row["case_id"],
                "repetition": row["repetition"],
                "variant": measurements["variant"],
                "workload_sha256": measurements["workload_sha256"],
            }
            row["review_evidence"] = {
                "fixture.manifest": {
                    **common,
                    "identity": "fixture.manifest",
                    "kind": "frozen_case_manifest",
                    "artifact_file": "workload.json",
                    "artifact_sha256": workload_file_hash,
                    "case_sha256": digest(case),
                    "scope": "Supplied fictional inputs, source inventory and fault declarations; absent input is not an empty real account.",
                },
                "capture.source_calls": {
                    **common,
                    "identity": "capture.source_calls",
                    "kind": "recorded_case_source_calls",
                    "artifact_file": row["capture_file"],
                    "artifact_sha256": capture_hash,
                    "source_calls_sha256": digest(source_calls),
                    "source_call_count": len(source_calls),
                    "tool_result_scope": "Provider-visible tool results are in the same capture. An invocation alone is not a successful read.",
                    "scope": "Only recorded calls and outcomes. No call or empty results do not establish real-world completeness or account emptiness.",
                },
            }
            row["evidence_refs"].extend(REVIEW_EVIDENCE_REFS)
        result["review_evidence_binding"] = {
            "schema_version": 1,
            "original_measurements_sha256": digest(original),
            "artifact_manifest_sha256": manifest_hash,
            "descriptors_sha256": digest(
                [row["review_evidence"] for row in result["cases"]]
            ),
            "postprocessor_source_sha256": hashlib.sha256(
                Path(__file__).read_bytes()
            ).hexdigest(),
            "scope": "Review-only local annotation; observed model/configuration identities, captures, source calls, costs, timings and quality decisions are unchanged.",
        }
        return result
    except RunnerError:
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise RunnerError("review artifacts could not be bound") from None


def verify_review_evidence(
    measurements: dict[str, Any], artifact_directory: Path
) -> None:
    """Recheck the archive before CLI review application, including old pilots."""
    original = _unbound_measurements(measurements)
    if "review_evidence_binding" not in measurements:
        return
    expected = bind_review_evidence(original, artifact_directory)
    if any(
        actual["review_evidence"] != wanted["review_evidence"]
        for actual, wanted in zip(measurements["cases"], expected["cases"])
    ):
        raise RunnerError("review evidence no longer matches archived observations")


def _apply_reviews(
    measurements: dict[str, Any], review: dict[str, Any]
) -> dict[str, Any]:
    """Bind independent claim/fact/citation judgments to exact observed output."""
    if review.get("measurements_sha256") != digest(measurements):
        raise RunnerError("review does not match the measured artifact")
    _unbound_measurements(measurements)
    if (
        review.get("schema_version") != 1
        or not isinstance(review.get("reviewer"), str)
        or not review["reviewer"].strip()
    ):
        raise RunnerError("independent review identity is required")
    if review.get("all_claims_and_citations_reviewed") is not True:
        raise RunnerError("review must explicitly cover the entire delivered output")
    result = copy.deepcopy(measurements)
    if result.get("configuration", {}).get("runner_sources_unchanged") is False:
        raise RunnerError("runner source changed during the observed evaluation")
    privacy = review.get("privacy_evidence", {})
    if privacy.get("artifact_sha256") != result.get("privacy_evidence", {}).get(
        "artifact_sha256"
    ) or any(type(privacy.get(key)) is not bool for key in PRIVACY_CHECKS):
        raise RunnerError("privacy review must bind every check to captured artifacts")
    if result.get("variant") == "candidate" and result.get("automatic_privacy", {}).get(
        "violation_count", 0
    ):
        if privacy["AC-01"]:
            raise RunnerError(
                "review cannot override observed candidate privacy violations"
            )
    result["privacy_evidence"] = {**privacy, "reviewer": review["reviewer"]}
    records = review.get("cases", [])
    by_key = {(row.get("case_id"), row.get("repetition")): row for row in records}
    if len(by_key) != len(records) or len(records) != len(result["cases"]):
        raise RunnerError("review must include each observed case exactly once")
    for case in result["cases"]:
        item = by_key.get((case["case_id"], case["repetition"]))
        if not item or item.get("output_sha256") != case["output_sha256"]:
            raise RunnerError("case review does not match the delivered output")
        claims = item.get("claims", [])
        supported, total_claims = _counts(claims, "supported")
        for claim in claims:
            if not isinstance(claim.get("text"), str) or not claim["text"].strip():
                raise RunnerError("review must identify each factual claim")
            references = claim.get("evidence_refs", [])
            if not isinstance(references, list) or any(
                not isinstance(ref, str) for ref in references
            ):
                raise RunnerError(
                    "claim evidence references must be a list of identities"
                )
            if claim["supported"] and not references:
                raise RunnerError("supported claims require evidence references")
            if any(
                ref not in case["evidence_refs"]
                for ref in claim.get("evidence_refs", [])
            ):
                raise RunnerError("claim evidence reference is not in this frozen case")
        facts = item.get("required_facts", [])
        present, total_facts = _counts(facts, "present")
        if [row.get("fact") for row in facts] != case["required_facts"]:
            raise RunnerError("review must score every frozen required fact in order")
        citations = item.get("citations", [])
        correct, total_citations = _counts(citations, "correct")
        for citation in citations:
            if "tool_ref" in citation:
                if "url" in citation or not isinstance(citation["tool_ref"], str):
                    raise RunnerError(
                        "tool citation review must identify one tool reference"
                    )
                if citation["correct"] and citation["tool_ref"] not in case.get(
                    "tool_refs", []
                ):
                    raise RunnerError(
                        "correct tool citation must reference an observed tool"
                    )
            else:
                if not isinstance(citation.get("url"), str) or not citation["url"]:
                    raise RunnerError("citation review requires the observed URL")
                if citation["correct"] and citation["url"] not in case["source_urls"]:
                    raise RunnerError("correct citation must reference a frozen source")
        if type(item.get("output_contract_passed")) is not bool or not item.get(
            "output_contract_reason"
        ):
            raise RunnerError("output contract requires an explicit reviewed judgment")
        automatic = case.get("automatic_output_contract", {})
        if automatic.get("passed") is False and item["output_contract_passed"]:
            raise RunnerError(
                "review cannot override a failed canonical output contract"
            )
        case.update(
            {
                "factuality": {
                    "supported_claims": supported,
                    "total_claims": total_claims,
                },
                "omissions": {
                    "missing_required": total_facts - present,
                    "total_required": total_facts,
                },
                "sources": {
                    "correct_citations": correct,
                    "total_citations": total_citations,
                },
                "output_contract_passed": item["output_contract_passed"],
                "editorial_review": item,
            }
        )
    result["review_status"] = "reviewed"
    return result


def apply_reviews(
    measurements: dict[str, Any], review: dict[str, Any]
) -> dict[str, Any]:
    try:
        return _apply_reviews(measurements, review)
    except RunnerError:
        raise
    except (
        KeyError,
        TypeError,
        ValueError,
        AttributeError,
        IndexError,
        RecursionError,
    ):
        raise RunnerError("reviewed measurement structure is invalid") from None


def review_template(measurements: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "measurements_sha256": digest(measurements),
        "reviewer": None,
        "all_claims_and_citations_reviewed": None,
        "privacy_evidence": {
            "artifact_sha256": measurements["privacy_evidence"]["artifact_sha256"],
            **{key: None for key in PRIVACY_CHECKS},
        },
        "cases": [
            {
                "case_id": row["case_id"],
                "repetition": row["repetition"],
                "output_sha256": row["output_sha256"],
                "evidence_refs": copy.deepcopy(row.get("evidence_refs", [])),
                "review_evidence": copy.deepcopy(row.get("review_evidence", {})),
                "claims": [],
                "citations": [],
                "required_facts": [
                    {"fact": fact, "present": None, "reason": ""}
                    for fact in row["required_facts"]
                ],
                "output_contract_passed": None,
                "output_contract_reason": "",
            }
            for row in measurements["cases"]
        ],
    }


def load_workload(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
        if (
            value["schema_version"] != 1
            or type(value["repetitions"]) is not int
            or value["repetitions"] < 1
        ):
            raise RunnerError("unsupported frozen workload")
        if not value["cases"] or len({case["id"] for case in value["cases"]}) != len(
            value["cases"]
        ):
            raise RunnerError("workload case identities must be unique")
        if any(
            not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", case["id"])
            for case in value["cases"]
        ):
            raise RunnerError(
                "workload case identities must be bounded filename-safe literals"
            )
        return value
    except (OSError, ValueError, KeyError, TypeError):
        raise RunnerError("frozen workload could not be validated") from None


def execute(
    args: argparse.Namespace,
    workload: dict[str, Any],
    routes: dict[str, Route],
    budget: AttemptBudget,
) -> dict[str, Any]:
    # Import dependencies and Docker fixture helpers only behind explicit --execute.
    sys.path.insert(0, str(HERE))
    from runtime_fixture import execute_case

    source_snapshot = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(HERE.glob("*.py"))
    }
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    secrets = [route.secret for route in routes.values()]
    bundle = output / "synthetic-skills"
    bundle_manifest = make_synthetic_bundle(bundle)
    selected = [
        case for case in workload["cases"] if not args.case or case["id"] in args.case
    ]
    repetitions = args.repetitions or workload["repetitions"]
    variants = [args.variant] if args.variant != "both" else ["baseline", "candidate"]
    measurements = {}
    for variant in variants:
        measurements[variant] = {
            "schema_version": 1,
            "variant": variant,
            "review_status": "pending",
            "workload_sha256": digest(workload),
            "configuration": {
                "runtime_image": None,
                "gateway_image": args.gateway_version,
                "model_versions": {
                    role: {
                        "configured": route.model_name,
                        "revision": route.model_revision,
                    }
                    for role, route in routes.items()
                },
                "config_sha256": digest(
                    {
                        "routes": {
                            key: route.public() for key, route in routes.items()
                        },
                        "bundle": bundle_manifest,
                        "max_iterations": args.max_iterations,
                        "max_output_tokens_per_attempt": args.max_output_tokens_per_attempt,
                    }
                ),
                "route_contract": "captured-direct-provider-v1",
                "provider_transport": "buffered upstream relay; first-token latency is not a production-streaming measurement",
                "clock_contract": "frozen datetime and trusted skill clock results at model boundary; real monotonic deadlines",
            },
            "privacy_evidence": {
                "artifact_sha256": None,
                "reviewer": None,
                **{key: None for key in PRIVACY_CHECKS},
            },
            "automatic_privacy": {"violation_count": 0},
            "cases": [],
        }
    archived_inputs = {
        "workload.json": workload,
        "routes.public.json": {key: route.public() for key, route in routes.items()},
    }
    files = {}
    for name, value in archived_inputs.items():
        path = output / name
        path.write_text(json.dumps(value, indent=2) + "\n")
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    effective_configs = {variant: [] for variant in variants}
    # Interleave variants to avoid making one configuration consistently earlier
    # in a changing provider/load window. Calls remain sequential for fairness.
    for case in selected:
        for repetition in range(repetitions):
            for variant in variants:
                key = f"{variant}-{case['id']}-{repetition}"
                case_output = output / key
                case_output.mkdir()
                started = time.monotonic()
                try:
                    if budget.count >= budget.maximum or budget.remaining() <= 0:
                        raise RunnerError("global evaluation stop ceiling reached")
                    observed = execute_case(
                        image=args.image,
                        redis_image=args.redis_image,
                        variant=variant,
                        case=case,
                        repetition=repetition,
                        workload=workload,
                        routes=routes,
                        budget=budget,
                        bundle=bundle,
                        output=case_output,
                        per_run_timeout=min(args.per_run_timeout, budget.remaining()),
                        max_iterations=args.max_iterations,
                        max_output_tokens_per_attempt=args.max_output_tokens_per_attempt,
                    )
                except Exception as error:
                    # Fixture/library/provider exceptions may quote credentials.
                    observed = {
                        "result": {
                            "answer": "",
                            "done": False,
                            "errors": [type(error).__name__],
                        },
                        "attempts": [],
                        "captures": [],
                        "source_calls": [],
                        "fault_records": [],
                        "automatic_output_contract": {
                            "passed": None,
                            "reason": "run did not complete",
                        },
                    }
                observed = redact(observed, secrets)
                result = observed.get("result", {})
                answer = result.get("answer", "")
                (case_output / "output.txt").write_text(answer)
                (case_output / "capture.json").write_text(
                    json.dumps(observed, indent=2) + "\n"
                )
                for name in ["output.txt", "capture.json"]:
                    relative = str((case_output / name).relative_to(output))
                    files[relative] = hashlib.sha256(
                        (output / relative).read_bytes()
                    ).hexdigest()
                report = measurements[variant]
                if observed.get("image_id"):
                    report["configuration"]["runtime_image"] = observed["image_id"]
                if observed.get("effective_config"):
                    effective_configs[variant].append(
                        digest(credential_free_config(observed["effective_config"]))
                    )
                for role, observed_models in observed.get("model_versions", {}).items():
                    if role in report["configuration"]["model_versions"]:
                        item = report["configuration"]["model_versions"][role]
                        item["observed"] = sorted(
                            set(item.get("observed", [])) | set(observed_models)
                        )
                violations = sum(
                    len(capture.get("privacy_violations", []))
                    for capture in observed.get("captures", [])
                )
                report["automatic_privacy"]["violation_count"] += violations
                row = {
                    "case_id": case["id"],
                    "repetition": repetition,
                    "successful": bool(
                        result.get("done") and not result.get("errors") and answer
                    ),
                    "output_contract_passed": None,
                    "automatic_output_contract": observed.get(
                        "automatic_output_contract", {}
                    ),
                    "latency_ms": result.get(
                        "latency_ms", max(0.001, (time.monotonic() - started) * 1000)
                    ),
                    "attempt_count": len(observed.get("attempts", [])),
                    "attempts": observed.get("attempts", []),
                    "factuality": {"supported_claims": None, "total_claims": None},
                    "omissions": {
                        "missing_required": None,
                        "total_required": len(case["required_facts"]),
                    },
                    "sources": {"correct_citations": None, "total_citations": None},
                    "required_facts": case["required_facts"],
                    "evidence_refs": [source["id"] for source in case["public_sources"]]
                    + ["local." + key for key in case.get("local_inputs", {})],
                    "source_urls": [source["url"] for source in case["public_sources"]],
                    "tool_refs": sorted(
                        {
                            event["name"].split(": ", 1)[1]
                            for event in result.get("starts", [])
                            if isinstance(event.get("name"), str)
                            and ": " in event["name"]
                        }
                    ),
                    "output_sha256": hashlib.sha256(answer.encode()).hexdigest(),
                    "capture_file": str(
                        (case_output / "capture.json").relative_to(output)
                    ),
                    "output_file": str(
                        (case_output / "output.txt").relative_to(output)
                    ),
                }
                report["cases"].append(row)
    artifact_manifest = {
        "schema_version": 1,
        "workload_sha256": digest(workload),
        "files": files,
        "synthetic_bundle": bundle_manifest,
        "attempt_ceiling": budget.maximum,
        "reservations": budget.count,
        "max_output_tokens_per_attempt": args.max_output_tokens_per_attempt,
        "maximum_reserved_output_tokens": budget.maximum
        * args.max_output_tokens_per_attempt,
        "pilot": len(selected) != len(workload["cases"])
        or repetitions != workload["repetitions"],
        "runner_source_sha256": source_snapshot,
        "runner_sources_unchanged": source_snapshot
        == {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(HERE.glob("*.py"))
        },
        "source_manifest_scope": "Host runner files before fixture launch; runtime image identity is recorded separately.",
    }
    (output / "artifacts.json").write_text(
        json.dumps(artifact_manifest, indent=2) + "\n"
    )
    for variant, report in measurements.items():
        report["configuration"]["effective_runtime_configs"] = effective_configs[
            variant
        ]
        report["configuration"]["runner_sources_unchanged"] = artifact_manifest[
            "runner_sources_unchanged"
        ]
        report["configuration"]["config_sha256"] = digest(
            {
                "input_configuration": report["configuration"]["config_sha256"],
                "effective_runtime_configs": effective_configs[variant],
                "runner_source_sha256": artifact_manifest["runner_source_sha256"],
            }
        )
        report["privacy_evidence"]["artifact_sha256"] = digest(artifact_manifest)
        report = bind_review_evidence(report, output)
        (output / f"{variant}.raw.json").write_text(json.dumps(report, indent=2) + "\n")
        (output / f"{variant}.review.json").write_text(
            json.dumps(review_template(report), indent=2) + "\n"
        )
    return {
        "status": "unreviewed",
        "output": str(output),
        "variants": variants,
        "reservations": budget.count,
        "artifact_sha256": digest(artifact_manifest),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workload", type=Path, default=WORKLOAD)
    parser.add_argument("--routes", type=Path)
    parser.add_argument("--credential-env-file", type=Path, action="append", default=[])
    parser.add_argument("--image")
    parser.add_argument("--redis-image", default="redis:7.4-alpine")
    parser.add_argument(
        "--gateway-version", default="direct-provider-evaluation-relay-v1"
    )
    parser.add_argument(
        "--variant", choices=["baseline", "candidate", "both"], default="both"
    )
    parser.add_argument("--case", action="append")
    parser.add_argument("--repetitions", type=int)
    parser.add_argument("--max-iterations", type=int, default=128)
    parser.add_argument("--max-model-attempts", type=int)
    parser.add_argument("--max-output-tokens-per-attempt", type=int)
    parser.add_argument("--timeout-seconds", type=float)
    parser.add_argument("--per-run-timeout", type=float, default=420)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / ".cache/context-isolation/model-evaluation",
    )
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--measurements", type=Path)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--bind-review-evidence", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.bind_review_evidence:
            if not args.measurements or args.review or args.execute:
                raise RunnerError("evidence binding requires pending measurements only")
            if args.output.parent.resolve() != args.measurements.parent.resolve():
                raise RunnerError(
                    "bound report must remain beside its archived artifacts"
                )
            report = bind_review_evidence(
                json.loads(args.measurements.read_text()), args.measurements.parent
            )
            template_path = args.output.with_suffix(".review.json")
            if args.output.exists() or template_path.exists():
                raise RunnerError("bound report and review template must be new files")
            for path, value in (
                (args.output, report),
                (template_path, review_template(report)),
            ):
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w") as destination:
                    destination.write(json.dumps(value, indent=2) + "\n")
            print(
                json.dumps(
                    {
                        "status": "review_evidence_bound",
                        "output": str(args.output),
                        "review_template": str(template_path),
                        "original_measurements_sha256": report[
                            "review_evidence_binding"
                        ]["original_measurements_sha256"],
                    }
                )
            )
            return 0
        if args.measurements or args.review:
            if not args.measurements or not args.review or args.execute:
                raise RunnerError(
                    "review mode requires measurements and review files only"
                )
            measurements = json.loads(args.measurements.read_text())
            verify_review_evidence(measurements, args.measurements.parent)
            reviewed = apply_reviews(
                measurements,
                json.loads(args.review.read_text()),
            )
            args.output.write_text(json.dumps(reviewed, indent=2) + "\n")
            print(json.dumps({"status": "reviewed", "output": str(args.output)}))
            return 0
        workload = load_workload(args.workload)
        if args.case and set(args.case) - {case["id"] for case in workload["cases"]}:
            raise RunnerError("pilot selection includes an unknown frozen case")
        if (
            args.repetitions is not None
            and not 1 <= args.repetitions <= workload["repetitions"]
        ):
            raise RunnerError("pilot repetitions must be within the frozen workload")
        if type(args.max_iterations) is not int or not 1 <= args.max_iterations <= 128:
            raise RunnerError(
                "per-workflow iteration ceiling must be between one and 128"
            )
        cases = len(args.case) if args.case else len(workload["cases"])
        variants = 2 if args.variant == "both" else 1
        plan = {
            "status": "dry_run",
            "workload_sha256": digest(workload),
            "runs": cases * (args.repetitions or workload["repetitions"]) * variants,
            "workflow_iteration_ceiling": args.max_iterations,
            "maximum_coordinator_iterations": cases
            * (args.repetitions or workload["repetitions"])
            * variants
            * args.max_iterations,
            "provider_attempt_ceiling": args.max_model_attempts,
            "provider_attempt_scope": "All actual provider requests, including public workers, internal critics and retries, share the explicit global ceiling.",
            "generation_enabled": False,
            "required": [
                "reviewed direct routes",
                "explicit global attempt ceiling",
                "explicit per-attempt output-token ceiling",
                "explicit global deadline",
                "built runtime image",
                "independent privacy and editorial review",
            ],
        }
        if not args.execute:
            print(json.dumps(plan, indent=2))
            return 0
        if (
            not args.routes
            or not args.image
            or args.max_model_attempts is None
            or args.max_output_tokens_per_attempt is None
            or args.timeout_seconds is None
        ):
            raise RunnerError(
                "execution requires routes, image, global attempts and deadline"
            )
        if args.max_output_tokens_per_attempt <= 0:
            raise RunnerError("execution requires a positive output-token ceiling")
        if digest(workload) != digest(load_workload(WORKLOAD)):
            raise RunnerError(
                "execution requires the repository's frozen synthetic workload"
            )
        if not math.isfinite(args.per_run_timeout) or args.per_run_timeout <= 0:
            raise RunnerError("per-run timeout must be finite and positive")
        budget = AttemptBudget(args.max_model_attempts, args.timeout_seconds)
        routes = load_routes(
            args.routes,
            load_credential_environment(args.credential_env_file, os.environ),
        )
        print(json.dumps(execute(args, workload, routes, budget)))
        return 0
    except (RunnerError, OSError, ValueError, TypeError) as error:
        # JSON and subprocess diagnostics may quote input values; fixed labels.
        print(
            json.dumps({"status": "failed", "error_kind": type(error).__name__}),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
