#!/usr/bin/env python3
"""Verify charter dispatch and user-scoped OAuth through a built backend image.

Only model, Google MCP, Hue, and Kubernetes transports are synthetic. Runtime
admission, schema discovery, OAuth lookup, authorization, budgets, and completion
validation execute from the image. No household or cluster service is contacted.
"""

import argparse
import copy
import hashlib
import json
import shlex
import time
import uuid

from autonomous_agent.charter import CharterConfig
from autonomous_agent.prompt import (
    build_messages,
    output_schema,
    parse_structured_output,
)
from autonomous_agent.scheduling import action, empty_state
from image_check import environment, require
from leaf_check import measure
from runtime_http_check import Peers

GROUPS = {
    "calendar_mcp_server": ["list_events", "create_event", "update_event"],
    "hue_mcp_server": ["get_light", "set_light_state"],
    "k8s_mcp_server": [
        "getEvents",
        "getResource",
        "rolloutRestart",
        "helmUpgrade",
        "deleteResource",
        "runKubectlCommand",
        "execInPod",
    ],
}
WRITES = {
    "create_event",
    "update_event",
    "set_light_state",
    "rolloutRestart",
    "helmUpgrade",
    "deleteResource",
    "runKubectlCommand",
    "execInPod",
}


class CharterPeers(Peers):
    def __init__(self):
        super().__init__()
        self.plan = []
        self.remote = []
        self.outputs = []
        self.backups = {}
        self.config_map = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": "app", "namespace": "home"},
            "data": {"timeout": "15"},
        }

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path.startswith("/mcp/"):
                    group = self.path.rsplit("/", 1)[1]
                    if "id" not in body:
                        return self.reply({}, 202)
                    method = body["method"]
                    if method == "initialize":
                        result = {
                            "protocolVersion": body["params"]["protocolVersion"],
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "charter-fixture", "version": "1"},
                        }
                    elif method == "tools/list":
                        result = {
                            "tools": [
                                {
                                    "name": name,
                                    "description": f"Fixture {name}",
                                    "annotations": {
                                        "readOnlyHint": name not in WRITES,
                                        "destructiveHint": name in WRITES,
                                    },
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {
                                            "id": {"type": "string"},
                                            "kind": {"type": "string"},
                                            "resourceType": {"type": "string"},
                                            "start": {"type": "object"},
                                            "end": {"type": "object"},
                                            "on": {"type": "boolean"},
                                            "command": {
                                                "oneOf": [
                                                    {"type": "string"},
                                                    {
                                                        "type": "array",
                                                        "items": {"type": "string"},
                                                    },
                                                ]
                                            },
                                        },
                                        "additionalProperties": False,
                                    },
                                }
                                for name in GROUPS[group]
                            ]
                        }
                    elif method == "tools/call":
                        params = body["params"]
                        peers.remote.append(
                            {
                                "group": group,
                                **params,
                                "authorization": self.headers.get("Authorization"),
                            }
                        )
                        args = params.get("arguments", {})
                        remote_value = {
                            "id": args.get("id", "event-one"),
                            "verified": True,
                            **args,
                        }
                        if params["name"] == "runKubectlCommand":
                            tokens = shlex.split(args["command"])
                            if tokens[1] == "create":
                                snapshot = next(
                                    token.split("snapshot=", 1)[1]
                                    for token in tokens
                                    if token.startswith("--from-literal=snapshot=")
                                )
                                peers.backups[tokens[3]] = json.loads(snapshot)
                            elif tokens[1] == "get":
                                remote_value = {
                                    "data": {
                                        "snapshot": json.dumps(peers.backups[tokens[3]])
                                    }
                                }
                            elif tokens[1] == "patch":
                                patch = next(
                                    token.split("=", 1)[1]
                                    for token in tokens
                                    if token.startswith("--patch=")
                                )
                                peers.config_map["data"].update(
                                    json.loads(patch)["data"]
                                )
                        elif params["name"] == "getResource":
                            remote_value = peers.config_map
                        result = {
                            "isError": args.get("id") == "unreachable",
                            "content": [
                                {
                                    "type": "text",
                                    "text": json.dumps(remote_value),
                                }
                            ],
                        }
                    else:
                        return self.reply(
                            {
                                "jsonrpc": "2.0",
                                "id": body["id"],
                                "error": {"code": -32601, "message": "Unsupported"},
                            }
                        )
                    return self.reply(
                        {"jsonrpc": "2.0", "id": body["id"], "result": result}
                    )
                if self.path != "/v1/responses":
                    return self.reply({"error": "Unexpected fixture path"}, 404)
                peers.requests.append(body)
                outputs = [
                    item
                    for item in body["input"]
                    if item.get("type") == "function_call_output"
                ]
                peers.outputs = outputs
                index = len(outputs)
                require(
                    index < len(peers.plan),
                    "Runtime exceeded the scripted charter plan",
                )
                call = peers.plan[index]
                item = {
                    "type": "function_call",
                    "id": f"fc_{index}",
                    "call_id": f"call_{index}",
                    "name": call["name"],
                    "arguments": json.dumps(call["arguments"]),
                    "status": "completed",
                }
                self.gateway = False
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                self.event(
                    {
                        "type": "response.output_item.added",
                        "sequence_number": 0,
                        "output_index": 0,
                        "item": {**item, "status": "in_progress", "arguments": ""},
                    }
                )
                self.event(
                    {
                        "type": "response.function_call_arguments.delta",
                        "sequence_number": 1,
                        "output_index": 0,
                        "item_id": item["id"],
                        "delta": item["arguments"],
                    }
                )
                self.event(
                    {
                        "type": "response.output_item.done",
                        "sequence_number": 2,
                        "output_index": 0,
                        "item": item,
                    }
                )
                self.event(
                    {
                        "type": "response.completed",
                        "sequence_number": 3,
                        "response": {
                            "id": "resp_fixture",
                            "object": "response",
                            "created_at": 1,
                            "model": "fixture",
                            "status": "completed",
                            "output": [item],
                            "usage": {
                                "input_tokens": 100,
                                "output_tokens": 20,
                                "total_tokens": 120,
                            },
                        },
                    }
                )

        return Handler


def token_key(user):
    namespace = uuid.uuid5(uuid.NAMESPACE_DNS, "nemo-agent-toolkit")
    legacy = uuid.uuid5(
        namespace, "daedalus-user-" + hashlib.sha256(user.encode()).hexdigest()[:32]
    )
    return (
        "nat/object_store/calendar-mcp-oauth-rw/tokens/"
        + hashlib.sha256(str(legacy).encode()).hexdigest()
    )


def call(name, **arguments):
    return {"name": name, "arguments": arguments}


def completion(status="completed", **fields):
    return call(
        "submit_autonomous_result",
        outcome={
            "status": status,
            "summary": "Synthetic outcome verified.",
            "evidence": [{"description": "Read synthetic remote state."}],
            **fields,
        },
    )


def main(image, redis_image, preparation):
    peers = CharterPeers()

    def configure(config, port, _runtime_port):
        config["authentication"] = {
            "calendar": {
                "_type": "mcp_oauth2",
                "server_url": "https://calendarmcp.googleapis.com/mcp",
                "client_id": "synthetic",
                "client_secret": "synthetic",
                "redirect_uri": "http://127.0.0.1/unused",
                "scopes": ["https://www.googleapis.com/auth/calendar"],
            }
        }
        config["function_groups"] = {
            group: {
                "_type": "per_user_mcp_client",
                "include": names,
                "defer_discovery": True,
                "discovery_description": f"Synthetic {group}",
                "tool_overrides": {
                    name: {
                        "approval_policy": "auto_approve"
                        if name in WRITES
                        else "read_only"
                    }
                    for name in names
                },
                "server": {
                    "url": f"http://127.0.0.1:{port}/mcp/{group}",
                    "transport": "streamable-http",
                    **(
                        {"auth_provider": "calendar"}
                        if group == "calendar_mcp_server"
                        else {}
                    ),
                },
            }
            for group, names in GROUPS.items()
        }
        config["workflow"].update(
            tools=["current_datetime_tool", *GROUPS],
            max_iterations=20,
            max_history=40,
            max_history_tokens=20000,
        )

    with environment(
        image,
        redis_image,
        peers=peers,
        memory=False,
        configure=configure,
        extra_env=lambda _: {
            "DAEDALUS_PREPARATION": preparation,
            "DAEDALUS_AUTHORIZATION": preparation,
        },
    ) as fixture:
        for user in ("synthetic-alice", "synthetic-bob"):
            fixture["redis"].set(
                token_key(user),
                json.dumps(
                    {
                        "version": 2,
                        "access_token": user + "-grant",
                        "refresh_token": "",
                        "expires_at": time.time() + 3600,
                        "scope": "https://www.googleapis.com/auth/calendar",
                    }
                ),
            )

        def execute(kind, plan, user="synthetic-alice", budget=40):
            peers.plan, peers.remote, peers.requests = plan, [], []
            timestamp = int(time.time() * 1000)
            task = action(kind, f"fixture:{uuid.uuid4().hex}", timestamp)
            if kind == "calendar_event":
                task["payload"] = {
                    "sourceKey": "fixture-event",
                    "sourceUrl": "https://example.org/event",
                    "title": "Fixture event",
                    "applicability": "Synthetic integration check.",
                    "allDay": True,
                    "start": "2099-11-09",
                    "end": "2099-11-10",
                }
            result = measure(
                fixture,
                user=user,
                extra_headers={"x-daedalus-execution-scope": "autonomy"},
                request_fields={
                    "messages": build_messages(
                        config=CharterConfig(maxToolCalls=budget),
                        task=task,
                        state=empty_state(),
                        timestamp=timestamp,
                    ),
                    "autonomy_task": {
                        "id": task["id"],
                        "kind": kind,
                        "max_tool_calls": budget,
                    },
                    "autonomy_output_schema": output_schema(),
                },
            )
            require(
                result["done"] and not result["errors"],
                f"Charter request failed: {result}",
            )
            parse_structured_output(result["answer"])
            return json.loads(result["answer"])

        # Reproduce structural and semantic failures with the actual worker
        # schema. Only completion is retried; the initial clock read runs once.
        game = {
            "sourceKey": "fixture-game",
            "sourceUrl": "https://example.org/game",
            "sport": "football",
            "opponent": "Fixture",
            "status": "scheduled",
            "start": "2099-11-09T12:00:00-05:00",
        }
        valid = completion()
        valid["arguments"]["games"] = [game]
        variants = []
        invalid = copy.deepcopy(valid)
        invalid["arguments"]["games"] = json.dumps([game])
        invalid["arguments"]["outcome"]["private-extra-key"] = "PRIVATE-VALUE"
        variants.append((invalid, "Allowed fields:"))
        for field, value, hint in [
            ("start", "2099-11-09T12:00:00", "explicit UTC offset"),
            ("sourceUrl", "PRIVATE-INVALID-URL", "HTTP(S) URL"),
        ]:
            invalid = copy.deepcopy(valid)
            invalid["arguments"]["games"][0][field] = value
            variants.append((invalid, hint))
        invalid = copy.deepcopy(valid)
        invalid["arguments"]["games"].append(copy.deepcopy(game))
        variants.append((invalid, "must be unique"))
        invalid = copy.deepcopy(valid)
        invalid["arguments"]["outcome"]["evidence"] = []
        variants.append((invalid, "require evidence"))
        invalid = copy.deepcopy(valid)
        invalid["arguments"]["calendarEvents"] = [
            {
                "sourceKey": "fixture-event",
                "sourceUrl": "https://example.org/event",
                "title": "Fixture",
                "applicability": "Fixture",
                "allDay": True,
                "start": "2099-11-09",
                "end": "2099-11-08",
            }
        ]
        variants.append((invalid, "end must follow start"))
        invalid = copy.deepcopy(valid)
        invalid["arguments"]["outcome"]["observedState"] = {"fixture": "x" * 32768}
        variants.append((invalid, "32768 serialized UTF-8 bytes"))
        for note in ["word " * 81, "One. Two. Three. Four."]:
            invalid = copy.deepcopy(valid)
            invalid["arguments"]["outcome"]["summary"] = note
            variants.append((invalid, "human handoff"))
        for invalid, hint in variants:
            result = execute(
                "sports_discovery",
                [
                    call("current_datetime_tool"),
                    invalid,
                    copy.deepcopy(valid),
                ],
            )
            require(result["games"] == [game], "Corrected games were not published")
            require(len(peers.requests) == 3, "Completion correction replayed research")
            feedback = json.dumps(peers.outputs)
            require(hint in feedback, "Correction lacks actionable validation feedback")
            require(
                "PRIVATE" not in feedback and "private-extra-key" not in feedback,
                "Correction leaked private argument values or keys",
            )

        for user in ("synthetic-alice", "synthetic-bob"):
            start, end = {"date": "2026-11-09"}, {"date": "2026-11-14"}
            result = execute(
                "calendar_event",
                [
                    call("calendar_mcp_server__connect"),
                    call("calendar_mcp_server__create_event", start=start, end=end),
                    call("calendar_mcp_server__list_events"),
                    completion(
                        externalId="event-one",
                        observedState={"start": start, "end": end},
                    ),
                ],
                user,
            )
            require(
                result["outcome"]["mutationAttempted"],
                "Mutation receipt was not stamped",
            )
            require(
                [item["authorization"] for item in peers.remote]
                == [f"Bearer {user}-grant"] * 2,
                "Calendar grant crossed users",
            )
            require(
                peers.remote[0]["arguments"] == {"start": start, "end": end},
                "Date-only calendar arguments shifted",
            )

        start = {"dateTime": "2026-11-09T18:00:00-05:00", "timeZone": "America/Detroit"}
        end = {"dateTime": "2026-11-09T20:00:00-05:00", "timeZone": "America/Detroit"}
        execute(
            "calendar_event",
            [
                call("calendar_mcp_server__connect"),
                call(
                    "calendar_mcp_server__update_event",
                    id="event-one",
                    start=start,
                    end=end,
                ),
                call("calendar_mcp_server__list_events"),
                completion(
                    externalId="event-one", observedState={"start": start, "end": end}
                ),
            ],
        )
        require(
            peers.remote[0]["name"] == "update_event"
            and peers.remote[0]["arguments"]["start"] == start,
            "Timed reconciliation was blocked or lost its Eastern offset",
        )

        execute(
            "calendar_discovery",
            [
                call("calendar_mcp_server__connect"),
                call("calendar_mcp_server__create_event"),
                completion("failed"),
            ],
        )
        require(not peers.remote, "Calendar discovery dispatched a write")

        result = execute(
            "calendar_discovery",
            [call("calendar_mcp_server__connect"), completion("deferred")],
            user="synthetic-no-grant",
        )
        require(
            not peers.remote and not result["outcome"]["mutationAttempted"],
            "Missing grant dispatched a request",
        )
        require(
            "oauth_required" not in json.dumps(peers.outputs),
            "Background work started consent",
        )

        result = execute(
            "game_lighting",
            [
                call("hue_mcp_server__connect"),
                call("hue_mcp_server__get_light", id="unreachable"),
                call("hue_mcp_server__set_light_state", id="reachable", on=True),
                call("hue_mcp_server__get_light", id="reachable"),
                completion("partial", skipped=["unreachable"]),
            ],
        )
        require(
            result["outcome"]["skipped"] == ["unreachable"],
            "Partial lighting evidence lost",
        )
        require(
            [item["name"] for item in peers.remote]
            == ["get_light", "set_light_state", "get_light"],
            "Unreachable light blocked reachable lighting or caused an extra write",
        )

        result = execute(
            "cluster_maintenance",
            [
                call("k8s_mcp_server__connect"),
                call("k8s_mcp_server__helmUpgrade", id="app"),
                call(
                    "k8s_mcp_server__deleteResource",
                    kind="Pod",
                    resourceType="PersistentVolumeClaim",
                ),
                call("k8s_mcp_server__rolloutRestart", id="app"),
                call("k8s_mcp_server__rolloutRestart", id="app"),
                completion("deferred"),
                completion("partial"),
                call("k8s_mcp_server__getEvents"),
                completion("partial"),
            ],
        )
        require(
            [item["name"] for item in peers.remote] == ["rolloutRestart", "getEvents"],
            "Upgrade, volume delete, or duplicate mutation escaped the charter",
        )
        require(
            result["outcome"]["mutationAttempted"],
            "An attempted repair was allowed to defer",
        )
        require(
            "no successful subsequent state read" in json.dumps(peers.outputs),
            "Unverified repair completion was not rejected",
        )

        backup_name = "daedalus-autonomy-backup-fixture"
        original = json.loads(json.dumps(peers.config_map))
        backup = f"kubectl create configmap {backup_name} --namespace=home --context=house --from-literal='snapshot={json.dumps(original)}'"
        read_backup = f"kubectl get configmap {backup_name} --namespace=home --context=house -o json"
        patch = 'kubectl patch configmap app --namespace=home --context=house --type=merge --patch=\'{"data":{"timeout":"30"}}\''
        execute(
            "cluster_maintenance",
            [
                call("k8s_mcp_server__connect"),
                call("k8s_mcp_server__getResource", id="app"),
                call("k8s_mcp_server__runKubectlCommand", command=patch),
                call("k8s_mcp_server__runKubectlCommand", command=backup),
                call("k8s_mcp_server__runKubectlCommand", command=patch),
                call("k8s_mcp_server__runKubectlCommand", command=read_backup),
                call(
                    "k8s_mcp_server__runKubectlCommand",
                    command=patch.replace("--context=house", "--context=other"),
                ),
                call("k8s_mcp_server__runKubectlCommand", command=patch),
                call("k8s_mcp_server__getResource", id="app"),
                call(
                    "k8s_mcp_server__execInPod",
                    id="app-pod",
                    command=[
                        "curl",
                        "--fail",
                        "--silent",
                        "--show-error",
                        "--max-time",
                        "10",
                        "http://127.0.0.1:8080/health",
                    ],
                ),
                completion(),
            ],
        )
        require(
            peers.backups[backup_name] == original
            and peers.config_map["data"]["timeout"] == "30",
            "Backup or cluster-managed patch was lost",
        )
        commands = [
            item["arguments"]["command"]
            for item in peers.remote
            if item["name"] == "runKubectlCommand"
        ]
        require(
            commands == [backup, read_backup, patch],
            "Unbacked or cross-context patch reached the cluster",
        )

        result = execute(
            "calendar_discovery",
            [*[call("current_datetime_tool") for _ in range(6)], completion()],
            budget=5,
        )
        require(
            not result["outcome"]["mutationAttempted"],
            "Read-only budget test marked mutation",
        )
        require(
            "Tool budget reached" in json.dumps(peers.outputs),
            "Tool budget was not enforced",
        )
        print(
            json.dumps(
                {
                    "preparation": preparation,
                    "calendar_user_isolation": True,
                    "no_background_consent": True,
                    "lighting_partial_result": True,
                    "upgrade_and_replay_rejected": True,
                    "cluster_backup_before_patch": True,
                    "application_probe": True,
                    "budget_enforced": True,
                }
            )
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--preparation", choices=["rust", "python"], default="rust")
    args = parser.parse_args()
    main(args.image, args.redis_image, args.preparation)
