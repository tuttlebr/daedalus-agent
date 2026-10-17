#!/usr/bin/env python3
"""Built-image response presentation, streaming, retry and steering contracts."""

import argparse
import concurrent.futures
import json
import threading
import time
import uuid

import httpx
from image_check import environment, require
from leaf_check import measure
from runtime_http_check import Peers


def message(text, label="answer"):
    return {
        "id": "msg_" + label,
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def call(name, arguments, label):
    return {
        "id": "fc_" + label,
        "call_id": "call_" + label,
        "type": "function_call",
        "name": name,
        "arguments": json.dumps(arguments),
        "status": "completed",
    }


def send_item(handler, item, index, *, pause=None):
    handler.event(
        {
            "type": "response.output_item.added",
            "output_index": index,
            "item": {**item, "status": "in_progress"},
        }
    )
    if item["type"] == "message":
        text = item["content"][0]["text"]
        split = max(1, len(text) // 2)
        for number, chunk in enumerate((text[:split], text[split:])):
            handler.event(
                {
                    "type": "response.output_text.delta",
                    "output_index": index,
                    "content_index": 0,
                    "item_id": item["id"],
                    "delta": chunk,
                }
            )
            if number == 0 and pause and pause():
                return False
    handler.event(
        {"type": "response.output_item.done", "output_index": index, "item": item}
    )
    return True


def complete(handler, items, *, incomplete=False):
    handler.event(
        {
            "type": "response.incomplete" if incomplete else "response.completed",
            "response": {
                "id": "resp_fixture",
                "object": "response",
                "created_at": 1,
                "status": "incomplete" if incomplete else "completed",
                "model": "fixture",
                "output": items,
                **(
                    {"incomplete_details": {"reason": "max_output_tokens"}}
                    if incomplete
                    else {}
                ),
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "total_tokens": 120,
                },
            },
        }
    )


class ResponsePeers(Peers):
    def __init__(self):
        super().__init__()
        self.reset("tools")

    def reset(self, mode):
        self.mode = mode
        self.requests.clear()
        self.model_waiting.clear()
        self.release_model.clear()
        self.model_disconnected.clear()
        self.failed_once = False

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def model_response(self, body):
                inputs = body["input"]
                results = [
                    item
                    for item in inputs
                    if item.get("type") == "function_call_output"
                ]
                if len(results) < 2 and peers.mode not in ("stream", "stream_retry"):
                    items = [
                        message(
                            ("First update.", "Second update.")[len(results)]
                            if peers.mode == "boundaries"
                            else "Unwanted tool-round commentary. "
                        ),
                        call("current_datetime_tool", {}, str(len(results))),
                    ]
                    if peers.mode == "silent":
                        items = items[1:]
                else:
                    directed = "REVISED_VALUE" in json.dumps(inputs)
                    text = "REVISED_VALUE" if directed else "FINAL_VALUE"
                    if peers.mode == "stream_retry":
                        text = "keeper" if peers.failed_once else "Book"
                    if peers.mode == "final_prose":
                        text = "Extra final prose. " + text
                    if peers.mode == "oversized":
                        text = "X" * (1024 * 1024 + 2)
                    items = [message(text)]

                    def pause():
                        if peers.mode in ("stream", "steer", "cancel") and not directed:
                            peers.model_waiting.set()
                            return self.wait_for_disconnect(
                                peers.model_disconnected, peers.release_model
                            )
                        if peers.mode == "heartbeat":
                            time.sleep(16)
                        return False

                    if not send_item(self, items[0], 0, pause=pause):
                        return
                    if (
                        peers.mode in ("retry", "stream_retry")
                        and not peers.failed_once
                    ):
                        peers.failed_once = True
                        self.event(
                            {
                                "error": {
                                    "type": "SwitchyardError",
                                    "message": "upstream transport error: synthetic disconnect",
                                }
                            }
                        )
                        return
                    complete(self, items, incomplete=peers.mode == "incomplete")
                    return
                for index, item in enumerate(items):
                    send_item(self, item, index)
                complete(self, items)

        return Handler


def check(image, redis_image):
    report = []
    for preparation in ("rust", "python"):
        peers = ResponsePeers()
        with environment(
            image,
            redis_image,
            minimal=True,
            memory=False,
            peers=peers,
            extra_env=lambda _port: {
                "DAEDALUS_PREPARATION": preparation,
                "DAEDALUS_AUTHORIZATION": preparation,
            },
        ) as env:
            for fields in ({}, {"response_mode": "streaming"}):
                peers.reset("boundaries")
                result = measure(env, request_fields=fields)
                require(
                    result["answer"]
                    == "First update.\n\nSecond update.\n\nFINAL_VALUE",
                    "Separate model rounds ran together in the visible answer",
                )
                require(
                    result["terminal"] == "stop" and len(result["starts"]) == 2,
                    "Boundary fixture did not complete its tool rounds",
                )
            peers.reset("silent")
            result = measure(env)
            require(
                result["answer"] == "FINAL_VALUE",
                "Silent tool rounds added empty paragraphs",
            )
            peers.reset("stream_retry")
            result = measure(env)
            require(
                result["answer"] == "Bookkeeper"
                and result["terminal"] == "stop"
                and len(peers.requests) == 2,
                "Retry inserted a paragraph inside a continued word",
            )
            for explicit in (False, True):
                peers.reset("tools")
                result = measure(
                    env,
                    message="Execute the fixture."
                    if explicit
                    else "Return only the final value.",
                    request_fields={"response_mode": "final_only"} if explicit else {},
                )
                require(
                    result["answer"] == "FINAL_VALUE" and result["terminal"] == "stop",
                    "Tool narration leaked or final answer was lost",
                )
                require(
                    len(result["starts"]) == len(result["ends"]) == 2,
                    "Tool receipts lost",
                )
                require(
                    {e["id"] for e in result["starts"]}
                    == {e["id"] for e in result["ends"]},
                    "Tool bindings lost",
                )
            for mode in ("incomplete", "oversized", "retry", "final_prose"):
                peers.reset(mode)
                result = measure(env, message="Return only the final value.")
                require(len(result["starts"]) == 2, "Completed tools replayed")
                if mode in ("incomplete", "oversized"):
                    require(
                        result["errors"] and not result["answer"],
                        "Invalid partial answer published",
                    )
                elif mode == "retry":
                    require(
                        result["answer"] == "FINAL_VALUE"
                        and result["terminal"] == "stop",
                        "Retry leaked partial text",
                    )
                    require(
                        len(peers.requests) == 4
                        and "FINAL_VALUE"
                        not in json.dumps(peers.requests[-1]["input"]),
                        "Withheld answer entered retry history",
                    )
                else:
                    require(
                        result["answer"] == "Extra final prose. FINAL_VALUE",
                        "Final answer was silently edited to fit the test",
                    )
            for fields, expected_visible in (
                ({}, True),
                ({"response_mode": "streaming"}, True),
                ({"response_mode": "final_only"}, False),
            ):
                peers.reset("stream")
                visible = threading.Event()
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(
                        measure,
                        env,
                        request_fields=fields,
                        message="Return only the final value."
                        if fields.get("response_mode") == "streaming"
                        else "Execute the synthetic fixture plan.",
                        on_text=lambda _text: visible.set(),
                    )
                    require(
                        peers.model_waiting.wait(10),
                        "Model did not reach stream barrier",
                    )
                    observed = visible.wait(1)
                    peers.release_model.set()
                    result = future.result(timeout=10)
                require(
                    observed == expected_visible,
                    "Normal streaming or final-only withholding regressed",
                )
                require(result["answer"] == "FINAL_VALUE", "Stream text lost")
            for control, final_only in (
                ("steer", True),
                ("cancel", True),
                ("steer", False),
                ("cancel", False),
            ):
                peers.reset(control)
                run_id = str(uuid.uuid4())
                visible_final = threading.Event()
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(
                        measure,
                        env,
                        message="Return only the final value."
                        if final_only
                        else "Execute the synthetic fixture plan.",
                        request_id=run_id,
                        on_text=lambda text: visible_final.set()
                        if text == "FINAL"
                        else None,
                    )
                    require(
                        peers.model_waiting.wait(10),
                        "Model did not reach control barrier",
                    )
                    require(
                        final_only or visible_final.wait(2),
                        "Partial answer was not visible before control",
                    )
                    command = {"type": control, "command_id": str(uuid.uuid4())}
                    if control == "steer":
                        command["instruction"] = (
                            "Return only REVISED_VALUE, retaining the completed tool evidence."
                        )
                    accepted = httpx.post(
                        env["base"] + f"/v1/runs/{run_id}/control",
                        headers=env["headers"] | {"x-user-id": "synthetic-alice"},
                        json=command,
                        trust_env=False,
                    )
                    require(accepted.status_code == 200, "Control rejected")
                    result = future.result(timeout=15)
                require(
                    len(result["starts"]) == 2 and peers.model_disconnected.wait(2),
                    "Control replayed tools or left provider running",
                )
                expected = (
                    ""
                    if final_only
                    else (
                        "Unwanted tool-round commentary. \n\n"
                        "Unwanted tool-round commentary. \n\nFINAL"
                    )
                )
                if control == "steer":
                    expected += ("" if final_only else "\n\n") + "REVISED_VALUE"
                require(
                    result["answer"] == expected, "Control lost visible text boundaries"
                )
            peers.reset("heartbeat")
            result = measure(env, message="Return only the final value.")
            require(
                result["answer"] == "FINAL_VALUE" and result["activity_comments"] >= 1,
                "Withholding hid provider activity",
            )
            bad = httpx.post(
                env["base"] + "/v1/chat/completions",
                headers=env["headers"],
                json={
                    "messages": [{"role": "user", "content": "fixture"}],
                    "response_mode": "invalid",
                },
                trust_env=False,
            )
            require(bad.status_code == 400, "Invalid presentation mode accepted")
            report.append({"preparation": preparation, "passed": True, "cases": 19})
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.image, args.redis_image), indent=2))
