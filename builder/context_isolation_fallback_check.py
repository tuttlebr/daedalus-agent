#!/usr/bin/env python3
"""Exercise renderer-failure text publication through a built runtime.

Only disposable local fixtures are used. This checks publication control and
history preservation, not model quality or external provider behavior.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

from context_isolation_http_check import (
    SOURCE_URL,
    IsolationPeers,
    assert_bootstrap_request,
    assert_full_skill_result,
    call,
    captured_environment,
    configuration,
    message,
    register_redis,
    require,
    run,
    secure_peer,
    sparse_edition,
    tool_json,
    workflow_budget_rows,
)
from leaf_check import measure

FEEDBACK = (
    "The proposed daily-summary text was withheld because it publishes an internal "
    "desk-status ledger. Return the complete sourced plain-text briefing using the "
    "evidence already in this conversation. Keep coverage records internal; put "
    "source links and material gaps beside the affected reporting, and explain "
    "that validated HTML could not be completed. Do not call tools, restart "
    "research, or add facts."
)
PUBLIC_FAILURE = "Agent execution failed; completed output has been preserved"
BAD_TEXT = (
    "WITHHELD_LEDGER_MARKER_7391\n\nCoverage Status\n\n"
    "- Covered: Technology.\n- Quiet: Arts.\n- Unavailable: Weather.\n\n"
    f"The supplied release adds an opt-in batch mode. Source: {SOURCE_URL}"
)
VALID_TEXT = (
    "The supplied release adds an opt-in batch mode. No latency benchmark was "
    f"published. Source: {SOURCE_URL}\n\n"
    "The weather source is unavailable in this fixture. Validated HTML could "
    "not be completed; this is the available sourced text."
)
COVERAGE_PROSE = (
    "Coverage of the supplied release is limited to its opt-in batch mode. "
    f"No latency benchmark was published. Source: {SOURCE_URL}\n\n"
    "Weather: Unavailable. Validated HTML could not be completed."
)
MODES = ("repair", "repair_exhausted", "valid", "coverage_prose", "generic")


def outputs(body):
    return {
        item["call_id"]: item["output"]
        for item in body.get("input", [])
        if item.get("type") == "function_call_output"
    }


def text_of(item):
    content = item.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return ""


class FallbackPeers(IsolationPeers):
    def __init__(self, mode):
        super().__init__()
        if mode not in MODES:
            raise ValueError("Unknown fallback fixture mode")
        self.mode = mode
        self.plain_responses = 0
        self.fixture_redis = None
        self.plain_budget_snapshots = []
        self.invalid_edition = sparse_edition(personal=False)
        next(
            desk
            for desk in self.invalid_edition["coverage"]
            if desk["desk_key"] == "technology"
        )["status"] = "quiet"

    def response_items(self, body):
        if self.mode == "generic":
            return [message(BAD_TEXT, "generic_answer")]
        observed = outputs(body)
        if "fallback_skill" not in observed:
            assert_bootstrap_request(body)
            return [
                call(
                    "agent_skills_tool",
                    {"operation": "load_skill", "skill_name": "daily-summary"},
                    "fallback_skill",
                )
            ]
        assert_full_skill_result(observed["fallback_skill"])
        for label in ("fallback_render_one", "fallback_render_two"):
            if label not in observed:
                return [
                    call(
                        "briefing_renderer_tool",
                        {"edition": copy.deepcopy(self.invalid_edition)},
                        label,
                    )
                ]
        self.plain_responses += 1
        rows = workflow_budget_rows(self.fixture_redis)
        require(len(rows) == 1, "Fallback did not retain one owned workflow budget")
        self.plain_budget_snapshots.append(copy.deepcopy(next(iter(rows.values()))))
        if self.mode == "valid":
            text = VALID_TEXT
        elif self.mode == "coverage_prose":
            text = COVERAGE_PROSE
        elif self.mode == "repair" and self.plain_responses > 1:
            text = VALID_TEXT
        else:
            text = BAD_TEXT
        return [message(text, f"fallback_text_{self.plain_responses}")]

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def coordinator(self, body):
                return self.emit_items(peers.response_items(body))

        return Handler


def assert_rewrite_request(previous, current):
    prior = previous["input"]
    latest = current["input"]
    # The phase notice is added to each request copy, after persistent history;
    # it is reissued after the draft/feedback rather than stored before them.
    phase_notice = "Finish using the evidence already collected. Render the briefing or return the sourced findings and any explicit gaps."
    if prior and prior[-1].get("role") == "user" and text_of(prior[-1]) == phase_notice:
        prior = prior[:-1]
        require(
            any(
                item.get("role") == "user" and text_of(item) == phase_notice
                for item in latest
            ),
            "Publication rewrite lost the existing final-synthesis instruction",
        )
    require(
        latest[: len(prior)] == prior,
        "Publication rewrite lost or changed the previous evidence history",
    )
    appended = latest[len(prior) :]
    require(
        any(
            item.get("role") == "assistant" and text_of(item) == BAD_TEXT
            for item in appended
        ),
        "Rewrite did not retain the withheld proposed text",
    )
    require(
        any(
            item.get("role") == "user" and text_of(item) == FEEDBACK
            for item in appended
        ),
        "Rewrite lacks the exact fixed publication feedback",
    )
    require(not current.get("tools"), "Publication rewrite advertised tools")
    require(
        current.get("tool_choice") == "none",
        "Publication rewrite did not prohibit tool calls",
    )
    require(
        current.get("max_output_tokens") == previous.get("max_output_tokens"),
        "Publication rewrite changed the model output budget",
    )


def verify_observations(mode, result, requests):
    bodies = [request["body"] for request in requests]
    require(bool(bodies), "Fallback fixture captured no coordinator requests")
    if mode == "generic":
        require(len(bodies) == 1, "Generic prose triggered briefing repair")
        require(result["answer"] == BAD_TEXT, "Generic response changed")
    else:
        first = outputs(bodies[-1])
        assert_full_skill_result(first.get("fallback_skill", ""))
        for label, remaining in (
            ("fallback_render_one", 1),
            ("fallback_render_two", 0),
        ):
            failed = tool_json(first.get(label, "{}"))
            require(
                failed.get("passed") is False
                and failed.get("failure_type") == "validation"
                and failed.get("attempts_remaining") == remaining
                and failed.get("terminal") is False,
                "Fixture did not execute two actual canonical validation failures",
            )
        expected = 5 if mode in ("repair", "repair_exhausted") else 4
        require(len(bodies) == expected, "Fallback exceeded its fixed model-call count")
        if mode in ("repair", "repair_exhausted"):
            assert_rewrite_request(bodies[-2], bodies[-1])
            require(
                "WITHHELD_LEDGER_MARKER_7391" not in result["answer"],
                "Invalid desk ledger reached published text",
            )
        if mode == "repair_exhausted":
            require(not result["answer"], "Second invalid fallback published content")
            require(
                result["terminal"] != "stop",
                "Invalid fallback reported a successful stop",
            )
            require(
                result["errors"] == [{"error": {"message": PUBLIC_FAILURE}}],
                "Second invalid fallback changed the existing public error contract",
            )
            require(
                "WITHHELD_LEDGER_MARKER_7391" not in json.dumps(result["errors"]),
                "Publication failure echoed rejected content",
            )
        else:
            expected_text = COVERAGE_PROSE if mode == "coverage_prose" else VALID_TEXT
            require(result["answer"] == expected_text, "Valid fallback text changed")
    if mode != "repair_exhausted":
        require(
            result["done"] and result["terminal"] == "stop" and not result["errors"],
            "Expected successful fallback did not finish",
        )


def verify_failure_trace(runtime_log):
    records = []
    for line in runtime_log.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and isinstance(record.get("fields"), dict):
            records.append(record["fields"])
    rejections = [
        row
        for row in records
        if row.get("event") == "briefing_fallback_contract_rejected"
    ]
    require(
        [row.get("repair_used") for row in rejections] == [False, True]
        and all(row.get("constraint") == "internal_desk_ledger" for row in rejections),
        "Runtime did not reject the original and corrected ledger exactly once each",
    )
    require(
        any(
            row.get("event") == "run_failed"
            and row.get("phase") == "briefing_fallback_contract"
            and row.get("reason") == PUBLIC_FAILURE
            for row in records
        ),
        "Public error lacks the trusted native publication-contract failure phase",
    )
    require(
        "WITHHELD_LEDGER_MARKER_7391" not in runtime_log,
        "Runtime telemetry echoed the withheld draft",
    )


def verify_budget(peers, store):
    rows = workflow_budget_rows(store)
    require(len(rows) == 1, "Fallback changed the owned workflow budget identity")
    row = next(iter(rows.values()))
    require(
        int(row["calls_used"]) == len(peers.local)
        and int(row["tokens_used"]) == len(peers.local) * 8192,
        "Publication correction bypassed ordinary model-call/token reservations",
    )
    repairing = peers.mode in ("repair", "repair_exhausted")
    require(
        (row.get("briefing_text_repair") == "1")
        if repairing
        else "briefing_text_repair" not in row,
        "Publication correction changed its one-admission marker",
    )
    if repairing:
        before, after = peers.plain_budget_snapshots
        require(
            "briefing_text_repair" not in before
            and after.get("briefing_text_repair") == "1"
            and int(after["calls_used"]) == int(before["calls_used"]) + 1
            and int(after["tokens_used"]) == int(before["tokens_used"]) + 8192,
            "Correction did not claim once and pay for exactly one normal model call",
        )
        require(
            all(
                before[key] == after[key]
                for key in (
                    "max_calls",
                    "max_tokens",
                    "research_ms",
                    "total_ms",
                    "research_deadline",
                    "total_deadline",
                )
            ),
            "Correction renewed a deadline or changed a workflow resource limit",
        )
    return {"final": row, "plain_model_requests": peers.plain_budget_snapshots}


def check_case(args, mode):
    peers = FallbackPeers(mode)
    report = {"mode": mode, "status": "failed"}
    args.report["cases"].append(report)

    def configure(*values):
        configuration(peers, secure["endpoint"], *values)
        values[0]["workflow"].update(
            max_iterations=16,
            max_history=80,
            max_history_tokens=64000,
            daily_summary_research_budget_seconds=300,
        )

    try:
        with secure_peer(peers) as secure, captured_environment(
            report,
            args.image,
            args.redis_image,
            minimal=False,
            memory=True,
            peers=peers,
            configure=configure,
            fixture_mounts=[(secure["root"], secure["root"])],
            namespace_factory=register_redis,
            extra_env=lambda _port: {
                **secure["environment"],
                "DAEDALUS_PREPARATION": "rust",
                "DAEDALUS_AUTHORIZATION": "rust",
                "LLM_SANDBOX_BASE_URL": secure["endpoint"],
            },
        ) as env:
            report["image_id"] = run(
                "docker",
                "inspect",
                env["container"],
                "--format",
                "{{.Image}}",
                capture_output=True,
                text=True,
            ).stdout.strip()
            peers.fixture_redis = env["redis"]
            report["result"] = measure(
                env,
                user="synthetic-fallback-" + mode,
                message=(
                    "Return the synthetic generic fixture response."
                    if mode == "generic"
                    else "Produce my daily summary. The supplied synthetic release "
                    "adds an opt-in batch mode and publishes no latency benchmark. "
                    f"Source: {SOURCE_URL}"
                ),
                request_fields={
                    "additional_props": {
                        "model_profile": "default",
                        "sourcePolicy": {
                            "enabledSources": ["perplexity_search", "known_url_scrape"],
                            "disabledSources": ["workspace_data"],
                        },
                    }
                },
            )
            verify_observations(mode, report["result"], peers.local)
            report["budget"] = verify_budget(peers, env["redis"])
            require(not peers.external, "Fallback fixture dispatched public work")
            require(not peers.personal, "Fallback fixture dispatched personal work")
            require(
                not peers.memory_requests, "Fallback fixture dispatched memory work"
            )
            require(not peers.failures, "Fallback fixture used an unexpected endpoint")
            report["checks"] = {
                "actual_native_skill": mode != "generic",
                "actual_renderer_validation_failures": 0 if mode == "generic" else 2,
                "one_tool_free_rewrite": mode in ("repair", "repair_exhausted"),
                "valid_text_preserved": mode != "repair_exhausted",
                "model_calls": len(peers.local),
                "no_source_reopening": True,
            }
        if mode == "repair_exhausted":
            verify_failure_trace(report["runtime_log"])
        report["status"] = "passed"
    except Exception as error:
        report["failure_kind"] = type(error).__name__
        report["failure_message"] = str(error)
        raise
    finally:
        report.update(
            local_requests=peers.local,
            external_requests=peers.external,
            personal_reads=peers.personal,
            memory_requests=peers.memory_requests,
            sandbox_requests=peers.sandbox_requests,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(args.report, indent=2) + "\n")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    args.report = {
        "status": "failed",
        "scope": "Built-runtime publication control with local synthetic peers only",
        "helper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "image": args.image,
        "redis_image": args.redis_image,
        "cases": [],
    }
    try:
        for mode in MODES:
            check_case(args, mode)
        args.report["status"] = "passed"
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(args.report, indent=2) + "\n")


if __name__ == "__main__":
    main()
