"""Built-runtime adapter for bounded, wholly synthetic real-model evaluations.

Provider secrets exist only in host-side HTTP clients. The runtime image sees
synthetic proxy credentials, synthetic sources, and a generated skill bundle.
This module is imported only after the runner's explicit execution gate.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import html
import json
import os
import runpy
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MAX_BODY = 8 * 1024 * 1024
JOURNAL_NAME = "capture.journal.jsonl"
MAX_JOURNAL_RECORD = MAX_BODY * 16


class CaseJournal:
    """Append-only, redacted observations durable before provider dispatch."""

    def __init__(self, output, identity, *, redact, secrets):
        output.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(output, 0o700)
        self.path = output / JOURNAL_NAME
        self.redact = redact
        self.secrets = secrets
        self.lock = threading.Lock()
        self.sequence = 0
        self.failed = False
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        self.record("header", {"schema_version": 1, "identity": identity})
        directory = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def record(self, kind, value):
        with self.lock:
            if self.failed:
                raise OSError("evaluation journal is unavailable")
            record = self.redact(
                {
                    "sequence": self.sequence,
                    "kind": kind,
                    "value": value,
                    "monotonic_ns": time.monotonic_ns(),
                },
                self.secrets,
            )
            payload = json.dumps(record, separators=(",", ":")).encode() + b"\n"
            if len(payload) > MAX_JOURNAL_RECORD:
                self.failed = True
                raise ValueError("evaluation journal record exceeds its bound")
            descriptor = os.open(self.path, os.O_WRONLY | os.O_APPEND)
            try:
                remaining = memoryview(payload)
                while remaining:
                    written = os.write(descriptor, remaining)
                    if written <= 0:
                        raise OSError("evaluation journal write failed")
                    remaining = remaining[written:]
                os.fsync(descriptor)
                self.sequence += 1
            except BaseException:
                self.failed = True
                raise
            finally:
                os.close(descriptor)


def recover_case_journal(output, identity, *, failure_kind):
    """Recover saved evidence only; this never resumes execution or success."""
    state = {
        "result": {
            "answer": "",
            "done": False,
            "errors": [],
            "starts": [],
            "ends": [],
            "terminal": None,
        },
        "attempts": [],
        "captures": [],
        "source_calls": [],
        "fault_records": [],
    }
    attempts, captures = {}, {}
    event_type = None
    count = 0
    tail = False
    first_time = last_time = None
    with (output / JOURNAL_NAME).open("rb") as stream:
        while line := stream.readline(MAX_JOURNAL_RECORD + 1):
            if len(line) > MAX_JOURNAL_RECORD or not line.endswith(b"\n"):
                tail = True
                break
            try:
                record = json.loads(line)
                if record["sequence"] != count:
                    raise ValueError
                kind, value = record["kind"], record["value"]
                if count == 0:
                    if kind != "header" or value != {
                        "schema_version": 1,
                        "identity": identity,
                    }:
                        raise ValueError("evaluation journal identity mismatch")
                    first_time = record["monotonic_ns"]
                elif kind == "provider":
                    capture = value["capture"]
                    captures[capture["handler_id"]] = capture
                    if value.get("attempt"):
                        attempts[value["attempt"]["id"]] = value["attempt"]
                elif kind == "source":
                    state["source_calls"].append(value)
                elif kind in {"observed", "snapshot"}:
                    state.update(value)
                    if kind == "snapshot":
                        attempts = {item["id"]: item for item in state["attempts"]}
                        captures = {
                            item["handler_id"]: item for item in state["captures"]
                        }
                elif kind == "phase":
                    state["last_observed_phase"] = value
                elif kind == "runtime_line":
                    result = state["result"]
                    if value.startswith("event: "):
                        event_type = value[7:]
                    elif value.startswith("intermediate_data: "):
                        event = json.loads(value.split(": ", 1)[1])
                        result[
                            "ends"
                            if event["name"].startswith("Function Complete:")
                            else "starts"
                        ].append(event)
                    elif value == "data: [DONE]":
                        result["done"] = True
                    elif value.startswith("data: "):
                        event = json.loads(value[6:])
                        if event_type == "error":
                            result["errors"].append(event)
                        for choice in event.get("choices", []):
                            result["answer"] += choice.get("delta", {}).get(
                                "content", ""
                            )
                            if choice.get("daedalus_terminal"):
                                result["terminal"] = choice.get("finish_reason")
                last_time = record["monotonic_ns"]
                count += 1
            except (ValueError, KeyError, TypeError):
                if count == 0:
                    raise ValueError("evaluation journal identity is invalid") from None
                tail = True
                break
    if count == 0:
        raise ValueError("evaluation journal is empty")
    for attempt in attempts.values():
        if attempt.get("outcome") == "in_flight":
            attempt.update(outcome="unknown_after_interruption", latency_ms=None)
    for capture in captures.values():
        if capture.get("outcome") in {"in_flight", "fixture_preparation_pending"}:
            capture["outcome"] = "unknown_after_interruption"
    state["attempts"], state["captures"] = (
        list(attempts.values()),
        list(captures.values()),
    )
    state["result"]["done"] = False
    state["result"]["errors"].append({"kind": failure_kind})
    state["automatic_output_contract"] = {
        "passed": False,
        "reason": "incomplete journal recovery",
    }
    state["journal_recovery"] = {
        "complete_records": count,
        "incomplete_tail": tail,
        "execution_resumed": False,
        "completion": "unknown",
    }
    if first_time is not None and last_time is not None:
        state["journal_observed_span_ms"] = (last_time - first_time) / 1_000_000
    return state


class _ProviderCall:
    """Resource ownership registered with the attempt, before any transport."""

    def __init__(self):
        self.client = None
        self.response = None
        self.cancelled = False
        self.closing = False
        self.closed = threading.Event()


def _helpers(budget=None):
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    core = sys.modules.get(type(budget).__module__) if budget is not None else None
    if core is None or Path(getattr(core, "__file__", "")).resolve() != HERE / "run.py":
        import run as core
    from fixture_transforms import (
        freeze_clock,
        mutate_renderer_response,
        usage_from_response,
    )

    return core, freeze_clock, mutate_renderer_response, usage_from_response


def _safe_config(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[credential omitted]"
            if key.lower() in {"api_key", "password", "secret", "token"}
            else _safe_config(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_safe_config(item) for item in value]
    return value


def _bounded_output(body: dict, api_type: str, ceiling: int) -> tuple[dict, list[dict]]:
    """Apply a fixture cap without increasing a smaller runtime token cap."""
    if type(ceiling) is not int or ceiling <= 0:
        raise ValueError("invalid fixture output-token ceiling")
    result = copy.deepcopy(body)
    fields = (
        ["max_output_tokens"]
        if api_type == "responses"
        else [
            field
            for field in ("max_completion_tokens", "max_tokens")
            if field in result
        ]
    )
    if not fields:
        fields = ["max_tokens"]
    present = [result[field] for field in fields if field in result]
    if any(type(cap) is not int or cap <= 0 for cap in present):
        raise ValueError("invalid runtime output-token cap")
    applied = min([ceiling, *present])
    records = []
    for field in fields:
        records.append(
            {
                "kind": "model_output_token_cap",
                "field": field,
                "requested": result.get(field),
                "applied": applied,
            }
        )
        result[field] = applied
    return result, records


def _runtime_options(options: dict) -> dict:
    result = {
        key: copy.deepcopy(options[key])
        for key in (
            "reasoning_effort",
            "reasoning",
            "reasoning_history",
            "thinking_token_budget",
        )
        if key in options
    }
    template = options.get("chat_template_kwargs", {})
    if "enable_thinking" in template:
        result["chat_template_kwargs"] = {
            key: template[key]
            for key in ("enable_thinking", "medium_effort")
            if key in template
        }
    return result


def _peers_class(base_class):
    class EvaluationPeers(base_class):
        def __init__(
            self,
            *,
            variant,
            case,
            workload,
            routes,
            budget,
            timeout,
            max_output_tokens_per_attempt,
            journal=None,
        ):
            super().__init__()
            if str(HERE) not in sys.path:
                sys.path.insert(0, str(HERE))
            from private_memory_fixture import memory_pages, recall_records

            self.variant = variant
            self.case = case
            self.memory_pages = memory_pages(case)
            self.recalled_records = recall_records(case, workload["as_of"])
            self.workload = workload
            self.routes = routes
            self.budget = budget
            self.timeout = timeout
            self.max_output_tokens_per_attempt = max_output_tokens_per_attempt
            self.journal = journal
            self.attempts = []
            self.captures = []
            self.source_calls = []
            self.fault_records = []
            self.lock = threading.Lock()
            self.stop_lock = threading.Lock()
            self.stopped = threading.Event()
            self.stop_requested = threading.Event()
            self.provider_calls = {}
            self.capture_frozen = False
            self.handlers = {}
            self.attempt_started = {}
            self.renderer_fault_claimed = False
            self.public_fault_claimed = False
            self.model_versions = {}

        def record_source(self, kind, **fields):
            with self.lock:
                if not self.capture_frozen:
                    value = {"kind": kind, **fields}
                    self.source_calls.append(value)
                    self.persist("source", value)

        def persist(self, kind, value):
            if self.journal:
                try:
                    self.journal.record(kind, value)
                except (Exception, KeyboardInterrupt):
                    self.stop_requested.set()
                    self.budget.deadline = time.monotonic()
                    raise

        def persist_provider(self, capture, attempt=None):
            # Caller holds the peer lock. Persist before any actual dispatch.
            self.persist("provider", {"capture": capture, "attempt": attempt})

        def stop(self):
            self.stop_requested.set()
            # Serialize cleanup callers, never provider I/O. The shared state
            # lock is held only to claim resources or publish bookkeeping.
            with self.stop_lock:
                with self.lock:
                    if self.capture_frozen:
                        return
                    self.stopped.set()
                    handlers = dict(self.handlers)
                    calls = dict(self.provider_calls)
                    for call in calls.values():
                        call.cancelled = True
                for identity in calls:
                    threading.Thread(
                        target=self._close_call, args=(identity,), daemon=True
                    ).start()
                drain_deadline = time.monotonic() + 0.5
                for done in [
                    *handlers.values(),
                    *(call.closed for call in calls.values()),
                ]:
                    done.wait(max(0.0, drain_deadline - time.monotonic()))
                with self.lock:
                    pending = [
                        identity
                        for identity, done in handlers.items()
                        if not done.is_set()
                    ]
                    if pending:
                        self.fault_records.append(
                            {
                                "kind": "handlers_pending_at_cleanup",
                                "handler_ids": pending,
                                "completion": "unknown",
                            }
                        )
                    unclosed = [
                        identity
                        for identity, call in calls.items()
                        if not call.closed.is_set()
                    ]
                    if unclosed:
                        self.fault_records.append(
                            {
                                "kind": "provider_cleanup_pending",
                                "attempt_ids": unclosed,
                                "completion": "unknown",
                            }
                        )
                    for attempt in self.attempts:
                        if attempt["outcome"] == "in_flight":
                            attempt["outcome"] = "cancelled_at_fixture_cleanup"
                            attempt["latency_ms"] = max(
                                0.0,
                                (time.monotonic() - self.attempt_started[attempt["id"]])
                                * 1000,
                            )
                    for capture in self.captures:
                        if capture.get("outcome") == "fixture_preparation_pending":
                            capture["outcome"] = "cancelled_at_fixture_cleanup"
                    self.capture_frozen = True

        def _close_call(self, identity, client=None, *, final=False):
            with self.lock:
                call = self.provider_calls.get(identity)
                if call is None or call.closing:
                    return
                if call.client is None:
                    call.client = client
                if call.client is None and not final:
                    # Construction is still pending. Its handler owns closing
                    # the eventual client even if cleanup has already returned.
                    return
                call.closing = True
                resources = (call.response, call.client)
            failures = []
            for resource in resources:
                if resource is not None:
                    try:
                        resource.close()
                    except Exception as error:
                        failures.append(type(error).__name__)
            with self.lock:
                self.provider_calls.pop(identity, None)
                call.closed.set()
                if not self.capture_frozen:
                    for failure in failures:
                        self.fault_records.append(
                            {"kind": "client_cleanup_error", "failure_kind": failure}
                        )

        def publish(
            self, capture, *, attempt=None, capture_fields=None, attempt_fields=None
        ):
            with self.lock:
                if self.capture_frozen:
                    return False
                capture.update(capture_fields or {})
                if attempt is not None:
                    attempt.update(attempt_fields or {})
                self.persist_provider(capture, attempt)
                return True

        def admit(self, capture, phase, profile, target):
            core, _, _, _ = _helpers(self.budget)
            with self.lock:
                if self.stop_requested.is_set() or self.stopped.is_set():
                    if not self.capture_frozen:
                        capture["outcome"] = "fixture_cleanup_rejected"
                    return None, 503
                try:
                    identity = self.budget.reserve()
                except core.RunnerError:
                    capture["outcome"] = "global_stop_limit_rejected"
                    return None, 429
                attempt = {
                    "id": identity,
                    "phase": phase,
                    "profile": profile,
                    "target": target,
                    "outcome": "in_flight",
                    "latency_ms": 0.0,
                    "cost_usd": None,
                    "usage": {
                        "input_tokens": None,
                        "output_tokens": None,
                        "cached_input_tokens": None,
                    },
                }
                capture["attempt_id"] = identity
                self.attempt_started[identity] = time.monotonic()
                self.attempts.append(attempt)
                self.provider_calls[identity] = _ProviderCall()
                self.persist_provider(capture, attempt)
                return attempt, 200

        @contextlib.contextmanager
        def dispatch(self, identity, client, endpoint, body, secret):
            with self.lock:
                call = self.provider_calls[identity]
                if (
                    self.stop_requested.is_set()
                    or call.cancelled
                    or self.budget.remaining() <= 0
                ):
                    raise TimeoutError
                call.client = client
            # This call was admitted and its transport ownership was published
            # before cleanup. Never hold the shared lock while connecting,
            # waiting for headers, consuming bytes, or closing the response.
            with client.stream(
                "POST",
                endpoint,
                json=body,
                headers={"Authorization": "Bearer " + secret},
            ) as response:
                with self.lock:
                    call.response = response
                    cancelled = self.stop_requested.is_set() or call.cancelled
                if cancelled:
                    # A blocked enter may return after cleanup already closed
                    # its client. The context still owns and closes this late
                    # response; it must never be delivered or published late.
                    raise TimeoutError
                yield response

        def handler(self):
            peers = self
            core, freeze_clock, mutate_renderer_response, usage_from_response = (
                _helpers(peers.budget)
            )

            class Handler(super().handler()):
                def _body(self):
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                        if length < 0 or length > MAX_BODY:
                            raise ValueError
                        return json.loads(self.rfile.read(length))
                    except (ValueError, json.JSONDecodeError):
                        return None

                def do_GET(self):
                    if self.path == "/readyz":
                        return self.reply({"status": "unavailable"}, 503)
                    if self.path.startswith("/source?"):
                        url = parse_qs(urlsplit(self.path).query).get("url", [""])[0]
                        peers.record_source("public_scrape", url=url)
                        source = next(
                            (
                                item
                                for item in peers.case.get("public_sources", [])
                                if item["url"] == url
                            ),
                            None,
                        )
                        if (
                            source is None
                            or "public_fetch_unavailable"
                            in peers.case.get("faults", [])
                        ):
                            return self.reply(
                                {"error": "synthetic source unavailable"}, 503
                            )
                        title = html.escape("Frozen synthetic source " + source["id"])
                        text = html.escape(source["text"])
                        date = html.escape(source.get("published_at", "unknown"))
                        body = (
                            f"<!doctype html><html><head><title>{title}</title></head>"
                            f"<body><article><h1>{title}</h1><p>{text}</p>"
                            f"<p>Publication timestamp: {date}.</p><p>"
                            "This is a frozen synthetic source for a controlled workflow "
                            "evaluation. Only the supplied source statement is evidence. "
                            "No additional reporting or unsupported facts are supplied."
                            "</p></article></body></html>"
                        ).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "text/html; charset=utf-8")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                        return
                    peers.record_source("memory", method="GET", path=self.path)
                    if self.path.endswith("/config"):
                        return self.reply({"overrides": {}})
                    if self.path.endswith("/knowledge-base/tree"):
                        return self.reply({"roots": []})
                    if "/knowledge-base/search?" in self.path:
                        return self.reply(
                            {
                                "results": [
                                    {"id": page["id"]} for page in peers.memory_pages
                                ]
                            }
                        )
                    for page in peers.memory_pages:
                        if self.path.endswith("/knowledge-base/pages/" + page["id"]):
                            return self.reply(page)
                    if self.path == "/health":
                        return self.reply({"status": "ok"})
                    return self.reply({"error": "unknown synthetic endpoint"}, 404)

                def do_PATCH(self):
                    return self._memory(self._body())

                def _memory(self, body):
                    if body is None:
                        return self.reply({"error": "invalid fixture request"}, 400)
                    peers.record_source(
                        "memory", method=self.command, path=self.path, body=body
                    )
                    inputs = peers.case.get("local_inputs", {})
                    if self.path.endswith("/reflect"):
                        return self.reply({"text": inputs.get("derived_summary", "")})
                    if self.path.endswith("/memories/recall"):
                        return self.reply({"results": peers.recalled_records})
                    return self.reply({})

                def _mcp(self, body):
                    if body is None:
                        return self.reply({"error": "invalid fixture request"}, 400)
                    if "id" not in body:
                        return self.reply({}, 202)
                    method = body.get("method")
                    gmail = self.path.endswith("gmail")
                    name = "search_threads" if gmail else "list_events"
                    if method == "initialize":
                        result = {
                            "protocolVersion": body.get("params", {}).get(
                                "protocolVersion", "2025-03-26"
                            ),
                            "capabilities": {"tools": {}},
                            "serverInfo": {
                                "name": "frozen-personal-source",
                                "version": "1",
                            },
                        }
                    elif method == "tools/list":
                        result = {
                            "tools": [
                                {
                                    "name": name,
                                    "description": "Read only the frozen synthetic personal source.",
                                    "annotations": {"readOnlyHint": True},
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {"query": {"type": "string"}}
                                        if gmail
                                        else {
                                            "startTime": {"type": "string"},
                                            "endTime": {"type": "string"},
                                            "timeZone": {"type": "string"},
                                        },
                                        "additionalProperties": False,
                                    },
                                }
                            ]
                        }
                    elif method == "tools/call":
                        params = body.get("params", {})
                        peers.record_source(
                            "personal_read",
                            name=params.get("name"),
                            arguments=params.get("arguments", {}),
                        )
                        unavailable = gmail and "gmail_unavailable" in peers.case.get(
                            "faults", []
                        )
                        inputs = peers.case.get("local_inputs", {})
                        evidence = {
                            "source_id": "local.email" if gmail else "local.calendar",
                            "evidence": inputs.get(
                                "email" if gmail else "calendar", ""
                            ),
                            "status": "unavailable"
                            if unavailable
                            else "supplied"
                            if inputs.get("email" if gmail else "calendar")
                            else "not_supplied",
                            "scope": "Only frozen fixture evidence is represented; absent evidence is not an observation of an empty real account.",
                            "as_of": peers.workload["as_of"],
                        }
                        if inputs.get("tool_result"):
                            evidence["completed_tool_evidence"] = inputs["tool_result"]
                        if unavailable:
                            evidence["limitation"] = (
                                "Frozen synthetic mail source is unavailable."
                            )
                        result = {
                            "content": [{"type": "text", "text": json.dumps(evidence)}],
                            "isError": unavailable,
                        }
                    else:
                        return self.reply(
                            {
                                "jsonrpc": "2.0",
                                "id": body["id"],
                                "error": {"code": -32601, "message": "Unknown method"},
                            }
                        )
                    return self.reply(
                        {"jsonrpc": "2.0", "id": body["id"], "result": result}
                    )

                def do_POST(self):
                    body = self._body()
                    if self.path.startswith("/v1/default/banks/"):
                        return self._memory(body)
                    if self.path.startswith("/mcp/"):
                        return self._mcp(body)
                    if self.path == "/v1/traces":
                        # The benchmark uses only a local telemetry sink. The
                        # existing exporter sends protobuf, so _body is null.
                        return self.reply({})
                    if body is None:
                        return self.reply({"error": "invalid fixture request"}, 400)
                    if self.path == "/search":
                        peers.record_source("public_search", body=body)
                        if "public_fetch_unavailable" in peers.case.get("faults", []):
                            return self.reply(
                                {"error": "frozen public source unavailable"}, 503
                            )
                        return self.reply(
                            {
                                "results": [
                                    {
                                        "title": "Frozen synthetic source "
                                        + source["id"],
                                        "url": source["url"],
                                        "snippet": source["text"],
                                        "date": source.get("published_at"),
                                    }
                                    for source in peers.case.get("public_sources", [])
                                ]
                            }
                        )
                    if self.path.startswith("/model/"):
                        identity, done = uuid.uuid4().hex, threading.Event()
                        with peers.lock:
                            if peers.stop_requested.is_set() or peers.stopped.is_set():
                                registered = False
                            else:
                                peers.handlers[identity] = done
                                self._evaluation_capture = {
                                    "kind": "provider",
                                    "handler_id": identity,
                                    "runtime_request": copy.deepcopy(body),
                                    "outcome": "fixture_preparation_pending",
                                }
                                peers.captures.append(self._evaluation_capture)
                                peers.persist_provider(self._evaluation_capture)
                                registered = True
                        if not registered:
                            return self.reply(
                                {"error": "evaluation fixture stopped"}, 503
                            )
                        try:
                            return self._model(body)
                        finally:
                            done.set()
                            with peers.lock:
                                peers.handlers.pop(identity, None)
                    return self.reply({"error": "unknown synthetic endpoint"}, 404)

                def _model(self, body):
                    import httpx
                    from fixture_leaf_overrides import is_verifier_model_request

                    parts = self.path.split("/")
                    role = parts[2] if len(parts) > 2 else ""
                    if role not in peers.routes or peers.stopped.is_set():
                        return self.reply({"error": "evaluation fixture stopped"}, 503)
                    route = peers.routes[role]
                    expected = (
                        "/responses"
                        if route.api_type == "responses"
                        else "/chat/completions"
                    )
                    if not self.path.endswith(expected):
                        return self.reply({"error": "unexpected provider API"}, 400)
                    runtime_body = copy.deepcopy(body)
                    forwarded, transforms = freeze_clock(body, peers.workload["as_of"])
                    forwarded["model"] = route.model_name
                    changed_options = sorted(
                        key
                        for key, value in route.extra_body.items()
                        if key not in forwarded or forwarded[key] != value
                    )
                    forwarded.update(copy.deepcopy(route.extra_body))
                    if changed_options:
                        transforms.append(
                            {
                                "kind": "bounded_host_route_options",
                                "fields": changed_options,
                            }
                        )
                    try:
                        forwarded, cap_transforms = _bounded_output(
                            forwarded,
                            route.api_type,
                            peers.max_output_tokens_per_attempt,
                        )
                    except ValueError:
                        peers.publish(
                            self._evaluation_capture,
                            capture_fields={
                                "role": role,
                                "outcome": "invalid_output_cap_rejected_before_forwarding",
                            },
                        )
                        return self.reply(
                            {"error": "invalid runtime output-token cap"}, 400
                        )
                    transforms.extend(cap_transforms)
                    violations = []
                    if route.trust != "trusted_local":
                        violations = core.scan_external_request(
                            forwarded, core.private_fragments(peers.case)
                        )
                    capture = self._evaluation_capture
                    if not peers.publish(
                        capture,
                        capture_fields={
                            "kind": "provider",
                            "role": role,
                            "runtime_request": runtime_body,
                            "forwarded_request": forwarded,
                            "privacy_violations": violations,
                            "fixture_transforms": transforms,
                        },
                    ):
                        return self.reply({"error": "evaluation fixture stopped"}, 503)
                    if violations and peers.variant == "candidate":
                        peers.publish(
                            capture,
                            capture_fields={
                                "outcome": "privacy_rejected_before_forwarding"
                            },
                        )
                        return self.reply(
                            {"error": "candidate context rejected by capture guard"},
                            403,
                        )
                    profile = role
                    phase = (
                        "public_worker"
                        if role in {"medium", "high", "xhigh"}
                        else "coordinator"
                    )
                    if phase == "public_worker":
                        try:
                            task_text = forwarded.get(
                                "input", forwarded.get("messages", [])
                            )[0]["content"]
                            declared = json.loads(task_text).get("phase")
                            if declared in {
                                "public_retrieval",
                                "public_comparison",
                                "public_section_draft",
                            }:
                                phase = declared
                        except (KeyError, IndexError, TypeError, ValueError):
                            pass
                    elif is_verifier_model_request(runtime_body):
                        phase = "internal_tool_verification"
                        peers.publish(
                            capture, capture_fields={"tool": "source_verifier"}
                        )
                    attempt, admission_status = peers.admit(
                        capture, phase, profile, role
                    )
                    if attempt is None:
                        return self.reply(
                            {"error": "evaluation admission limit reached"},
                            admission_status,
                        )
                    if phase == "internal_tool_verification":
                        peers.publish(
                            capture,
                            attempt=attempt,
                            attempt_fields={"tool": "source_verifier"},
                        )
                    attempt_id = attempt["id"]
                    started = peers.attempt_started[attempt_id]
                    with peers.lock:
                        injected = (
                            (
                                role in {"medium", "high", "xhigh"}
                                or role == "baseline"
                                and any(
                                    source["kind"] in {"public_search", "public_scrape"}
                                    for source in peers.source_calls
                                )
                            )
                            and "first_public_provider_attempt_timeout"
                            in peers.case.get("faults", [])
                            and not peers.public_fault_claimed
                        )
                        if injected:
                            peers.public_fault_claimed = True
                    if injected:
                        peers.publish(
                            capture,
                            attempt=attempt,
                            attempt_fields={
                                "outcome": "injected_gateway_timeout",
                                "latency_ms": (time.monotonic() - started) * 1000,
                            },
                            capture_fields={"outcome": "injected_gateway_timeout"},
                        )
                        with peers.lock:
                            if not peers.capture_frozen:
                                peers.fault_records.append(
                                    {
                                        "kind": "first_public_provider_attempt_timeout",
                                        "attempt_id": attempt_id,
                                        "phase_boundary": "isolated public worker"
                                        if role != "baseline"
                                        else "legacy coordinator after public source retrieval",
                                        "mechanism": "synthetic HTTP 504; no provider request was sent",
                                    }
                                )
                        peers._close_call(attempt_id, final=True)
                        return self.reply({"error": "synthetic gateway timeout"}, 504)
                    client = None
                    outcome = "in_flight"
                    try:
                        timeout = min(peers.timeout, peers.budget.remaining())
                        if timeout <= 0 or peers.stopped.is_set():
                            raise TimeoutError
                        client = httpx.Client(
                            timeout=timeout,
                            trust_env=False,
                            follow_redirects=False,
                            transport=httpx.HTTPTransport(retries=0, trust_env=False),
                        )
                        endpoint = route.base_url.rstrip("/") + expected
                        with peers.dispatch(
                            attempt_id, client, endpoint, forwarded, route.secret
                        ) as response:
                            content_type = response.headers.get(
                                "content-type", "application/json"
                            )
                            data = bytearray()
                            for chunk in response.iter_bytes():
                                if (
                                    peers.stopped.is_set()
                                    or peers.budget.remaining() <= 0
                                ):
                                    raise TimeoutError
                                data.extend(chunk)
                                if len(data) > MAX_BODY:
                                    raise ValueError
                            raw = bytes(data)
                            decoded_raw = raw.decode("utf-8", errors="replace")
                            metadata = usage_from_response(raw, route.api_type)
                            with peers.lock:
                                if peers.capture_frozen:
                                    raise TimeoutError
                                capture["provider_status"] = response.status_code
                                capture["provider_response"] = decoded_raw
                                attempt["usage"] = metadata["usage"]
                                if metadata["model_versions"]:
                                    peers.model_versions.setdefault(role, set()).update(
                                        metadata["model_versions"]
                                    )
                                    attempt["observed_model_versions"] = metadata[
                                        "model_versions"
                                    ]
                                peers.persist_provider(capture, attempt)
                                if peers.stop_requested.is_set():
                                    raise TimeoutError
                            delivered = core.redact(
                                raw.decode("utf-8", errors="replace"),
                                [item.secret for item in peers.routes.values()],
                            ).encode()
                            if delivered != raw:
                                with peers.lock:
                                    if not peers.capture_frozen:
                                        capture["fixture_transforms"].append(
                                            {"kind": "credential_redaction"}
                                        )
                            with peers.lock:
                                renderer_fault = (
                                    role in {"local", "baseline"}
                                    and "first_renderer_attempt_invalid_structure"
                                    in peers.case.get("faults", [])
                                    and not peers.renderer_fault_claimed
                                )
                            if renderer_fault:
                                mutated, record = mutate_renderer_response(
                                    delivered, route.api_type
                                )
                                if record is not None:
                                    with peers.lock:
                                        if peers.capture_frozen:
                                            raise TimeoutError
                                        if not peers.renderer_fault_claimed:
                                            delivered = mutated
                                            peers.renderer_fault_claimed = True
                                            peers.fault_records.append(
                                                {
                                                    "kind": "first_renderer_attempt_invalid_structure",
                                                    **record,
                                                }
                                            )
                                            capture["delivered_response"] = (
                                                delivered.decode(
                                                    "utf-8", errors="replace"
                                                )
                                            )
                            with peers.lock:
                                if peers.stop_requested.is_set():
                                    raise TimeoutError
                            outcome = (
                                metadata.get(
                                    "terminal_outcome", "http_success_terminal_unknown"
                                )
                                if response.is_success
                                else "provider_http_error"
                            )
                            self.send_response(response.status_code)
                            self.send_header("Content-Type", content_type)
                            self.send_header("Content-Length", str(len(delivered)))
                            self.send_header("Connection", "close")
                            self.end_headers()
                            self.close_connection = True
                            self.wfile.write(delivered)
                    except (httpx.TimeoutException, TimeoutError):
                        outcome = "timeout"
                        try:
                            self.reply(
                                {"error": "evaluation provider deadline exceeded"}, 504
                            )
                        except (OSError, ConnectionError):
                            pass
                    except Exception as error:
                        # Provider exception messages and response headers can
                        # contain credentials. Preserve only a fixed category.
                        outcome = "transport_or_response_error"
                        peers.publish(
                            capture,
                            capture_fields={"failure_kind": type(error).__name__},
                        )
                        try:
                            self.reply(
                                {"error": "evaluation provider request failed"}, 502
                            )
                        except (OSError, ConnectionError):
                            pass
                    finally:
                        try:
                            with peers.lock:
                                if not peers.capture_frozen:
                                    if peers.stop_requested.is_set():
                                        outcome = "cancelled_at_fixture_cleanup"
                                    attempt["latency_ms"] = (
                                        time.monotonic() - started
                                    ) * 1000
                                    attempt["outcome"] = outcome
                                    capture["outcome"] = outcome
                                    peers.persist_provider(capture, attempt)
                        finally:
                            peers._close_call(attempt_id, client, final=True)

            return Handler

    return EvaluationPeers


def _request_metadata(case):
    return (
        {
            "sourcePolicy": {
                "enabledSources": ["perplexity_search", "known_url_scrape"],
                "disabledSources": ["workspace_data"],
            }
        }
        if case["id"] == "public-only"
        else {}
    )


def _message(case, workload):
    inputs = case.get("local_inputs", {})
    sections = [
        "Produce my daily summary.",
        case["prompt"],
        "This run uses only the frozen synthetic evaluation sources.",
    ]
    for key in ("message", "attachment"):
        if inputs.get(key):
            sections.append(f"Synthetic local {key}:\n{inputs[key]}")
    repeated = inputs.get("attachment_repeat")
    if repeated:
        sections.append(
            "Synthetic local attachment:\n"
            + "\n".join([repeated["text"]] * repeated["count"])
        )
    personal = (
        "skip all mail, calendar, and memory reads because workspace_data is explicitly excluded"
        if _request_metadata(case)
        else "read the synthetic mail and calendar sources"
    )
    sections.append(
        "Load daily-summary directly as the first tool call, following the "
        "production dispatcher's daily-briefing entrypoint. Apply its complete "
        "initial bundled clock, policy and required references; follow the skill "
        f"to plan sources, {personal}, and complete the briefing. "
        "No actual personal source, public website, or image is connected to this fixture."
    )
    if "weather_unavailable" in case.get("faults", []):
        sections.append(
            "Frozen source availability: weather is unavailable for this edition."
        )
    return "\n\n".join(sections)


def _measure_runtime(
    env, *, message, budget, per_run_timeout, request_metadata, journal=None
):
    import httpx
    from leaf_check import runtime_lines

    identity = str(uuid.uuid4())
    result = {
        "answer": "",
        "done": False,
        "errors": [],
        "terminal": None,
        "starts": [],
        "ends": [],
    }
    started = time.monotonic()
    try:
        timeout = min(per_run_timeout, budget.remaining())
        if timeout <= 0:
            raise TimeoutError
        with httpx.Client(
            timeout=timeout, trust_env=False, follow_redirects=False
        ) as client:
            with client.stream(
                "POST",
                env["base"] + "/v1/chat/completions",
                headers={
                    **env["headers"],
                    "x-daedalus-request-id": identity,
                    "x-conversation-id": identity,
                    "x-timezone": "UTC",
                },
                json={
                    "stream": True,
                    "messages": [{"role": "user", "content": message}],
                    "additional_props": {
                        "context_workflow_id": identity,
                        **request_metadata,
                    },
                },
            ) as response:
                response.raise_for_status()
                event_type = None
                for line in runtime_lines(response):
                    if journal:
                        journal.record("runtime_line", line)
                    if time.monotonic() - started >= timeout or budget.remaining() <= 0:
                        raise TimeoutError
                    if line.startswith("event: "):
                        event_type = line[7:]
                    if line.startswith("intermediate_data: "):
                        event = json.loads(line.split(": ", 1)[1])
                        result[
                            "ends"
                            if event["name"].startswith("Function Complete:")
                            else "starts"
                        ].append(event)
                    if line == "data: [DONE]":
                        result["done"] = True
                    elif line.startswith("data: "):
                        event = json.loads(line[6:])
                        if event_type == "error":
                            result["errors"].append(event)
                        for choice in event.get("choices", []):
                            result["answer"] += choice.get("delta", {}).get(
                                "content", ""
                            )
                            if choice.get("daedalus_terminal"):
                                result["terminal"] = choice.get("finish_reason")
    except KeyboardInterrupt:
        budget.deadline = time.monotonic()
        result["errors"].append({"kind": "KeyboardInterrupt"})
    except Exception as error:
        result["errors"].append({"kind": type(error).__name__})
    result["latency_ms"] = max(0.001, (time.monotonic() - started) * 1000)
    return result


def _renderer_executions(result):
    completed = {
        event.get("id"): event.get("payload")
        for event in result.get("ends", [])
        if event.get("name") == "Function Complete: briefing_renderer_tool"
    }
    executions = 0
    for event in result.get("starts", []):
        if event.get("name") != "Function Start: briefing_renderer_tool":
            continue
        value = completed.get(event.get("id"))
        for _ in range(4):
            if isinstance(value, str):
                if value.startswith("```html\n"):
                    executions += 1
                    break
                try:
                    value = json.loads(value)
                except ValueError:
                    break
            elif isinstance(value, dict):
                if (
                    value.get("executed") is False
                    or value.get("failure_type") == "attempt_limit"
                ):
                    break
                if "passed" in value:
                    if (
                        value.get("stage") != "input_validation"
                        or value.get("attempts_remaining", 2) < 2
                    ):
                        executions += 1
                    break
                value = value.get("content", value.get("result"))
            else:
                break
    return executions


def _canonical_contract(result, bundle, output):
    answer = result.get("answer", "")
    if (
        not answer
        or result.get("errors")
        or not result.get("done")
        or result.get("terminal") != "stop"
    ):
        return {
            "passed": False,
            "reason": "runtime did not deliver a complete supported response",
        }
    proposals = [
        event
        for event in result.get("starts", [])
        if event.get("name") == "Function Start: briefing_renderer_tool"
    ]
    executions = _renderer_executions(result)
    if executions > 2:
        return {
            "passed": False,
            "reason": "renderer execution exceeded the canonical correction bound",
        }
    skill = bundle / "daily-summary"
    try:
        renderer = runpy.run_path(str(skill / "scripts/render_daybook.py"))
        validator = runpy.run_path(str(skill / "scripts/validate_daybook.py"))
        policy_path = skill / "references/edition-policy.json"
        policy = json.loads(policy_path.read_text())
        failed_renderings = []
        for event in reversed(proposals):
            edition = event.get("payload", {}).get("edition")
            if not isinstance(edition, dict):
                continue
            try:
                document, coverage, _ = renderer["render_daybook"](
                    edition, policy, (skill / "assets/daybook-v4.html").read_text()
                )
            except Exception as error:
                failed_renderings.append(type(error).__name__)
                document = None
            if document is None:
                continue
            html_path, coverage_path = (
                output / "canonical.html",
                output / "canonical-coverage.json",
            )
            html_path.write_text(document)
            coverage_path.write_text(json.dumps(coverage))
            checked = validator["validate_daybook"](
                html_path, coverage_path, policy_path
            )
            exact = answer == f"```html\n{document}\n```"
            return {
                "passed": bool(checked.get("passed") and exact),
                "reason": "canonical validator and exact inline comparison",
                "canonical_validation": checked,
                "exact_inline_match": exact,
                "canonical_sha256": hashlib.sha256(document.encode()).hexdigest(),
                "renderer_executions": executions,
                "renderer_proposals": len(proposals),
                "failed_renderer_verifications": failed_renderings,
            }
    except Exception as error:
        return {
            "passed": None,
            "reason": "independent canonical verification unavailable",
            "failure_kind": type(error).__name__,
        }
    if "<!doctype" in answer.lower() or "<html" in answer.lower():
        return {
            "passed": False,
            "reason": "HTML did not match a successful canonical renderer execution",
        }
    return {
        "passed": None,
        "reason": "sourced text fallback requires independent editorial review",
        "renderer_executions": executions,
        "renderer_proposals": len(proposals),
    }


def execute_case(
    *,
    image,
    redis_image,
    variant,
    case,
    repetition,
    workload,
    routes,
    budget,
    bundle,
    output,
    per_run_timeout,
    max_iterations,
    max_output_tokens_per_attempt,
):
    """Run one complete image workflow, preserving partial evidence on failure."""
    for path in (ROOT / "builder", ROOT / "builder/migration", HERE):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    import yaml
    from context_isolation_http_check import configuration, register_redis
    from image_check import MemoryPeers, environment, run
    from nvidia_docs_check import secure_peer

    core, _, _, _ = _helpers(budget)
    setup_started = time.monotonic()
    setup_started_ns = time.monotonic_ns()
    journal = CaseJournal(
        output,
        {
            "case_id": case["id"],
            "variant": variant,
            "repetition": repetition,
            "workload_sha256": core.digest(workload),
            "requested_image": image,
        },
        redact=core.redact,
        secrets=[route.secret for route in routes.values()],
    )
    journal.record("phase", "setup")
    fixture_context = json.loads((bundle / "fixture-environment.json").read_text())
    if fixture_context.get("schema_version") != 2:
        raise ValueError("A reviewed faithful synthetic fixture bundle is required")
    frozen_urls = sorted({source["url"] for source in case.get("public_sources", [])})
    verifier_fixture_policy = {
        "kind": "configured_frozen_verifier_source_transport",
        "allowed_source_count": len(frozen_urls),
        "allowed_source_urls_sha256": hashlib.sha256(
            json.dumps(frozen_urls, separators=(",", ":")).encode()
        ).hexdigest(),
        "helper_sha256": hashlib.sha256(
            (HERE / "fixture_leaf_overrides.py").read_bytes()
        ).hexdigest(),
        "placeholder_and_audit_checks": "accept_exact_frozen_urls_only",
        "source_destination": "explicit_loopback_fixture",
        "unknown_urls": "rejected_before_network",
        "external_dns": False,
        "critic": "actual_configured_model",
        "verdict_substitution": False,
    }
    peers = _peers_class(MemoryPeers)(
        variant=variant,
        case=case,
        workload=workload,
        routes=routes,
        budget=budget,
        timeout=per_run_timeout,
        max_output_tokens_per_attempt=max_output_tokens_per_attempt,
        journal=journal,
    )
    observed = {
        "request_metadata": _request_metadata(case),
        "result": {
            "answer": "",
            "done": False,
            "errors": [],
            "terminal": None,
            "starts": [],
            "ends": [],
        },
        "attempts": peers.attempts,
        "captures": peers.captures,
        "source_calls": peers.source_calls,
        "fault_records": peers.fault_records,
        "image_id": None,
        "runtime_log": "",
        "effective_config": {},
        "fixture_context_sha256": hashlib.sha256(
            (bundle / "fixture-environment.json").read_bytes()
        ).hexdigest(),
        "fixture_configuration_transforms": [verifier_fixture_policy],
        "source_scope": fixture_context["scope"],
        "unavailable_mapped_skills": fixture_context["unavailable_mapped_skills"],
        "model_versions": {},
        "automatic_output_contract": {
            "passed": None,
            "reason": "fixture did not complete",
        },
    }
    journal.record(
        "observed",
        {
            key: value
            for key, value in observed.items()
            if key not in {"attempts", "captures", "source_calls", "fault_records"}
        },
    )
    root = None
    try:
        with secure_peer(peers) as secure:

            def configure(config, port, runtime_port):
                configuration(peers, secure["endpoint"], config, port, runtime_port)
                local = f"http://127.0.0.1:{port}"
                main_role = "local" if variant == "candidate" else "baseline"
                for role in ("main", "medium", "high", "xhigh"):
                    route_role = main_role if role == "main" else role
                    route = routes[route_role]
                    config["llms"][role].update(
                        base_url=f"{local}/model/{route_role}/v1",
                        api_type=route.api_type,
                        model_name=route.model_name,
                        api_key="synthetic-evaluation-proxy",
                        request_timeout=per_run_timeout,
                        max_retries=fixture_context["model_max_retries"],
                    )
                config["functions"]["source_verifier_tool"] = copy.deepcopy(
                    fixture_context["source_verifier"]
                )
                config["functions"]["source_verifier_tool"]["llm_name"] = "main"
                config["functions"]["tool_output_retriever_tool"] = copy.deepcopy(
                    fixture_context["tool_output_retriever"]
                )
                for name, settings in config["functions"].items():
                    if name in fixture_context["tool_descriptions"]:
                        settings["description"] = fixture_context["tool_descriptions"][
                            name
                        ]
                config["workflow"].update(
                    copy.deepcopy(fixture_context["workflow_defaults"])
                )
                config["workflow"].update(
                    instructions=fixture_context["workflow_instructions"],
                    tools=[*config["functions"], *config["function_groups"]],
                    daily_summary_tools=[
                        *config["functions"],
                        *config["function_groups"],
                    ],
                    max_iterations=max_iterations,
                    max_history=fixture_context["max_history"],
                    max_history_tokens=fixture_context["max_history_tokens"],
                    request_model_profiles=fixture_context["request_model_profiles"],
                    skill_model_profiles=fixture_context["skill_model_profiles"],
                    model_routes={
                        "deep": routes[main_role].model_name,
                        "deep_max": routes[main_role].model_name,
                    },
                )
                isolation = config["workflow"]["context_isolation"]
                isolation["enabled"] = variant == "candidate"
                for role, destination in isolation["destinations"].items():
                    destination["extra_body"] = _runtime_options(
                        routes["local" if role == "local" else role].extra_body
                    )
                config["telemetry"] = {
                    "endpoint": local + "/v1/traces",
                    "project": "synthetic-model-evaluation",
                    "timeout": 1,
                }

            fixture_code = (
                "from leaf_fixtures import install\ninstall()\n"
                "import os\n"
                "from fixture_leaf_overrides import install_verifier_boundaries\n"
                f"install_verifier_boundaries({frozen_urls!r}, os.environ['DAEDALUS_TEST_PEER'])\n"
                "import nat_helpers.briefing_images as images\n"
                "async def no_photo(url):\n    raise ValueError('evaluation fixture supplies no images')\n"
                "images._fetch_photo = no_photo\n"
            )
            with environment(
                image,
                redis_image,
                minimal=False,
                memory=True,
                peers=peers,
                configure=configure,
                fixture_mounts=[
                    (secure["root"], secure["root"]),
                    (bundle, Path("/skills")),
                ],
                namespace_factory=register_redis,
                fixture_files={
                    "sitecustomize.py": fixture_code,
                    "leaf_fixtures.py": (
                        ROOT / "builder/migration/leaf_fixtures.py"
                    ).read_text(),
                    "fixture_leaf_overrides.py": (
                        HERE / "fixture_leaf_overrides.py"
                    ).read_text(),
                },
                extra_env=lambda port: {
                    **secure["environment"],
                    "DAEDALUS_PREPARATION": "rust",
                    "DAEDALUS_AUTHORIZATION": "rust",
                    "PYTHONPATH": "/fixture:/workspace",
                    "DAEDALUS_TEST_PEER": f"http://127.0.0.1:{port}",
                    "LLM_SANDBOX_BASE_URL": secure["endpoint"],
                    "TZ": "UTC",
                },
            ) as env:
                root = env["root"]
                observed["fixture_readiness_ms"] = env["readiness_ms"]
                observed["image_id"] = run(
                    "docker",
                    "inspect",
                    env["container"],
                    "--format",
                    "{{.Image}}",
                    capture_output=True,
                    text=True,
                ).stdout.strip()
                observed["effective_config"] = _safe_config(
                    yaml.safe_load((root / "config.yaml").read_text())
                )
                observed["forwarder_policy"] = {
                    "max_output_tokens_per_attempt": max_output_tokens_per_attempt,
                    "transport_retries": 0,
                    "follow_redirects": False,
                    "trust_env": False,
                    "response_mode": "buffered actual upstream bytes before fixture transformations",
                    "first_token_latency_comparable": False,
                    "source_verifier": verifier_fixture_policy,
                    "internal_critic_routing": (
                        "baseline critic and coordinator use the configured fixed-deep route; "
                        "production critic retains its static main route while the skill "
                        "can promote the coordinator, so critic cost/latency may differ"
                    ),
                }
                journal.record(
                    "observed",
                    {
                        "image_id": observed["image_id"],
                        "effective_config": observed["effective_config"],
                    },
                )
                journal.record("phase", "workflow")
                observed["result"] = _measure_runtime(
                    env,
                    message=_message(case, workload),
                    budget=budget,
                    per_run_timeout=per_run_timeout,
                    request_metadata=observed["request_metadata"],
                    journal=journal,
                )
                observed["effective_config"]["evaluation_request_metadata"] = observed[
                    "request_metadata"
                ]
                observed["automatic_output_contract"] = _canonical_contract(
                    observed["result"], bundle, output
                )
                observed["runtime_log"] = (root / "backend.log").read_text()
    except KeyboardInterrupt:
        budget.deadline = time.monotonic()
        observed["result"]["errors"].append({"kind": "KeyboardInterrupt"})
        observed["fixture_failure_kind"] = "KeyboardInterrupt"
        observed["automatic_output_contract"] = {
            "passed": False,
            "reason": "operator interrupted the evaluation",
        }
    except Exception as error:
        observed["result"]["errors"].append({"kind": type(error).__name__})
        observed["fixture_failure_kind"] = type(error).__name__
        observed["automatic_output_contract"] = {
            "passed": False,
            "reason": "fixture or runtime execution failed",
        }
    finally:
        try:
            journal.record("phase", "cleanup")
        except (Exception, KeyboardInterrupt) as error:
            budget.deadline = time.monotonic()
            observed["journal_failure_kind"] = type(error).__name__
        try:
            peers.stop()
        except (Exception, KeyboardInterrupt) as error:
            budget.deadline = time.monotonic()
            observed["result"]["errors"].append({"kind": type(error).__name__})
            observed["fixture_failure_kind"] = type(error).__name__
            observed["automatic_output_contract"] = {
                "passed": False,
                "reason": "fixture cleanup did not complete",
            }
            with peers.lock:
                for attempt in peers.attempts:
                    if attempt["outcome"] == "in_flight":
                        attempt["outcome"] = "unknown_after_cleanup_failure"
                        attempt["latency_ms"] = (
                            time.monotonic() - peers.attempt_started[attempt["id"]]
                        ) * 1000
                        attempt["latency_scope"] = "observed until cleanup failure"
                peers.fault_records.append(
                    {
                        "kind": "fixture_cleanup_failure",
                        "failure_kind": type(error).__name__,
                        "provider_completion": "unknown",
                    }
                )
                peers.capture_frozen = True
        observed["fixture_total_ms"] = (time.monotonic() - setup_started) * 1000
        if "latency_ms" not in observed["result"]:
            observed["result"]["latency_ms"] = (
                time.monotonic_ns() - setup_started_ns
            ) / 1_000_000
            observed["latency_scope"] = (
                "observed fixture elapsed through failure and cleanup; no completed workflow latency"
            )
    with peers.lock:
        snapshot = dict(observed)
        snapshot["model_versions"] = {
            role: sorted(versions) for role, versions in peers.model_versions.items()
        }
        for key in ("attempts", "captures", "source_calls", "fault_records"):
            snapshot[key] = copy.deepcopy(observed[key])
        snapshot["internal_verification_model_attempts"] = sum(
            attempt.get("phase") == "internal_tool_verification"
            for attempt in snapshot["attempts"]
        )
    snapshot = core.redact(snapshot, [route.secret for route in routes.values()])
    try:
        journal.record(
            "observed",
            {
                key: value
                for key, value in snapshot.items()
                if key not in {"attempts", "captures"}
            },
        )
        by_id = {attempt["id"]: attempt for attempt in snapshot["attempts"]}
        for capture in snapshot["captures"]:
            journal.record(
                "provider",
                {"capture": capture, "attempt": by_id.get(capture.get("attempt_id"))},
            )
    except (Exception, KeyboardInterrupt) as error:
        budget.deadline = time.monotonic()
        snapshot["result"]["errors"].append({"kind": type(error).__name__})
        snapshot["journal_failure_kind"] = type(error).__name__
        snapshot["automatic_output_contract"] = {
            "passed": False,
            "reason": "durable fixture capture failed",
        }
    return snapshot
