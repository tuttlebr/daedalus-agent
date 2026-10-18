#!/usr/bin/env python3
"""Exercise the actual runtime over HTTP against deterministic model/MCP peers.

Use --image for the deployable artifact, or --binary for a local Rust build.
No external model, credential, cluster, or user data is accessed.
"""

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import select
import shutil
import socket
import subprocess  # nosec B404 - disposable local fixture, explicit argv
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import yaml


class Peers:
    def __init__(self):
        self.requests = []
        self.routing_sessions = []
        self.calls = []
        self.model_waiting = threading.Event()
        self.model_disconnected = threading.Event()
        self.tool_waiting = threading.Event()
        self.release_model = threading.Event()
        self.release_tool = threading.Event()
        self.tool_disconnected = threading.Event()
        self.image_waiting = threading.Event()
        self.image_disconnected = threading.Event()

    def handler(self):
        peers = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def reply(self, value, status=200):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def event(self, value):
                if self.gateway:
                    # Match Switchyard's live Responses envelope: content and
                    # output indices are present, bookkeeping may be omitted.
                    value = json.loads(json.dumps(value))
                    value.pop("sequence_number", None)
                    value.pop("item_id", None)
                    response = value.get("response", {})
                    response.pop("created_at", None)
                    items = response.get("output", [])
                    if value["type"] == "response.output_item.done":
                        items = [*items, value["item"]]
                    for item in items:
                        if item["type"] == "message":
                            item.pop("id", None)
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()

            def wait_for_disconnect(self, closed, release=None):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if release and release.is_set():
                        return False
                    readable, _, _ = select.select([self.connection], [], [], 0.05)
                    if readable:
                        try:
                            disconnected = not self.connection.recv(1, socket.MSG_PEEK)
                        except ConnectionResetError:
                            disconnected = True
                        if disconnected:
                            closed.set()
                            self.close_connection = True
                            return True
                return False

            def do_POST(self):
                body = json.loads(
                    self.rfile.read(int(self.headers.get("Content-Length", 0)))
                )
                if self.path == "/v1/images/generations":
                    if body.get("stream"):
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.end_headers()
                        self.wfile.write(b": image provider waiting\n\n")
                        self.wfile.flush()
                    peers.image_waiting.set()
                    self.wait_for_disconnect(peers.image_disconnected)
                    return
                if self.path == "/mcp":
                    method = body["method"]
                    if "id" not in body:
                        self.reply({}, 202)
                        return
                    if method == "initialize":
                        result = {
                            "protocolVersion": body["params"]["protocolVersion"],
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "fixture", "version": "1"},
                        }
                    elif method == "tools/list":
                        result = {
                            "tools": [
                                {
                                    "name": name,
                                    "description": name,
                                    "annotations": {
                                        "readOnlyHint": name
                                        in ("slow_read", "next_read"),
                                        "destructiveHint": name
                                        in ("write_item", "conflicting_read"),
                                    },
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {"private": {"type": "string"}},
                                        "additionalProperties": False,
                                    },
                                }
                                for name in (
                                    "slow_read",
                                    "next_read",
                                    "write_item",
                                    "conflicting_read",
                                )
                            ]
                        }
                    elif method == "tools/call":
                        name = body["params"]["name"]
                        peers.calls.append(name)
                        if name == "slow_read":
                            peers.tool_waiting.set()
                            if self.wait_for_disconnect(
                                peers.tool_disconnected, peers.release_tool
                            ):
                                return
                        result = {
                            "content": [{"type": "text", "text": "RETAINED_EVIDENCE"}],
                            "isError": False,
                        }
                        if (
                            body["params"].get("arguments", {}).get("private")
                            == "LARGE_TOOL"
                        ):
                            # Baseline compaction selects a top-level array.
                            # A JSON string nested in one text block is opaque.
                            result["content"] = [
                                {"type": "text", "text": f"{i}: " + "雪" * 5000}
                                for i in range(700)
                            ]
                        elif (
                            body["params"].get("arguments", {}).get("private")
                            == "LARGE_OPAQUE"
                        ):
                            result["content"][0]["text"] = "雪" * 3_500_000
                    else:
                        self.reply(
                            {
                                "jsonrpc": "2.0",
                                "id": body["id"],
                                "error": {"code": -32601, "message": "Unknown method"},
                            }
                        )
                        return
                    self.reply({"jsonrpc": "2.0", "id": body["id"], "result": result})
                    return
                if self.path != "/v1/responses":
                    self.reply({"error": "unexpected endpoint"}, 404)
                    return
                peers.requests.append(body)
                peers.routing_sessions.append(
                    self.headers.get("x-switchyard-session-id")
                )
                self.gateway = "GATEWAY" in json.dumps(body)
                if (
                    "RETRY_MODEL" in json.dumps(body)
                    and sum("RETRY_MODEL" in json.dumps(old) for old in peers.requests)
                    == 1
                ):
                    self.reply({"error": {"message": "PRIVATE_PROVIDER_ERROR"}}, 503)
                    return
                if "PROVIDER_FAILURE" in json.dumps(body):
                    self.reply({"error": {"message": "PRIVATE_PROVIDER_ERROR"}}, 400)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                try:
                    self.model_response(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def model_response(self, body):
                if self.gateway:
                    self.event(
                        {
                            "type": "response.created",
                            "response": {
                                "id": "resp_fixture",
                                "object": "response",
                                "model": "fixture",
                                "status": "in_progress",
                                "output": [],
                            },
                        }
                    )
                serialized = json.dumps(body.get("input", []))
                redirected = "NEW_DIRECTION" in serialized
                has_result = "function_call_output" in serialized
                result_count = sum(
                    item.get("type") == "function_call_output"
                    for item in body.get("input", [])
                )
                scenario = next(
                    (
                        name
                        for name in (
                            "CONTRACT_REPAIR",
                            "CONTRACT_MULTI_REPAIR",
                            "CONTRACT_LATER_REPAIR",
                            "CONTRACT_REPEAT_AFTER_PROGRESS",
                            "CONTRACT_BAD_BATCH_ALWAYS",
                            "CONTRACT_UNKNOWN",
                            "CONTRACT_DUPLICATE",
                            "CONTRACT_REUSED",
                            "REQUIRED_MISSING",
                            "REQUIRED_RECOVER",
                            "OMITTED_TOOL_RECOVER",
                            "MODEL_STEER",
                            "MODEL_PROGRESS",
                            "TOOL_STEER",
                            "OUTPUT_RETRIEVAL",
                            "APPROVAL",
                            "POLICY_CONFLICT",
                            "RENDERER_FALLBACK",
                            "SKILL_ROUTE",
                            "DEFERRED_DISCOVERY",
                            "DEFERRED_REQUIRED",
                            "INCOMPLETE",
                            "STREAM_RECOVER",
                            "STREAM_TRUNCATED",
                            "STREAM_TOOL_CUT",
                            "STREAM_ALWAYS_FAIL",
                            "STREAM_PERMANENT",
                            "STREAM_JSON_RECOVER",
                            "STREAM_JSON_SYNTAX",
                            "STREAM_JSON_ALWAYS_FAIL",
                            "STREAM_JSON_TOOL_CUT",
                            "STREAM_JSON_TWICE",
                        )
                        if name in serialized
                    ),
                    "BASIC",
                )
                latest_user = next(
                    (
                        item
                        for item in reversed(body.get("input", []))
                        if item.get("role") == "user"
                    ),
                    {},
                )
                if "OUTPUT_RETRIEVAL" in json.dumps(latest_user):
                    scenario = "OUTPUT_RETRIEVAL"
                    redirected = False
                for marker in [
                    "MEMORY_WRITE",
                    "MEMORY_READ",
                    "DOCUMENT_SEARCH",
                    "DOMAIN_SEARCH",
                    "WEB_SEARCH",
                    "NWS_WEATHER",
                    "USER_INTERACTION_CONFIRM",
                    "SKILL_LOAD",
                    "SANDBOX_WRITE",
                    "SANDBOX_READ",
                    "SANDBOX_PUBLISH",
                ]:
                    if marker in json.dumps(latest_user):
                        scenario = marker
                        redirected = False
                outputs = []
                attempt = sum(
                    scenario in json.dumps(old.get("input", []))
                    and ("function_call_output" in json.dumps(old.get("input", [])))
                    == has_result
                    for old in peers.requests
                )
                if redirected:
                    if scenario == "TOOL_STEER":
                        assert "RETAINED_EVIDENCE" in serialized  # nosec B101 - executable contract check
                        assert "Not executed:" in serialized  # nosec B101 - executable contract check
                    text = (
                        "Directed answer with retained evidence"
                        if has_result
                        else "Directed answer"
                    )
                elif scenario == "MODEL_STEER":
                    item = {
                        "type": "function_call",
                        "id": "fc_partial",
                        "call_id": "partial",
                        "name": "fixture_mcp__next_read",
                        "arguments": "",
                        "status": "in_progress",
                    }
                    self.event(
                        {
                            "type": "response.output_item.added",
                            "output_index": 0,
                            "sequence_number": 1,
                            "item": item,
                        }
                    )
                    self.event(
                        {
                            "type": "response.function_call_arguments.delta",
                            "output_index": 0,
                            "item_id": "fc_partial",
                            "sequence_number": 2,
                            "delta": "{",
                        }
                    )
                    peers.model_waiting.set()
                    self.wait_for_disconnect(
                        peers.model_disconnected, peers.release_model
                    )
                    return
                elif scenario == "MODEL_PROGRESS":
                    for sequence in range(2):
                        if sequence:
                            time.sleep(16)
                        self.event(
                            {
                                "type": "response.reasoning_text.delta",
                                "output_index": 0,
                                "item_id": "rs_progress",
                                "sequence_number": sequence,
                                "delta": "PRIVATE_MODEL_REASONING",
                            }
                        )
                    text = "Visible answer after active model generation."
                elif (
                    scenario == "RENDERER_FALLBACK"
                    and body.get("tool_choice") == "none"
                    and "IGNORE_FALLBACK" not in serialized
                ):
                    assert not body.get("tools")  # nosec B101
                    assert result_count == 4  # nosec B101 - clock, rejected renderer twice, valid sibling
                    assert "HTML edition could not be validated" in serialized  # nosec B101
                    assert "function_call_output" in serialized  # nosec B101
                    text = "The HTML edition could not be validated. Sourced briefing from retained evidence."
                elif (
                    "Tools with repeated invalid arguments have been disabled"
                    in serialized
                    and "IGNORE_FALLBACK" not in serialized
                ):
                    text = "Completed available work; invalid tool unavailable."
                elif scenario == "REQUIRED_MISSING" or (
                    scenario in ("REQUIRED_RECOVER", "OMITTED_TOOL_RECOVER")
                    and not has_result
                    and attempt == 1
                ):
                    text = "UNSUPPORTED_CLAIM_WITHOUT_TOOL"
                elif "TEXT_ONLY" in serialized:
                    text = "Synthetic text response 雪🌲."
                elif (
                    not has_result
                    or (
                        scenario in ("CONTRACT_MULTI_REPAIR", "CONTRACT_LATER_REPAIR")
                        and result_count < 4
                    )
                    or (
                        scenario == "CONTRACT_REPEAT_AFTER_PROGRESS"
                        and result_count < 3
                    )
                    or scenario == "CONTRACT_BAD_BATCH_ALWAYS"
                    or scenario == "RENDERER_FALLBACK"
                    or (
                        scenario
                        in ("CONTRACT_REPAIR", "CONTRACT_UNKNOWN", "CONTRACT_REUSED")
                        and result_count == (2 if scenario == "CONTRACT_REPAIR" else 1)
                    )
                    or (
                        scenario == "DEFERRED_DISCOVERY"
                        and "RETAINED_EVIDENCE" not in serialized
                    )
                    or (
                        scenario == "STREAM_JSON_TWICE"
                        and result_count == 1
                        and attempt > 1
                    )
                ):
                    names = (
                        ["llm_sandbox_tool"]
                        if scenario.startswith("SANDBOX_")
                        else ["agent_skills_tool"]
                        if scenario == "SKILL_LOAD"
                        else ["user_interaction"]
                        if scenario == "USER_INTERACTION_CONFIRM"
                        else ["web_search"]
                        if scenario == "WEB_SEARCH"
                        else ["nws_weather_tool"]
                        if scenario == "NWS_WEATHER"
                        else ["domain_search"]
                        if scenario == "DOMAIN_SEARCH"
                        else ["user_documents"]
                        if scenario == "DOCUMENT_SEARCH"
                        else ["add_memory"]
                        if scenario == "MEMORY_WRITE"
                        else ["get_memory"]
                        if scenario == "MEMORY_READ"
                        else ["tool_output_retriever_tool"]
                        if scenario == "OUTPUT_RETRIEVAL"
                        else [
                            "current_datetime_tool"
                            if result_count < 2
                            else "agent_skills_tool"
                        ]
                        if scenario == "CONTRACT_MULTI_REPAIR"
                        else ["current_datetime_tool"]
                        if scenario == "CONTRACT_LATER_REPAIR"
                        else [
                            "fixture_mcp__next_read"
                            if result_count == 1
                            else "current_datetime_tool"
                        ]
                        if scenario == "CONTRACT_REPEAT_AFTER_PROGRESS"
                        else ["fixture_mcp__next_read", "current_datetime_tool"]
                        if scenario == "CONTRACT_BAD_BATCH_ALWAYS"
                        else ["fixture_mcp__next_read", "current_datetime_tool"]
                        if scenario in ("CONTRACT_REPAIR", "CONTRACT_DUPLICATE")
                        else ["invented_tool"]
                        if scenario == "CONTRACT_UNKNOWN" and not has_result
                        else ["fixture_mcp__next_read"]
                        if scenario == "CONTRACT_REUSED"
                        else [
                            "fixture_deferred__next_read"
                            if has_result
                            else "fixture_deferred__connect"
                        ]
                        if scenario == "DEFERRED_DISCOVERY"
                        else ["fixture_deferred__next_read"]
                        if scenario == "DEFERRED_REQUIRED"
                        else ["agent_skills_tool"]
                        if scenario == "SKILL_ROUTE"
                        else ["fixture_mcp__write_item", "fixture_second__slow_read"]
                        if scenario == "APPROVAL"
                        else ["fixture_mcp__conflicting_read", "current_datetime_tool"]
                        if scenario == "POLICY_CONFLICT"
                        else ["briefing_renderer_tool", "fixture_mcp__next_read"]
                        if scenario == "RENDERER_FALLBACK" and has_result
                        else ["fixture_mcp__slow_read", "fixture_mcp__next_read"]
                        if scenario == "TOOL_STEER"
                        else ["fixture_mcp__next_read"]
                        if "LARGE_TOOL" in serialized or "LARGE_OPAQUE" in serialized
                        else ["fixture_mcp__next_read"]
                        if scenario == "STREAM_JSON_TWICE" and has_result
                        else ["fixture_mcp__next_read"]
                        if scenario == "STREAM_TOOL_CUT" and attempt == 1
                        else ["current_datetime_tool"]
                    )
                    if has_result and scenario in (
                        "CONTRACT_REPAIR",
                        "CONTRACT_BAD_BATCH_ALWAYS",
                    ):
                        names = ["current_datetime_tool"]
                    if (
                        has_result
                        and scenario == "RENDERER_FALLBACK"
                        and result_count >= 3
                    ):
                        names = ["briefing_renderer_tool"]
                    for index, name in enumerate(names):
                        arguments = (
                            json.dumps(
                                {
                                    "operation": {
                                        "SANDBOX_WRITE": "write_file",
                                        "SANDBOX_READ": "read_file",
                                        "SANDBOX_PUBLISH": "publish_file",
                                    }[scenario],
                                    "file_path": "reports/browser-report.txt",
                                    **(
                                        {
                                            "file_content": "Synthetic browser artifact 雪🌲\n"
                                        }
                                        if scenario == "SANDBOX_WRITE"
                                        else {}
                                    ),
                                }
                            )
                            if name == "llm_sandbox_tool"
                            else json.dumps(
                                {
                                    "latitude": 42.3,
                                    "longitude": -83.1,
                                    "include_observations": True,
                                }
                            )
                            if name == "nws_weather_tool"
                            else json.dumps(
                                {
                                    "operation": "confirm_action",
                                    "action": "Remove browser memories",
                                    "reason": "Synthetic browser confirmation",
                                    "risks": "Saved preferences will be removed",
                                }
                            )
                            if name == "user_interaction"
                            else json.dumps(
                                {
                                    "query": [
                                        "Synthetic browser search",
                                        "Synthetic related search",
                                    ]
                                }
                            )
                            if name == "web_search"
                            else json.dumps(
                                {
                                    "query": "Synthetic indexed domain",
                                    "domain": "nvidia",
                                }
                            )
                            if name == "domain_search"
                            else json.dumps(
                                {
                                    "operation": "search",
                                    "query": "Synthetic indexed document",
                                }
                            )
                            if name == "user_documents"
                            else json.dumps({"memory": "Browser preference 雪🌲"})
                            if name == "add_memory"
                            else json.dumps({"query": "Browser preference"})
                            if name == "get_memory"
                            else json.dumps(
                                {"reference": peers.retrieval_reference, "offset": 1}
                            )
                            if name == "tool_output_retriever_tool"
                            else json.dumps({"private": "LARGE_TOOL"})
                            if "LARGE_TOOL" in serialized
                            else json.dumps({"private": "LARGE_OPAQUE"})
                            if "LARGE_OPAQUE" in serialized
                            else json.dumps({"extra": None, "雪🌲": False})
                            if name == "current_datetime_tool"
                            and "CLOCK_EXTRA" in serialized
                            else "null"
                            if name == "current_datetime_tool"
                            and "CLOCK_NULL" in serialized
                            else json.dumps(
                                {
                                    "operation": "load_skill",
                                    "skill_name": "fixture-skill",
                                }
                            )
                            if name == "agent_skills_tool"
                            else json.dumps({"private": "PRIVATE_TOOL_ARGUMENT"})
                            if name.endswith("slow_read")
                            else "{}"
                        )
                        if name == "current_datetime_tool" and (
                            scenario == "CONTRACT_BAD_BATCH_ALWAYS"
                            or (scenario == "CONTRACT_REPAIR" and not has_result)
                            or (
                                scenario
                                in (
                                    "CONTRACT_MULTI_REPAIR",
                                    "CONTRACT_LATER_REPAIR",
                                    "CONTRACT_REPEAT_AFTER_PROGRESS",
                                )
                                and result_count in (0, 2)
                            )
                        ):
                            arguments = '{"extra":"PRIVATE_INVALID_ARGUMENT"}'
                        if scenario == "CONTRACT_MULTI_REPAIR" and result_count == 2:
                            arguments = '{"operation":"load_skill"}'
                        if (
                            scenario == "RENDERER_FALLBACK"
                            and name == "briefing_renderer_tool"
                        ):
                            arguments = json.dumps(
                                {"edition": '{"private":"PRIVATE_INVALID_EDITION"}'}
                            )
                        item = {
                            "type": "function_call",
                            "id": f"fc_{index}",
                            "call_id": "duplicate"
                            if scenario == "CONTRACT_DUPLICATE"
                            else "reused"
                            if scenario == "CONTRACT_REUSED"
                            else f"call_{len(peers.requests)}_{index}",
                            "name": name,
                            "arguments": "",
                            "status": "in_progress",
                        }
                        self.event(
                            {
                                "type": "response.output_item.added",
                                "output_index": index,
                                "sequence_number": index * 4,
                                "item": item,
                            }
                        )
                        self.event(
                            {
                                "type": "response.function_call_arguments.delta",
                                "output_index": index,
                                "item_id": item["id"],
                                "sequence_number": index * 4 + 1,
                                "delta": arguments,
                            }
                        )
                        item = {
                            **item,
                            "arguments": arguments,
                            "status": "completed",
                        }
                        self.event(
                            {
                                "type": "response.output_item.done",
                                "output_index": index,
                                "sequence_number": index * 4 + 2,
                                "item": item,
                            }
                        )
                        outputs.append(item)
                    text = None
                else:
                    text = (
                        ("First part. " if attempt == 1 else "Recovered final answer.")
                        if scenario
                        in (
                            "STREAM_RECOVER",
                            "STREAM_TRUNCATED",
                            "STREAM_JSON_RECOVER",
                            "STREAM_JSON_SYNTAX",
                        )
                        else ("The real datetime tool completed")
                    )
                    if scenario == "DOCUMENT_SEARCH":
                        result = next(
                            item["output"]
                            for item in body["input"]
                            if item.get("type") == "function_call_output"
                        )
                        assert "Synthetic indexed 雪🌲" in result  # nosec B101 - browser evidence
                        text = "Retrieved indexed document: Synthetic indexed 雪🌲"
                    if scenario == "DOMAIN_SEARCH":
                        result = next(
                            item["output"]
                            for item in reversed(body["input"])
                            if item.get("type") == "function_call_output"
                        )
                        payload = json.loads(result)
                        assert payload["domain"] == "nvidia"  # nosec B101 - browser contract
                        assert payload["ranking_status"] == "vector_only"  # nosec B101
                        assert (
                            payload["results"][0]["content"] == "Synthetic indexed 雪🌲"
                        )  # nosec B101
                        text = "Retrieved domain passage: Synthetic indexed 雪🌲"
                    if scenario == "SKILL_LOAD":
                        text = next(
                            item["output"]
                            for item in reversed(body["input"])
                            if item.get("type") == "function_call_output"
                        )
                        assert "Loaded skill evidence 雪🌲" in text  # nosec B101 - browser contract
                        assert "resource.txt" in text  # nosec B101
                        assert body["model"] == "fixture/deep"  # nosec B101
                    if scenario.startswith("SANDBOX_"):
                        result = next(
                            item["output"]
                            for item in reversed(body["input"])
                            if item.get("type") == "function_call_output"
                        )
                        if scenario == "SANDBOX_PUBLISH":
                            assert "DAEDALUS_SANDBOX_ARTIFACT_REF_V1:" in result  # nosec B101 - private backend transport
                            assert "/api/session/documentStorage?" in result  # nosec B101
                            text = "Published browser artifact: [browser-report.txt](reports/browser-report.txt)"
                        elif scenario == "SANDBOX_READ":
                            assert "Synthetic browser artifact" in result  # nosec B101
                            text = "Verified browser artifact contents."
                        else:
                            assert "Conversation workspace persisted: True" in result  # nosec B101
                            text = (
                                "Wrote browser artifact to its conversation workspace."
                            )
                    if scenario == "USER_INTERACTION_CONFIRM":
                        text = next(
                            item["output"]
                            for item in reversed(body["input"])
                            if item.get("type") == "function_call_output"
                        )
                        assert "No executable credential has been created." in text  # nosec B101 - browser contract
                        assert "target=`e2e-user`" in text  # nosec B101
                    if scenario == "WEB_SEARCH":
                        result = next(
                            item["output"]
                            for item in reversed(body["input"])
                            if item.get("type") == "function_call_output"
                        )
                        payload = json.loads(
                            result.split("<searchresults>", 1)[1].split(
                                "</searchresults>", 1
                            )[0]
                        )
                        assert payload["search_info"]["total_results"] == 2  # nosec B101 - browser contract
                        assert payload["queries"] == [
                            "Synthetic browser search",
                            "Synthetic related search",
                        ]  # nosec B101
                        text = result
                    if scenario == "NWS_WEATHER":
                        result = next(
                            item["output"]
                            for item in reversed(body["input"])
                            if item.get("type") == "function_call_output"
                        )
                        payload = json.loads(result)
                        assert payload["location"]["city"] == "Synthetic 雪🌲"  # nosec B101 - browser contract
                        assert payload["forecast"]["coverage"]["complete"]  # nosec B101
                        assert payload["observations"]["observation"][
                            "temperature"
                        ] == {"value": 20, "unitCode": "wmoUnit:degC"}  # nosec B101
                        if payload["alerts"]["status"] == "unavailable":
                            assert payload["status"] == "partial"  # nosec B101
                            alert = "Alerts are unavailable."
                        else:
                            assert payload["status"] == "ok"  # nosec B101
                            assert (
                                payload["alerts"]["items"][0]["headline"]
                                == "Synthetic alert"
                            )  # nosec B101
                            alert = "Synthetic alert is active."
                        text = f"Weather for Synthetic 雪🌲: 20 °C. Forecast coverage is complete. {alert}\n\n[NWS forecast]({payload['forecast']['source_url']})"
                    if scenario == "OUTPUT_RETRIEVAL":
                        result = next(
                            item
                            for item in body["input"]
                            if item.get("type") == "function_call_output"
                        )
                        payload = json.loads(result["output"])
                        assert payload["mode"] == "exact_page"  # nosec B101 - browser contract
                        assert payload["content"] == peers.retrieval_content[1:]  # nosec B101
                        text = "Recovered exact cached output: " + payload["content"]
                    if scenario in ["MEMORY_WRITE", "MEMORY_READ"]:
                        result = next(
                            item["output"]
                            for item in body["input"]
                            if item.get("type") == "function_call_output"
                        )
                        if scenario == "MEMORY_WRITE":
                            assert (
                                result
                                == "Memory added successfully. You can continue. Please respond to the user."
                            )  # nosec B101
                            text = "Saved memory through the native tool."
                        else:
                            memories = json.loads(
                                result.removeprefix("Memories as a JSON: \n")
                            )
                            assert memories[0]["text"] == "Browser preference 雪🌲"  # nosec B101
                            text = "Recalled memory: " + memories[0]["text"]
                if text:
                    item = {
                        "type": "message",
                        "id": "msg_fixture",
                        "status": "in_progress",
                        "role": "assistant",
                        "content": [],
                    }
                    self.event(
                        {
                            "type": "response.output_item.added",
                            "output_index": 0,
                            "sequence_number": 0,
                            "item": item,
                        }
                    )
                    self.event(
                        {
                            "type": "response.output_text.delta",
                            "output_index": 0,
                            "content_index": 0,
                            "item_id": item["id"],
                            "sequence_number": 1,
                            "delta": text,
                        }
                    )
                    if self.gateway:
                        self.event(
                            {
                                "type": "response.content_part.done",
                                "output_index": 0,
                                "content_index": 0,
                                "part": {"type": "output_text", "text": text},
                            }
                        )
                    item = {
                        **item,
                        "status": "completed",
                        "content": [
                            {"type": "output_text", "text": text, "annotations": []}
                        ],
                    }
                    self.event(
                        {
                            "type": "response.output_item.done",
                            "output_index": 0,
                            "sequence_number": 2,
                            "item": item,
                        }
                    )
                    outputs = [item]
                if (
                    (
                        scenario in ("STREAM_JSON_RECOVER", "STREAM_JSON_SYNTAX")
                        and has_result
                        and attempt == 1
                    )
                    or (scenario == "STREAM_JSON_ALWAYS_FAIL" and has_result)
                    or (
                        scenario == "STREAM_JSON_TOOL_CUT"
                        and not has_result
                        and attempt == 1
                    )
                    or (
                        scenario == "STREAM_JSON_TWICE"
                        and has_result
                        and (result_count > 1 or attempt == 1)
                    )
                ):
                    # Even a valid, completed mutation proposal must be discarded
                    # when a later frame makes the entire response undecodable.
                    self.event(
                        {
                            "type": "response.output_item.done",
                            "output_index": 1,
                            "sequence_number": 3,
                            "item": {
                                "type": "function_call",
                                "id": "fc_unexecuted_write",
                                "call_id": "unexecuted_write",
                                "name": "fixture_mcp__write_item",
                                "arguments": '{"private":"PRIVATE_TOOL_ARGUMENT"}',
                                "status": "completed",
                            },
                        }
                    )
                    if scenario == "STREAM_JSON_SYNTAX":
                        self.wfile.write(b'data: {"type":"PRIVATE_PROVIDER_ERROR",\n\n')
                        self.wfile.flush()
                    else:
                        self.event(
                            {
                                "type": "response.output_text.delta",
                                "output_index": 0,
                                "content_index": 0,
                                "sequence_number": 4,
                                "delta": {"private": "PRIVATE_PROVIDER_ERROR"},
                            }
                        )
                    return
                if (
                    (
                        scenario in ("STREAM_RECOVER", "STREAM_TRUNCATED")
                        and has_result
                        and attempt == 1
                    )
                    or (
                        scenario == "STREAM_TOOL_CUT"
                        and not has_result
                        and attempt == 1
                    )
                    or scenario in ("STREAM_ALWAYS_FAIL", "STREAM_PERMANENT")
                ):
                    if scenario != "STREAM_TRUNCATED":
                        # Exact Switchyard SSE failure shape. A completed item
                        # is not a completed response and must never run tools.
                        self.event(
                            {
                                "type": "error",
                                "error": {
                                    "type": "SwitchyardError",
                                    "message": (
                                        "upstream transport error: error decoding response body"
                                        if scenario != "STREAM_PERMANENT"
                                        else "failed to translate invalid request PRIVATE_PROVIDER_ERROR"
                                    ),
                                },
                            }
                        )
                    return
                incomplete = scenario == "INCOMPLETE"
                response = {
                    "id": "resp_fixture",
                    "object": "response",
                    "created_at": 1,
                    "status": "incomplete" if incomplete else "completed",
                    "error": None,
                    "incomplete_details": {"reason": "max_output_tokens"}
                    if incomplete
                    else None,
                    "instructions": None,
                    "max_output_tokens": None,
                    "model": "fixture",
                    "output": outputs,
                    "tools": [],
                    "usage": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "total_tokens": 2,
                        "input_tokens_details": {"cached_tokens": 0},
                        "output_tokens_details": {"reasoning_tokens": 0},
                    },
                }
                self.event(
                    {
                        "type": "response.incomplete"
                        if incomplete
                        else "response.completed",
                        "response": response,
                        "sequence_number": 20,
                    }
                )

        return Handler


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def check(image=None, binary=None, redis_image=None, preparation="rust", report=None):
    if os.sys.flags.optimize:
        raise RuntimeError("Run runtime contracts without Python optimization")
    docker = shutil.which("docker")
    if (image or redis_image) and not docker:
        raise RuntimeError("Docker is required for image contract checks")
    peers = Peers()
    peer_server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
    peer_server.daemon_threads = True
    threading.Thread(target=peer_server.serve_forever, daemon=True).start()
    model_port = peer_server.server_port
    runtime_port, tools_port = free_port(), free_port()
    token = uuid.uuid4().hex
    headers = {"x-daedalus-internal-token": token, "x-user-id": "alice"}
    config = {
        "functions": {"current_datetime_tool": {"_type": "current_datetime"}},
        "function_groups": {
            "fixture_mcp": {
                "_type": "mcp_client",
                "server": {
                    "transport": "streamable-http",
                    "url": f"http://127.0.0.1:{model_port}/mcp",
                },
                "tool_overrides": {
                    name: {"approval_policy": "read_only"}
                    for name in ("slow_read", "next_read", "conflicting_read")
                },
            }
        },
        "llms": {
            "main": {
                "_type": "openai",
                "api_type": "responses",
                "api_key": "PRIVATE_MODEL_CREDENTIAL",
                "base_url": f"http://127.0.0.1:{model_port}/v1",
                "model_name": "fixture",
                # Existing deployments configure a one-hour model timeout.
                # Exercise actual service startup with that configuration.
                "request_timeout": 3600,
            }
        },
        "workflow": {
            "_type": "daedalus_rust_agent",
            "llm_name": "main",
            "tools": ["current_datetime_tool", "fixture_mcp"],
            "max_iterations": 8,
            "parallel_tool_calls": True,
            "tool_output_compaction_enabled": bool(redis_image),
            "instructions": "Follow user directions and retain completed tool results.",
        },
    }
    config["function_groups"]["fixture_second"] = config["function_groups"][
        "fixture_mcp"
    ]
    config["workflow"]["tools"].append("fixture_second")
    config["function_groups"]["fixture_deferred"] = {
        **config["function_groups"]["fixture_mcp"],
        "defer_discovery": True,
        "discovery_description": "Read fixture evidence after discovering its tools.",
        "initial_tools": ["slow_read"],
        "include": ["slow_read", "next_read"],
        "tool_overrides": {
            name: {"approval_policy": "read_only"}
            for name in ("slow_read", "next_read")
        },
    }
    config["workflow"]["tools"].append("fixture_deferred")
    container = None
    redis_container = None
    process = None
    with tempfile.TemporaryDirectory(prefix="daedalus-runtime-http-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        fixture_skills = root / "skills" / "fixture-skill"
        fixture_skills.mkdir(parents=True)
        (fixture_skills / "SKILL.md").write_text(
            "---\nname: fixture-skill\ndescription: Routing fixture\n---\nUse retained evidence and answer.\n"
        )
        config["functions"]["agent_skills_tool"] = {
            "_type": "agent_skills",
            "skills_directory": "/fixture-skills" if image else str(root / "skills"),
            "enabled_operations": ["list_skills", "load_skill"],
        }
        config["workflow"]["tools"].append("agent_skills_tool")
        shutil.copytree(
            Path(__file__).resolve().parent.parent / "skills" / "daily-summary",
            root / "skills" / "daily-summary",
        )
        config["functions"]["briefing_renderer_tool"] = {
            "_type": "briefing_renderer",
            "sandbox_tool": "current_datetime_tool",
            "skill_directory": "/fixture-skills/daily-summary"
            if image
            else str(root / "skills" / "daily-summary"),
        }
        config["workflow"]["daily_summary_tools"] = [
            "current_datetime_tool",
            "briefing_renderer_tool",
            "fixture_mcp",
        ]
        config["workflow"]["model_routes"] = {
            "deep": "fixture/deep",
            "deep_max": "fixture/max",
        }
        config["workflow"]["skill_model_profiles"] = {"fixture-skill": "deep"}
        path = root / "config.yaml"
        path.write_text(yaml.safe_dump(config))
        path.chmod(0o644)
        env = {
            "DAEDALUS_PREPARATION": preparation,
            "DAEDALUS_AUTHORIZATION": "rust" if preparation == "rust" else "python",
            "DAEDALUS_INTERNAL_API_TOKEN": f"  {token}  ",
            "DAEDALUS_MEMORY_MODE": "disabled",
            "DAEDALUS_PORT": str(runtime_port),
            "DAEDALUS_TOOLS_PORT": str(tools_port),
            "REDIS_URL": "redis://127.0.0.1:1",
            "AUTONOMOUS_LLM_MODEL_BASE_URL": f"http://127.0.0.1:{model_port}/v1",
            "AUTONOMOUS_LLM_MODEL_API_KEY": "PRIVATE_AUTONOMOUS_CREDENTIAL",
            "AUTONOMOUS_LLM_MODEL_MODEL": "fixture/autonomy",
            "IMAGE_GENERATION_API_KEY": "PRIVATE_IMAGE_CREDENTIAL",
            "IMAGE_GENERATION_MODEL": "gpt-image-2.5-sunburst",
            "IMAGE_GENERATION_BASE_URL": f"http://127.0.0.1:{model_port}/v1",
            "C2PA_SIGNING_MODE": "off",
        }
        log = (root / "runtime.log").open("w+")
        try:
            if redis_image:
                redis_container = "daedalus-runtime-redis-" + uuid.uuid4().hex[:10]
                redis_port = free_port()
                subprocess.run(  # nosec B603 - fixed fixture argv, no shell
                    [
                        docker,
                        "run",
                        "-d",
                        "--rm",
                        "--name",
                        redis_container,
                        "--network",
                        "host",
                        "--entrypoint",
                        "redis-server",
                        redis_image,
                        "--bind",
                        "127.0.0.1",
                        "--port",
                        str(redis_port),
                        "--save",
                        "",
                        "--appendonly",
                        "no",
                    ],
                    stdout=subprocess.DEVNULL,
                    check=True,
                )

                def redis_command(*arguments):
                    return subprocess.check_output(  # nosec B603 - fixed fixture argv, no shell
                        [
                            docker,
                            "exec",
                            redis_container,
                            "redis-cli",
                            "--raw",
                            "-p",
                            str(redis_port),
                            *arguments,
                        ],
                        text=True,
                        timeout=5,
                    ).strip()

                for _ in range(50):
                    if redis_command("PING") == "PONG":
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Disposable Redis did not start")
                env["REDIS_URL"] = f"redis://127.0.0.1:{redis_port}"
            if image:
                container = "daedalus-runtime-check-" + uuid.uuid4().hex[:10]
                command = [
                    docker,
                    "run",
                    "--rm",
                    "--name",
                    container,
                    "--network",
                    "host",
                    "--read-only",
                    "--tmpfs",
                    "/tmp",  # nosec B108 - isolated container tmpfs, no host file
                    "-v",
                    f"{path}:/workspace/config.yaml:ro",
                    "-v",
                    f"{root / 'skills'}:/fixture-skills:ro",
                ]
                for key, value in env.items():
                    command += ["-e", f"{key}={value}"]
                command.append(image)
            else:
                command = [
                    os.sys.executable,
                    str(Path(__file__).with_name("entrypoint.py")),
                ]
                env.update(
                    DAEDALUS_CONFIG_FILE=str(path),
                    DAEDALUS_RUNTIME_BINARY=str(Path(binary).resolve()),
                )
            process = subprocess.Popen(  # nosec B603 - fixed fixture argv, no shell
                command,
                stdout=log,
                stderr=log,
                env={
                    **os.environ,
                    **env,
                    "PYTHONPATH": str(Path(__file__).parent.resolve()),
                },
            )
            base = f"http://127.0.0.1:{runtime_port}"
            with httpx.Client(timeout=30, trust_env=False) as client:
                deadline = time.monotonic() + 120
                while True:
                    if process.poll() is not None:
                        raise RuntimeError("Runtime exited during startup")
                    try:
                        if client.get(base + "/health").is_success:
                            break
                    except httpx.TransportError:
                        pass
                    if time.monotonic() > deadline:
                        raise RuntimeError("Runtime startup timed out")
                    time.sleep(0.1)
                assert (  # nosec B101 - executable contract check
                    client.post(
                        base + "/v1/chat/completions", json={"messages": []}
                    ).status_code
                    == 401
                )
                assert (  # nosec B101 - executable contract check
                    client.post(
                        base + "/runtime/prepare", headers=headers, json={}
                    ).status_code
                    == 404
                )

                def chat(
                    scenario,
                    run,
                    props=None,
                    conversation=None,
                    extra_headers=None,
                    tool_choice=None,
                ):
                    response = client.post(
                        base + "/v1/chat/completions",
                        headers={
                            **headers,
                            "x-daedalus-request-id": run,
                            "x-conversation-id": conversation or run,
                            **(extra_headers or {}),
                        },
                        json={
                            "stream": True,
                            "tool_choice": tool_choice,
                            "additional_props": props or {},
                            "messages": [{"role": "user", "content": scenario}],
                        },
                    )
                    assert response.status_code == 200, response.status_code  # nosec B101 - executable contract check
                    return response.text

                answer = chat("BASIC PRIVATE_PROMPT", "basic-run")
                assert "The real datetime tool completed" in answer, answer  # nosec B101 - executable contract check
                assert "Function Complete: current_datetime_tool" in answer  # nosec B101 - executable contract check
                assert not peers.calls  # nosec B101 - executable contract check
                affinity = peers.requests[0]["user"]
                assert re.fullmatch(r"[0-9a-f]{64}", affinity)  # nosec B101 - executable contract check
                assert all(request["user"] == affinity for request in peers.requests)  # nosec B101 - executable contract check
                before = len(peers.requests)
                chat("BASIC PRIVATE_PROMPT", "basic-followup", conversation="basic-run")
                assert all(
                    request["user"] == affinity for request in peers.requests[before:]
                )  # nosec B101 - executable contract check
                before = len(peers.requests)
                deferred = chat("DEFERRED_DISCOVERY", "discovery-run")
                requests = peers.requests[before:]
                assert requests[0]["user"] != affinity  # nosec B101 - executable contract check
                assert all(
                    request["user"] == requests[0]["user"] for request in requests
                )  # nosec B101 - executable contract check
                assert "The real datetime tool completed" in deferred  # nosec B101 - executable contract check
                assert "Function Complete: fixture_deferred__connect" in deferred  # nosec B101 - executable contract check
                assert "Function Complete: fixture_deferred__next_read" in deferred  # nosec B101 - executable contract check
                initial_names = {tool["name"] for tool in requests[0]["tools"]}
                connected_names = {tool["name"] for tool in requests[1]["tools"]}
                discovery = next(
                    tool
                    for tool in requests[0]["tools"]
                    if tool["name"] == "fixture_deferred__connect"
                )
                assert "fixture_deferred__next_read" in discovery["description"]  # nosec B101 - executable contract check
                assert "fixture_deferred__write_item" not in discovery["description"]  # nosec B101 - executable contract check
                assert "fixture_deferred__connect" in initial_names  # nosec B101 - executable contract check
                assert "fixture_deferred__slow_read" in initial_names  # nosec B101 - executable contract check
                assert "fixture_deferred__next_read" not in initial_names  # nosec B101 - executable contract check
                assert initial_names <= connected_names  # nosec B101 - executable contract check
                assert len(connected_names) == len(requests[1]["tools"])  # nosec B101 - executable contract check
                assert "fixture_deferred__next_read" in connected_names  # nosec B101 - executable contract check
                assert "fixture_deferred__write_item" not in connected_names  # nosec B101 - executable contract check
                assert len(requests) == 3 and peers.calls == ["next_read"]  # nosec B101 - executable contract check
                peers.calls.clear()
                before = len(peers.requests)
                required = chat(
                    "DEFERRED_REQUIRED",
                    "discovery-required",
                    tool_choice={
                        "type": "function",
                        "function": {"name": "fixture_deferred__next_read"},
                    },
                )
                assert '"finish_reason":"stop"' in required, required  # nosec B101
                assert "Function Complete: fixture_deferred__next_read" in required  # nosec B101
                assert peers.calls == ["next_read"], peers.calls  # nosec B101
                names = {tool["name"] for tool in peers.requests[before]["tools"]}
                assert names == {"fixture_deferred__next_read"}, names  # nosec B101
                peers.calls.clear()
                invalid_clock = chat("CLOCK_EXTRA", "clock-extra-run")
                assert "The real datetime tool completed" in invalid_clock  # nosec B101
                assert "invalid_tool_batch" in json.dumps(peers.requests[-1])  # nosec B101
                invalid_clock = chat("CLOCK_NULL", "clock-null-run")
                assert "Function Start:" not in invalid_clock  # nosec B101
                for scenario in ("CONTRACT_REPAIR", "CONTRACT_UNKNOWN"):
                    peers.calls.clear()
                    answer = chat(scenario, scenario.lower())
                    assert "Function Complete: current_datetime_tool" in answer, answer  # nosec B101
                    assert peers.calls == (
                        ["next_read"] if scenario == "CONTRACT_REPAIR" else []
                    ), peers.calls  # nosec B101
                peers.calls.clear()
                for scenario in ("CONTRACT_MULTI_REPAIR", "CONTRACT_LATER_REPAIR"):
                    before = len(peers.requests)
                    answer = chat(scenario, scenario.lower())
                    assert '"finish_reason":"stop"' in answer, answer  # nosec B101
                    assert answer.count("Function Complete:") == 2, answer  # nosec B101
                    assert len(peers.requests) - before == 5  # nosec B101
                    assert not peers.calls  # nosec B101
                answer = chat("CONTRACT_REPEAT_AFTER_PROGRESS", "repeated-validation")
                assert '"finish_reason":"stop"' in answer, answer  # nosec B101
                assert peers.calls == ["next_read"], peers.calls  # nosec B101
                assert "current_datetime_tool" not in {
                    tool["name"] for tool in peers.requests[-1].get("tools", [])
                }  # nosec B101
                peers.calls.clear()
                answer = chat("CONTRACT_BAD_BATCH_ALWAYS", "invalid-batch")
                assert '"finish_reason":"stop"' in answer, answer  # nosec B101
                assert peers.calls == ["next_read"], peers.calls  # nosec B101 - valid sibling executes once
                assert "Function Start: current_datetime_tool" not in answer  # nosec B101
                peers.calls.clear()
                answer = chat("CONTRACT_DUPLICATE", "duplicate-calls")
                assert "Invalid or repeated tool call ID" in answer, answer  # nosec B101
                assert "Function Start:" not in answer and not peers.calls, answer  # nosec B101
                answer = chat("CONTRACT_REUSED", "reused-call")
                assert "Invalid or repeated tool call ID" in answer, answer  # nosec B101
                assert peers.calls == ["next_read"], peers.calls  # nosec B101
                peers.calls.clear()
                for index, choice in enumerate(
                    (
                        "required",
                        {
                            "type": "function",
                            "function": {"name": "current_datetime_tool"},
                        },
                    )
                ):
                    answer = chat(
                        "REQUIRED_MISSING",
                        f"required-missing-{index}",
                        tool_choice=choice,
                    )
                    assert (
                        "Required tool did not complete successfully" in answer
                    ), answer  # nosec B101
                    assert "UNSUPPORTED_CLAIM_WITHOUT_TOOL" not in answer, answer  # nosec B101
                    assert peers.requests[-1]["tool_choice"] != "auto"  # nosec B101
                answer = chat(
                    "REQUIRED_RECOVER", "required-recover", tool_choice="required"
                )
                assert "UNSUPPORTED_CLAIM_WITHOUT_TOOL" not in answer, answer  # nosec B101
                assert "Function Complete: current_datetime_tool" in answer, answer  # nosec B101
                assert "The real datetime tool completed" in answer, answer  # nosec B101
                before = len(peers.requests)
                answer = chat(
                    "OMITTED_TOOL_RECOVER Call current_datetime_tool with no arguments.",
                    "omitted-tool-recover",
                )
                assert "UNSUPPORTED_CLAIM_WITHOUT_TOOL" not in answer, answer  # nosec B101
                assert "Function Complete: current_datetime_tool" in answer, answer  # nosec B101
                assert "The real datetime tool completed" in answer, answer  # nosec B101
                assert len(peers.requests) - before == 3  # nosec B101
                assert all(
                    request["tool_choice"] == "auto"
                    for request in peers.requests[before:]
                )  # nosec B101 - evidence review never forces permission or execution
                assert "UNSUPPORTED_CLAIM_WITHOUT_TOOL" not in json.dumps(
                    peers.requests[before + 1]
                )  # nosec B101 - do not reinforce an unverified proposed answer
                answer = chat("BASIC", "tools-disabled", tool_choice="none")
                assert "Function Start:" not in answer and not peers.calls, answer  # nosec B101
                before = len(peers.requests)
                answer = chat(
                    "BASIC Call current_datetime_tool with no arguments.",
                    "named-clock-menu",
                )
                first_names = {tool["name"] for tool in peers.requests[before]["tools"]}
                assert first_names == {
                    "current_datetime_tool",
                    "agent_skills_tool",
                }, first_names  # nosec B101
                assert "Function Complete: current_datetime_tool" in answer, answer  # nosec B101
                assert len(peers.requests[before + 1]["tools"]) > len(first_names)  # nosec B101
                before = len(peers.requests)
                answer = chat(
                    "TEXT_ONLY Explain current_datetime_tool without calling any tools.",
                    "named-clock-explanation",
                )
                assert "Function Start:" not in answer, answer  # nosec B101
                assert len(peers.requests) - before == 2  # nosec B101
                assert answer.count("Synthetic text response") == 1  # nosec B101
                assert all(
                    request["tool_choice"] == "auto"
                    for request in peers.requests[before:]
                )  # nosec B101
                before = len(peers.requests)
                peers.calls.clear()
                answer = chat(
                    "CONTRACT_REPAIR Call fixture_mcp__next_read and another capability if needed.",
                    "menu-recovery",
                )
                assert "current_datetime_tool" not in {
                    tool["name"] for tool in peers.requests[before]["tools"]
                }  # nosec B101
                assert "invalid_tool_batch" in json.dumps(peers.requests[before + 1])  # nosec B101
                assert "current_datetime_tool" in {
                    tool["name"] for tool in peers.requests[before + 1]["tools"]
                }  # nosec B101
                assert "Function Complete: current_datetime_tool" in answer, answer  # nosec B101
                assert peers.calls == ["next_read"], peers.calls  # nosec B101
                peers.calls.clear()
                gateway = chat("GATEWAY", "gateway-run")
                assert gateway.count("The real datetime tool completed") == 1, gateway  # nosec B101 - executable contract check
                assert "Function Complete: current_datetime_tool" in gateway  # nosec B101 - executable contract check
                assert '"finish_reason":"stop"' in gateway, gateway  # nosec B101 - executable contract check
                gateway_incomplete = chat(
                    "GATEWAY_INCOMPLETE", "gateway-incomplete-run"
                )
                assert (
                    "Model response did not complete" in gateway_incomplete
                ), gateway_incomplete  # nosec B101 - executable contract check
                assert "Function Start:" not in gateway_incomplete  # nosec B101 - executable contract check
                for profile, expected in [
                    (None, ["fixture", "fixture/deep"]),
                    ("default", ["fixture", "fixture"]),
                    ("deep_max", ["fixture/max", "fixture/max"]),
                ]:
                    before = len(peers.requests)
                    assert "The real datetime tool completed" in chat(  # nosec B101 - executable contract check
                        "SKILL_ROUTE",
                        "route-" + str(profile),
                        {"model_profile": profile} if profile else None,
                    )
                    assert (
                        [  # nosec B101 - executable contract check
                            request["model"] for request in peers.requests[before:]
                        ]
                        == expected
                    )
                for profile in (None, "deep_max"):
                    before = len(peers.requests)
                    response = chat(
                        "SKILL_ROUTE",
                        "autonomy-" + str(profile),
                        {"model_profile": profile} if profile else None,
                        extra_headers={"x-daedalus-execution-scope": "autonomy"},
                    )
                    assert "The real datetime tool completed" in response  # nosec B101
                    assert [
                        request["model"] for request in peers.requests[before:]
                    ] == ["fixture/autonomy", "fixture/autonomy"]  # nosec B101
                conflict = chat("POLICY_CONFLICT", "policy-conflict-run")
                assert "read-only policy conflicts" in conflict  # nosec B101
                assert "The real datetime tool completed" in conflict  # nosec B101
                assert "mcp_approval_required" not in conflict  # nosec B101
                assert "conflicting_read" not in peers.calls  # nosec B101
                peers.calls.clear()
                before = len(peers.requests)
                fallback = chat(
                    "Run my daily briefing. RENDERER_FALLBACK", "renderer-fallback"
                )
                assert '"finish_reason":"stop"' in fallback, fallback  # nosec B101
                assert "Sourced briefing from retained evidence" in fallback  # nosec B101
                assert fallback.count("Function Complete: current_datetime_tool") == 1  # nosec B101
                assert "Function Start: briefing_renderer_tool" not in fallback  # nosec B101
                assert peers.calls == ["next_read"]  # nosec B101 - valid sibling executes once
                requests = peers.requests[before:]
                assert len(requests) == 4  # nosec B101 - evidence, correction, fallback
                clock_result = next(
                    item
                    for item in requests[1]["input"]
                    if item.get("type") == "function_call_output"
                )
                assert clock_result in requests[-1]["input"]  # nosec B101 - retain exact evidence
                peers.calls.clear()
                ignored = chat(
                    "Run my daily briefing. RENDERER_FALLBACK IGNORE_FALLBACK",
                    "renderer-fallback-ignored",
                )
                assert '"finish_reason":"error"' in ignored, ignored  # nosec B101
                assert peers.requests[-1]["tool_choice"] == "none"  # nosec B101
                assert not peers.requests[-1].get("tools")  # nosec B101
                assert peers.calls == ["next_read"]  # nosec B101 - no extra reads after fallback
                peers.calls.clear()
                ordinary = chat("RENDERER_FALLBACK", "ordinary-renderer-failure")
                assert '"finish_reason":"stop"' in ordinary  # nosec B101
                assert "Sourced briefing" not in ordinary and peers.calls == [
                    "next_read"
                ]  # nosec B101
                peers.calls.clear()
                retried = chat("RETRY_MODEL", "retry-run")
                assert "The real datetime tool completed" in retried  # nosec B101 - executable contract check
                assert (  # nosec B101 - executable contract check
                    sum("RETRY_MODEL" in json.dumps(old) for old in peers.requests) == 3
                )
                before = len(peers.requests)
                incomplete = chat("INCOMPLETE", "incomplete-run")
                assert "Model response did not complete" in incomplete, incomplete  # nosec B101 - executable contract check
                assert "Function Start:" not in incomplete  # nosec B101 - executable contract check
                assert len(peers.requests) == before + 1  # nosec B101 - executable contract check
                failed = chat("PROVIDER_FAILURE", "provider-failure-run")
                assert "Agent execution failed" in failed  # nosec B101 - executable contract check
                assert "PRIVATE_PROVIDER_ERROR" not in failed  # nosec B101 - executable contract check
                for scenario in (
                    "STREAM_RECOVER",
                    "STREAM_TRUNCATED",
                    "STREAM_JSON_RECOVER",
                    "STREAM_JSON_SYNTAX",
                ):
                    before = len(peers.requests)
                    recovered = chat("GATEWAY_" + scenario, scenario.lower())
                    assert recovered.count("First part. ") == 1, recovered  # nosec B101 - executable contract check
                    assert recovered.count("Recovered final answer.") == 1, recovered  # nosec B101 - executable contract check
                    assert '"finish_reason":"stop"' in recovered, recovered  # nosec B101 - executable contract check
                    assert "event: error" not in recovered, recovered  # nosec B101 - executable contract check
                    assert recovered.count("Function Start: current_datetime_tool") == 1  # nosec B101 - executable contract check
                    attempts = peers.requests[before:]
                    assert len(attempts) == 3, attempts  # nosec B101 - executable contract check

                    # A retry retains the exact completed tool results and the
                    # text already sent to the browser, without replaying tools.
                    def results(request):
                        return [
                            item
                            for item in request["input"]
                            if item.get("type") == "function_call_output"
                        ]

                    assert results(attempts[1]) == results(attempts[2])  # nosec B101 - executable contract check
                    assert "First part. " in json.dumps(attempts[2]["input"])  # nosec B101 - executable contract check
                    assert "unexecuted_write" not in json.dumps(attempts[2]["input"])  # nosec B101 - failed proposals are discarded
                    assert "fixture_mcp__write_item" not in peers.calls  # nosec B101 - no uncertain mutation executes
                peers.calls.clear()
                cut = chat("GATEWAY_STREAM_TOOL_CUT", "stream-tool-cut")
                assert not peers.calls, peers.calls  # nosec B101 - executable contract check
                assert "Function Start: fixture_mcp__next_read" not in cut  # nosec B101 - executable contract check
                assert '"finish_reason":"stop"' in cut, cut  # nosec B101 - executable contract check
                before = len(peers.requests)
                cut = chat("GATEWAY_STREAM_JSON_TOOL_CUT", "stream-json-tool-cut")
                assert not peers.calls, peers.calls  # nosec B101 - executable contract check
                assert len(peers.requests) == before + 3  # nosec B101 - rejected response, clock response, final answer
                assert cut.count("Function Start: current_datetime_tool") == 1  # nosec B101 - no tool from the rejected response ran
                assert '"finish_reason":"stop"' in cut, cut  # nosec B101 - executable contract check
                before = len(peers.requests)
                failed = chat("GATEWAY_STREAM_JSON_ALWAYS_FAIL", "stream-json-limit")
                assert len(peers.requests) == before + 3  # nosec B101 - one successful research round and exactly one decode recovery
                assert (
                    "Model response could not be decoded; completed output has been preserved"
                    in failed
                )  # nosec B101 - executable contract check
                assert failed.count("Function Start: current_datetime_tool") == 1  # nosec B101 - completed research is retained
                assert "Function Start: fixture_mcp__write_item" not in failed  # nosec B101 - executable contract check
                assert '"finish_reason":"error"' in failed  # nosec B101 - executable contract check
                peers.calls.clear()
                before = len(peers.requests)
                failed = chat("GATEWAY_STREAM_JSON_TWICE", "stream-json-twice")
                assert len(peers.requests) == before + 4  # nosec B101 - successful rounds do not reset the decode recovery limit
                assert peers.calls == ["next_read"], peers.calls  # nosec B101 - each completed tool executes once
                assert failed.count("Function Start: current_datetime_tool") == 1  # nosec B101 - executable contract check
                assert "Model response could not be decoded" in failed  # nosec B101 - executable contract check
                assert '"finish_reason":"error"' in failed  # nosec B101 - executable contract check
                for scenario, attempts in (
                    ("STREAM_ALWAYS_FAIL", 4),
                    ("STREAM_PERMANENT", 1),
                ):
                    before = len(peers.requests)
                    failed = chat("GATEWAY_" + scenario, scenario.lower())
                    assert '"finish_reason":"error"' in failed, failed  # nosec B101 - executable contract check
                    assert "Function Start:" not in failed, failed  # nosec B101 - executable contract check
                    assert len(peers.requests) == before + attempts  # nosec B101 - executable contract check
                    if scenario == "STREAM_ALWAYS_FAIL":
                        assert "Model stream interrupted after retry limit" in failed  # nosec B101 - executable contract check
                before = len(peers.requests)
                active = chat("GATEWAY_MODEL_PROGRESS", "model-progress")
                assert ": model active\n\n" in active, active  # nosec B101 - hidden model progress keeps the frontend connection alive
                assert "PRIVATE_MODEL_REASONING" not in active  # nosec B101 - reasoning never crosses the UI boundary
                assert "Visible answer after active model generation." in active  # nosec B101 - completion still delivers the answer
                assert '"finish_reason":"stop"' in active  # nosec B101 - executable contract check
                assert len(peers.requests) == before + 1  # nosec B101 - activity does not trigger another model call
                # Hold five separate conversations at the provider boundary.
                peers.release_model.clear()
                quota_headers = {"x-user-id": "quota-user"}
                quota_runs = [f"quota-run-{index}" for index in range(5)]
                before = len(peers.requests)
                with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                    futures = {
                        run: pool.submit(
                            chat, "MODEL_STEER", run, extra_headers=quota_headers
                        )
                        for run in quota_runs
                    }
                    try:
                        deadline = time.monotonic() + 15
                        while len(peers.requests) < before + 5:
                            assert time.monotonic() < deadline  # nosec B101 - five actual provider streams start
                            time.sleep(0.05)
                        assert all(not future.done() for future in futures.values())  # nosec B101 - streams overlap
                        for conversation, expected in [
                            ("quota-sixth", 429),
                            (quota_runs[0], 409),
                        ]:
                            rejected = client.post(
                                base + "/v1/chat/completions",
                                headers={
                                    **headers,
                                    **quota_headers,
                                    "x-daedalus-request-id": "quota-rejected",
                                    "x-conversation-id": conversation,
                                },
                                json={
                                    "stream": True,
                                    "messages": [{"role": "user", "content": "BASIC"}],
                                },
                            )
                            assert rejected.status_code == expected, rejected.text  # nosec B101 - capacity and conversation ownership
                        assert len(peers.requests) == before + 5  # nosec B101 - rejection never calls the model
                        futures["quota-other-user"] = pool.submit(
                            chat,
                            "MODEL_STEER",
                            "quota-other-user",
                            extra_headers={"x-user-id": "quota-other-user"},
                        )
                        deadline = time.monotonic() + 15
                        while len(peers.requests) < before + 6:
                            assert time.monotonic() < deadline  # nosec B101 - another user has independent capacity
                            time.sleep(0.05)
                        stopped = client.post(
                            base + f"/v1/runs/{quota_runs[0]}/control",
                            headers={**headers, **quota_headers},
                            json={"type": "cancel", "command_id": str(uuid.uuid4())},
                        )
                        assert stopped.is_success  # nosec B101 - cancel only this chat
                        assert "Run cancelled by user" in futures[quota_runs[0]].result(
                            timeout=10
                        )  # nosec B101 - cancellation completes
                        assert "The real datetime tool completed" in chat(
                            "BASIC", "quota-replacement", extra_headers=quota_headers
                        )  # nosec B101 - freed capacity admits another chat
                        assert all(
                            not future.done()
                            for run, future in futures.items()
                            if run != quota_runs[0]
                        )  # nosec B101 - other streams stay active
                    finally:
                        for run, future in futures.items():
                            if not future.done():
                                client.post(
                                    base + f"/v1/runs/{run}/control",
                                    headers={
                                        **headers,
                                        "x-user-id": "quota-other-user"
                                        if run == "quota-other-user"
                                        else "quota-user",
                                    },
                                    json={
                                        "type": "cancel",
                                        "command_id": str(uuid.uuid4()),
                                    },
                                )
                        peers.release_model.set()
                        for future in futures.values():
                            future.result(timeout=10)
                peers.calls.clear()
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    for scenario, run, waiting in [
                        ("MODEL_STEER", "model-run", peers.model_waiting),
                        ("TOOL_STEER", "tool-run", peers.tool_waiting),
                    ]:
                        # Quota and earlier tool scenarios reuse these peers.
                        # A stale signal could apply steering before this call
                        # reached the provider, making the transport check vacuous.
                        waiting.clear()
                        if scenario == "MODEL_STEER":
                            peers.release_model.clear()
                            peers.model_disconnected.clear()
                        else:
                            peers.release_tool.clear()
                        future = pool.submit(chat, scenario, run)
                        assert waiting.wait(15), f"{scenario} did not reach its wait"  # nosec B101 - executable contract check
                        command = {
                            "type": "steer",
                            "command_id": str(uuid.uuid4()),
                            "instruction": "NEW_DIRECTION: use retained results and answer now",
                        }
                        url = base + f"/v1/runs/{run}/control"
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url,
                                headers={**headers, "x-user-id": "bob"},
                                json=command,
                            ).status_code
                            == 404
                        )
                        accepted = client.post(url, headers=headers, json=command)
                        assert accepted.status_code == 200, accepted.text  # nosec B101 - executable contract check
                        # Tool waits keep the run active for deterministic duplicate checks.
                        if scenario == "TOOL_STEER":
                            duplicate = client.post(url, headers=headers, json=command)
                            assert (  # nosec B101 - executable contract check
                                duplicate.status_code == 200
                                and duplicate.json()["accepted"] is False
                            )
                            assert (  # nosec B101 - executable contract check
                                client.post(
                                    url,
                                    headers=headers,
                                    json={**command, "instruction": "different"},
                                ).status_code
                                == 409
                            )
                            peers.release_tool.set()
                        result = future.result(timeout=20)
                        assert "Directed answer" in result, result  # nosec B101 - executable contract check
                        assert '"status":"applied"' in result, result  # nosec B101 - executable contract check
                        if scenario == "MODEL_STEER":
                            assert not peers.calls, peers.calls  # nosec B101 - executable contract check
                            peers.release_model.set()
                        else:
                            assert peers.calls == ["slow_read"], peers.calls  # nosec B101 - executable contract check
                            assert "RETAINED_EVIDENCE" in result  # nosec B101 - executable contract check
                    # Cancellation interrupts a provider wait and releases the run.
                    peers.model_waiting.clear()
                    peers.release_model.clear()
                    cancelled = pool.submit(chat, "MODEL_STEER", "cancel-run")
                    assert peers.model_waiting.wait(15)  # nosec B101 - executable contract check
                    response = client.post(
                        base + "/v1/runs/cancel-run/control",
                        headers=headers,
                        json={"type": "cancel", "command_id": str(uuid.uuid4())},
                    )
                    assert response.is_success  # nosec B101 - executable contract check
                    assert "Run cancelled by user" in cancelled.result(timeout=10)  # nosec B101 - executable contract check
                    peers.release_model.set()
                    assert "The real datetime tool completed" in chat(  # nosec B101 - executable contract check
                        "BASIC", "cancel-run"
                    )
                    # Stop must cancel the in-flight MCP transport and discard
                    # queued tools, rather than just abandoning the UI stream.
                    peers.release_tool.clear()
                    peers.tool_waiting.clear()
                    peers.tool_disconnected.clear()
                    peers.calls.clear()
                    cancelled = pool.submit(chat, "TOOL_STEER", "cancel-tool-run")
                    assert peers.tool_waiting.wait(15)  # nosec B101 - executable contract check
                    response = client.post(
                        base + "/v1/runs/cancel-tool-run/control",
                        headers=headers,
                        json={"type": "cancel", "command_id": str(uuid.uuid4())},
                    )
                    assert response.is_success  # nosec B101 - executable contract check
                    assert "Run cancelled by user" in cancelled.result(timeout=5)  # nosec B101 - executable contract check
                    assert peers.tool_disconnected.wait(5), "MCP request survived Stop"  # nosec B101 - executable contract check
                    assert peers.calls == ["slow_read"], peers.calls  # nosec B101 - executable contract check
                    peers.release_tool.set()
                    # Create travels through the Rust HTTP proxy to the real
                    # Python route and SDK. Cover silent streams and requests
                    # still waiting for headers (including batches).
                    for stream, count in ((True, 1), (False, 2)):
                        peers.image_waiting.clear()
                        peers.image_disconnected.clear()
                        body = json.dumps(
                            {
                                "prompt": "fixture",
                                "guidance": "exact",
                                "stream": stream,
                                "n": count,
                            }
                        ).encode()
                        with socket.create_connection(
                            ("127.0.0.1", runtime_port), timeout=5
                        ) as connection:
                            raw_headers = {
                                **headers,
                                "Host": f"127.0.0.1:{runtime_port}",
                                "Content-Type": "application/json",
                                "Content-Length": str(len(body)),
                            }
                            request = (
                                "POST /v1/images/generate HTTP/1.1\r\n"
                                + "".join(
                                    f"{name}: {value}\r\n"
                                    for name, value in raw_headers.items()
                                )
                                + "\r\n"
                            )
                            connection.sendall(request.encode() + body)
                            assert peers.image_waiting.wait(
                                10
                            ), "Image provider was not reached"  # nosec B101 - executable contract check
                        assert peers.image_disconnected.wait(
                            5
                        ), f"Image request survived disconnect: stream={stream}"  # nosec B101 - executable contract check
                    if redis_image:
                        peers.release_tool.clear()
                        peers.tool_waiting.clear()
                        approval = pool.submit(chat, "APPROVAL", "approval-run")
                        assert peers.tool_waiting.wait(15)  # nosec B101 - executable contract check
                        # A sibling read must finish before the terminal approval frame.
                        peers.release_tool.set()
                        result = approval.result(timeout=20)
                        assert result.index("RETAINED_EVIDENCE") < result.index(  # nosec B101 - executable contract check
                            "event: mcp_approval_required"
                        )
                        assert "write_item" not in peers.calls  # nosec B101 - executable contract check
                        encoded = re.search(
                            r"<!--daedalus-mcp-approval:([A-Za-z0-9_-]+)-->", result
                        )[1]
                        marker = json.loads(
                            base64.urlsafe_b64decode(
                                encoded + "=" * (-len(encoded) % 4)
                            )
                        )
                        user_hash = hashlib.sha256(b"alice").hexdigest()[:16]
                        intent = json.loads(
                            redis_command(
                                "GET",
                                f"approval-pending:{user_hash}:{marker['requestId']}",
                            )
                        )
                        credential = uuid.uuid4().hex
                        redis_command(
                            "SETEX",
                            f"approval:{user_hash}:{credential}",
                            "120",
                            json.dumps(intent),
                        )
                        body = {
                            key: intent[key]
                            for key in (
                                "server_name",
                                "tool_name",
                                "canonical_arguments",
                                "arguments_sha256",
                            )
                        }
                        url = base + f"/v1/mcp-approvals/{marker['requestId']}/execute"
                        approved_headers = {
                            **headers,
                            "x-daedalus-approval-token": credential,
                        }
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url,
                                headers={**approved_headers, "x-user-id": "bob"},
                                json=body,
                            ).status_code
                            == 409
                        )
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url,
                                headers=approved_headers,
                                json={
                                    **body,
                                    "canonical_arguments": '{"changed":true}',
                                },
                            ).status_code
                            == 409
                        )
                        executed = client.post(url, headers=approved_headers, json=body)
                        assert executed.status_code == 200, executed.text  # nosec B101 - executable contract check
                        assert executed.json()["status"] == "completed"  # nosec B101 - executable contract check
                        assert "RETAINED_EVIDENCE" not in executed.text  # nosec B101 - executable contract check
                        assert peers.calls.count("write_item") == 1  # nosec B101 - executable contract check
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url, headers=approved_headers, json=body
                            ).status_code
                            == 409
                        )
                        receipt_key = (
                            "approval-receipt:"
                            + hashlib.sha256(credential.encode()).hexdigest()
                        )
                        assert (  # nosec B101 - executable contract check
                            json.loads(redis_command("GET", receipt_key))[
                                "arguments_sha256"
                            ]
                            == body["arguments_sha256"]
                        )
                        execution_id = executed.json()["executionId"]
                        assert (  # nosec B101 - executable contract check
                            client.get(
                                base + "/executions/" + execution_id,
                                headers={**headers, "x-user-id": "bob"},
                            ).status_code
                            == 404
                        )
                if redis_image:
                    result = chat("LARGE_TOOL", "large-tool-run")
                    assert "The real datetime tool completed" in result  # nosec B101
                    assert "_daedalus_compacted_tool_output" in json.dumps(
                        peers.requests[-1]
                    )  # nosec B101
                    result = chat("LARGE_OPAQUE", "large-opaque-run")
                    assert "Agent execution failed" in result  # nosec B101
                # Read through a separate descriptor: seeking the child's shared
                # stdout file would move its write position while it is logging.
                records = []
                for _ in range(50):
                    raw_logs = Path(log.name).read_text()
                    records = [
                        json.loads(line)
                        for line in raw_logs.splitlines()
                        if line.startswith("{")
                    ]
                    if any(
                        record.get("fields", {}).get("event") == "run_finished"
                        and record.get("span", {}).get("run_id") == "cancel-run"
                        for record in records
                    ):
                        break
                    time.sleep(0.02)
                events = [record.get("fields", {}) for record in records]
                required_events = {
                    "run_started",
                    "prepare_finished",
                    "model_call_started",
                    "model_first_event",
                    "model_call_finished",
                    "model_call_failed",
                    "model_frame_rejected",
                    "model_retry_scheduled",
                    "tool_call_started",
                    "tool_call_finished",
                    "steering_received",
                    "steering_applied",
                    "tool_call_skipped",
                    "cancellation_received",
                    "run_finished",
                    "run_failed",
                    "child_ready",
                }
                if preparation == "python":
                    required_events.update(
                        {
                            "tool_prepare_finished",
                            "tool_run_released",
                            "tool_execution_started",
                            "tool_execution_finished",
                        }
                    )
                else:
                    assert not {"tool_prepare_finished", "tool_run_released"} & {
                        event.get("event") for event in events
                    }, "Rust runs must not create or release Python run state"  # nosec B101
                assert required_events <= {event.get("event") for event in events}, (
                    required_events - {event.get("event") for event in events}
                )  # nosec B101 - executable contract check
                for name in (
                    "run_started",
                    "prepare_finished",
                    "model_call_finished",
                    "tool_call_finished",
                    "run_finished",
                ):
                    assert any(
                        record.get("fields", {}).get("event") == name  # nosec B101 - executable contract check
                        and record.get("span", {}).get("run_id") == "basic-run"
                        for record in records
                    ), name
                if preparation == "python":
                    assert any(
                        event.get("event") == "tool_execution_finished"
                        and event.get("run_id") == "basic-run"
                        for event in events
                    )  # nosec B101 - baseline Python dispatch owns this lifecycle
                else:
                    assert any(
                        record.get("fields", {}).get("event") == "tool_call_finished"
                        and record.get("fields", {}).get("tool")
                        == "fixture_mcp__slow_read"
                        and record.get("span", {}).get("run_id") == "tool-run"
                        for record in records
                    )  # nosec B101 - migrated MCP must correlate in Rust
                    assert not any(
                        event.get("event") == "tool_execution_finished"
                        and event.get("run_id") == "tool-run"
                        for event in events
                    ), "Rust MCP dispatch must not invoke the Python executor"  # nosec B101
                    assert any(
                        record.get("fields", {}).get("event") == "tool_call_finished"
                        and record.get("fields", {}).get("tool") == "agent_skills_tool"
                        and record.get("span", {}).get("run_id") == "route-None"
                        for record in records
                    )  # nosec B101 - skill execution belongs to Rust
                    assert not any(
                        event.get("event") == "tool_execution_finished"
                        and str(event.get("run_id", "")).startswith("route-")
                        for event in events
                    ), "Rust skill dispatch must not invoke the Python executor"  # nosec B101
                assert any(
                    event.get("event") == "model_retry_scheduled"  # nosec B101 - executable contract check
                    and event.get("http_status") == 503
                    for event in events
                )
                assert any(
                    event.get("event") == "model_retry_scheduled"
                    and event.get("error_kind") == "upstream_transport"
                    and event.get("resuming") is True
                    and event.get("output_bytes") == len("First part. ")
                    for event in events
                )  # nosec B101 - executable contract check
                assert any(
                    record.get("fields", {}).get("event") == "model_frame_rejected"
                    and record.get("span", {}).get("run_id") == "stream_json_recover"
                    and record["fields"].get("event_type")
                    == "response.output_text.delta"
                    and record["fields"].get("category") == "schema"
                    for record in records
                )  # nosec B101 - content-free structural diagnostics
                assert any(
                    record.get("fields", {}).get("event") == "model_frame_rejected"
                    and record.get("span", {}).get("run_id") == "stream_json_syntax"
                    and record["fields"].get("event_type") == "invalid_json"
                    and record["fields"].get("category") == "eof"
                    for record in records
                )  # nosec B101 - invalid provider text is never logged
                decode_retries = [
                    record["fields"]
                    for record in records
                    if record.get("fields", {}).get("event") == "model_retry_scheduled"
                    and record.get("span", {}).get("run_id") == "stream-json-limit"
                ]
                assert len(decode_retries) == 1, decode_retries  # nosec B101 - exactly one recovery
                assert decode_retries[0]["decode_recoveries"] == 1  # nosec B101 - executable contract check
                assert (
                    sum(
                        record.get("fields", {}).get("event") == "model_retry_scheduled"
                        and record.get("span", {}).get("run_id") == "stream-json-twice"
                        for record in records
                    )
                    == 1
                )  # nosec B101 - a successful tool round does not replenish decode recovery
                assert any(
                    event.get("event") == "run_failed"
                    and event.get("phase") == "model_stream"  # nosec B101 - executable contract check
                    and event.get("http_status") == 400
                    and event.get("error_kind") == "provider_response"
                    for event in events
                )
                assert any(
                    event.get("event") == "run_finished"
                    and event.get("outcome") == "cancelled"
                    for event in events
                )  # nosec B101 - executable contract check
                rejected = [
                    event
                    for event in events
                    if event.get("event") == "tool_batch_rejected"
                ]
                assert rejected and any(
                    event["recovery_exhausted"] for event in rejected
                )  # nosec B101
                assert all(
                    set(problem) == {"tool", "constraint"}
                    for event in rejected
                    for problem in json.loads(event["problems"])
                )  # nosec B101 - structural diagnostics contain no call arguments
                for private in (
                    token,
                    "PRIVATE_PROMPT",
                    "PRIVATE_PROVIDER_ERROR",
                    "PRIVATE_MODEL_REASONING",
                    "PRIVATE_MODEL_CREDENTIAL",
                    "PRIVATE_AUTONOMOUS_CREDENTIAL",
                    "PRIVATE_TOOL_ARGUMENT",
                    "PRIVATE_INVALID_ARGUMENT",
                    "RETAINED_EVIDENCE",
                    "The real datetime tool completed",
                    "First part. ",
                    "Recovered final answer.",
                    "NEW_DIRECTION: use retained results and answer now",
                ):
                    assert (
                        private not in raw_logs
                    ), "Private content appeared in runtime logs"  # nosec B101 - executable contract check
                assert len(peers.routing_sessions) == len(peers.requests)  # nosec B101
                assert all(
                    session == request["user"]
                    for session, request in zip(
                        peers.routing_sessions, peers.requests, strict=True
                    )
                ), "Routing affinity was lost across model/tool/retry rounds"  # nosec B101
                if report:
                    # Only the clock's result is nondeterministic. Keep all model
                    # requests, tool arguments, schemas, errors and affinity IDs.
                    requests = json.loads(json.dumps(peers.requests))
                    for request in requests:
                        clock_calls = {
                            item["call_id"]
                            for item in request.get("input", [])
                            if item.get("type") == "function_call"
                            and item.get("name") == "current_datetime_tool"
                        }
                        for item in request.get("input", []):
                            if (
                                item.get("type") == "function_call_output"
                                and item.get("call_id") in clock_calls
                            ):
                                value = item.get("output", "")
                                if re.fullmatch(
                                    r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d",
                                    value,
                                ):
                                    item["output"] = "<clock-instant>"
                    Path(report).write_text(
                        json.dumps({"version": 1, "requests": requests}, indent=2)
                        + "\n"
                    )
                print(
                    "HTTP contract passed: streaming, native tools, bounded provider retry, incomplete rejection, user isolation, idempotent steering during model/MCP calls, retained results, skipped queued calls, and cancellation."
                    " Batch validation, call IDs, required-tool enforcement, structured lifecycle logs, failure diagnostics, run correlation, and private-data exclusion passed."
                    + (
                        " Exact approvals and non-replay passed against real Redis."
                        if redis_image
                        else ""
                    )
                )
        except BaseException:
            log.flush()
            log.seek(0)
            print(log.read()[-6000:])
            raise
        finally:
            peers.release_model.set()
            peers.release_tool.set()
            if redis_container:
                subprocess.run(  # nosec B603 - fixed fixture argv, no shell
                    [docker, "stop", "-t", "1", redis_container],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            if container:
                subprocess.run(  # nosec B603 - fixed fixture argv, no shell
                    [docker, "stop", "-t", "5", container],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            log.close()
            peer_server.shutdown()
            peer_server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--image")
    target.add_argument("--binary")
    parser.add_argument("--preparation", choices=("rust", "python"), default="rust")
    parser.add_argument(
        "--redis-image",
        help="Disposable Redis image for exact approval integration checks",
    )
    parser.add_argument(
        "--report", help="Synthetic requests for differential comparison"
    )
    args = parser.parse_args()
    check(args.image, args.binary, args.redis_image, args.preparation, args.report)
