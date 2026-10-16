#!/usr/bin/env python3
"""Verify skill schemas, model promotion, scripts and Stop through built images."""

import argparse
import concurrent.futures
import contextlib
import copy
import hashlib
import json
import re
import shlex
import shutil
import tempfile
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from agent_skills_check import summarized
from document_tool_receipts_check import normalized as chat_result
from export_agent_skills import catalogs, materialize, skill
from image_check import environment, require, run
from leaf_check import LeafPeers, measure

ROOT = Path(__file__).resolve().parents[1]


@contextlib.contextmanager
def interpreter(image, root):
    """Provide an operator-owned interpreter without adding Python to the image."""
    prefix = root / "interpreter"
    (prefix / "bin").mkdir(parents=True)
    (prefix / "lib").mkdir()
    container = run(
        "docker", "create", image, "/bin/true", capture_output=True, text=True
    ).stdout.strip()
    try:
        run(
            "docker",
            "cp",
            container + ":/usr/bin/python3.12",
            str(prefix / "bin/python3.12"),
        )
        run(
            "docker",
            "cp",
            container + ":/usr/lib/python3.12",
            str(prefix / "lib/python3.12"),
        )
        linked = run(
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "/usr/bin/ldd",
            image,
            "/usr/bin/python3.12",
            capture_output=True,
            text=True,
        ).stdout
        for path in set(re.findall(r"(/[^\s()]+)", linked)):
            run(
                "docker",
                "cp",
                "-L",
                container + ":" + path,
                str(prefix / "lib" / Path(path).name),
            )
    finally:
        run("docker", "rm", container, capture_output=True)
    launcher = prefix / "bin/python3"
    launcher.write_text(
        "#!/bin/sh\nexport PYTHONHOME="
        + shlex.quote(str(prefix))
        + "\nexport LD_LIBRARY_PATH="
        + shlex.quote(str(prefix / "lib"))
        + "\nexec "
        + shlex.quote(str(prefix / "bin/python3.12"))
        + ' "$@"\n'
    )
    launcher.chmod(0o755)
    yield prefix


class SkillPeers(LeafPeers):
    def __init__(self):
        super().__init__()
        self.script_started = threading.Event()
        self.pids = []

    def handler(self):
        peer = self

        class Handler(super().handler()):
            def do_POST(self):
                if self.path == "/script-start":
                    body = self.rfile.read(int(self.headers["Content-Length"])).decode()
                    peer.pids = [int(pid) for pid in body.split()]
                    require(
                        len(peer.pids) == 2 and all(pid > 1 for pid in peer.pids),
                        "Invalid script process barrier",
                    )
                    peer.script_started.set()
                    try:
                        return self.reply({})
                    except (BrokenPipeError, ConnectionResetError):
                        return None
                return super().do_POST()

        return Handler


def clock_values(value):
    if isinstance(value, dict):
        return {k: clock_values(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clock_values(v) for v in value]
    marker = "## Current date and time (trusted backend clock)\n\n"
    if isinstance(value, str) and marker in value:
        line = value.split(marker, 1)[1].splitlines()[0]
        clock = json.loads(line)
        utc = datetime.fromisoformat(clock["utc"])
        local = datetime.fromisoformat(clock["local"])
        require(
            clock["source"] == "daily_summary_runtime_clock"
            and clock["timezone"] == "America/Detroit",
            "Invalid skill clock metadata",
        )
        require(
            abs((datetime.now(UTC) - utc).total_seconds()) < 30, "Skill clock is stale"
        )
        require(
            local == utc
            and local.utcoffset()
            == utc.astimezone(ZoneInfo(clock["timezone"])).utcoffset(),
            "Skill clock lost timezone conversion",
        )
        return value.replace(line, "<verified backend clock>")
    return value


def alive(env, pid):
    result = run(
        "docker",
        "exec",
        env["container"],
        "/bin/cat",
        f"/proc/{pid}/stat",
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and result.stdout.rsplit(")", 1)[1].split()[0] != "Z"


def stop_script(env, peer, port):
    peer.script_started.clear()
    peer.plan = [
        {
            "name": "scripts",
            "arguments": {
                "operation": "run_skill_script",
                "skill_name": "synthetic",
                "script": "stop.sh",
                "args": str(port),
            },
        }
    ]
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor() as pool:
        task = pool.submit(measure, env, request_id=request_id, message="hi")
        require(peer.script_started.wait(10), "Script never reached Stop barrier")
        require(
            all(alive(env, pid) for pid in peer.pids),
            "Script descendants exited before Stop",
        )
        env["client"].post(
            env["base"] + f"/v1/runs/{request_id}/control",
            headers=env["headers"],
            json={"type": "cancel", "command_id": str(uuid.uuid4())},
        ).raise_for_status()
        stopped = chat_result(task.result(timeout=8))
        require(
            stopped["done"]
            and stopped["terminal"] == "error"
            and stopped["errors"] == [{"error": {"message": "Run cancelled by user"}}],
            "Stop did not terminate the skill run",
        )
        deadline = time.monotonic() + 5
        while any(alive(env, pid) for pid in peer.pids):
            require(time.monotonic() < deadline, "Script process survived Stop")
            threading.Event().wait(0.02)
    require(
        len(stopped["starts"]) == 1
        and stopped["starts"][0]["payload"] == peer.plan[0]["arguments"],
        "Stop lost the script arguments",
    )
    # Each disposable peer has a distinct port; verify it before normalization.
    stopped["starts"][0]["payload"]["args"] = "<verified fixture port>"
    peer.plan = [
        {
            "name": "scripts",
            "arguments": {
                "operation": "run_skill_script",
                "skill_name": "synthetic",
                "script": "output.sh",
            },
        }
    ]
    recovered = chat_result(measure(env, message="hi"))
    require(
        recovered["done"] and not recovered["errors"] and len(recovered["ends"]) == 1,
        "Skill execution did not recover after Stop",
    )
    return {"stopped": stopped, "recovered": recovered}


def startup_checks(args, profiles, root, skills):
    observations = []
    for label, image, minimal, preparation, authorization in profiles:
        for case in ["unknown-skill", "loading-disabled", "unselected-tool"]:

            def configure(config, *_):
                config["functions"]["skills"] = {
                    "_type": "agent_skills",
                    "skills_directory": str(skills),
                    **(
                        {"enabled_operations": ["list_skills"]}
                        if case == "loading-disabled"
                        else {}
                    ),
                }
                if case != "unselected-tool":
                    config["workflow"]["tools"].append("skills")
                config["workflow"]["skill_model_profiles"] = {
                    "missing" if case == "unknown-skill" else "synthetic": "deep"
                }

            try:
                with environment(
                    image,
                    args.redis_image,
                    minimal=minimal,
                    memory=False,
                    configure=configure,
                    fixture_mounts=[(root, root)],
                    extra_env=lambda _, p=preparation, a=authorization: {
                        "DAEDALUS_PREPARATION": p,
                        "DAEDALUS_AUTHORIZATION": a,
                        "DAEDALUS_TOOL_EXECUTOR": "disabled"
                        if p == a == "rust"
                        else "python",
                    },
                ):
                    raise AssertionError(
                        f"Invalid skill mapping reached readiness: {label}/{case}"
                    )
            except RuntimeError as error:
                require(
                    (
                        "Unknown or unavailable skill_model_profiles" in str(error)
                        or "Invalid Daedalus runtime configuration: ValueError"
                        in str(error)
                    ),
                    f"Unexpected startup failure: {error}",
                )
            observations.append({"profile": label, "case": case, "rejected": True})
            print(f"Skill startup: {label}/{case}", flush=True)
    return observations


def packaging_checks(args):
    manifests = []
    for image in [args.python_image, args.image, args.minimal_image]:
        manifests.append(
            run(
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--entrypoint",
                "sh",
                image,
                "-c",
                "find /skills -type f -exec sha256sum {} + | LC_ALL=C sort",
                capture_output=True,
                text=True,
            ).stdout
        )
    require(
        manifests[0] and manifests[0] == manifests[1] == manifests[2],
        "Packaged skill files differ between profiles",
    )
    run(
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--entrypoint",
        "sh",
        args.minimal_image,
        "-c",
        "! command -v python && ! command -v python3 && test ! -e /workspace/.venv && test ! -e /usr/lib/python3 && test ! -e /usr/lib/python3.12",
    )
    uid = run(
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "id",
        args.minimal_image,
        "-u",
        capture_output=True,
        text=True,
    ).stdout.strip()
    require(uid != "0", "Minimal image must run without root")
    return {
        "skill_files": len(manifests[0].splitlines()),
        "manifest_sha256": hashlib.sha256(manifests[0].encode()).hexdigest(),
        "minimal_uid": uid,
        "minimal_python_absent": True,
    }


def main(args):
    profiles, baseline, cancellation_baseline = [], None, None
    packaging = packaging_checks(args)
    candidates = [
        ("retained", args.python_image, False, "python", "python"),
        ("native-full", args.image, False, "rust", "rust"),
        ("native-python-auth", args.image, False, "rust", "python"),
        ("native-minimal", args.minimal_image, True, "rust", "rust"),
    ]
    with tempfile.TemporaryDirectory(prefix="daedalus-skills-http-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        skills = root / "skills"
        materialize(
            skills,
            {
                "files": {
                    "probe/SKILL.md": skill(
                        "synthetic",
                        "Synthetic routing skill",
                        "Synthetic loaded instructions 雪🌲",
                    ),
                    "probe/resource.txt": "Synthetic resource content 🌲\r\n",
                    "probe/binary.bin": {"hex": "ff"},
                    "probe/output.sh": "printf 'Synthetic script stdout\\n'\nprintf 'Synthetic script stderr\\n' >&2\nexit 7\n",
                    "probe/args.sh": "printf '<%s>\\n' \"$@\"\n",
                    "probe/env.sh": 'printf "%s|%s|%s|%s\\n" "$USER" "${FUTURE_PROVIDER_SECRET-unset}" "${DAEDALUS_INTERNAL_API_TOKEN-unset}" "${REDIS_URL-unset}"\n',
                    "probe/empty.sh": "exit 0\n",
                    "probe/timeout.sh": "printf 'Before timeout\\n'\nsleep 30\n",
                    "probe/python.py": "import json,sys\nprint(json.dumps(sys.argv[1:]))\n",
                    "probe/flood.py": "import os\nos.write(1,b'x'*1048577)\n",
                    "probe/stop.sh": 'sleep 30 &\nchild=$!\nexec 3<>/dev/tcp/127.0.0.1/$1\nbody="$BASHPID $child"\nprintf "POST /script-start HTTP/1.0\\r\\nContent-Length: %s\\r\\n\\r\\n%s" "${#body}" "$body" >&3\nIFS= read -r line <&3\nexec 3<&-\nexec 3>&-\nwait\n',
                    "../outside.txt": "Synthetic external file",
                },
                "links": {"probe/outside-link": "../../outside.txt"},
            },
        )
        daily = next(case for case in catalogs() if case["name"] == "daily-summary")
        materialize(skills, daily)
        cases = []

        def add(name, operation="list_skills", tool="skills", **arguments):
            cases.append(
                {
                    "name": name,
                    "tool": tool,
                    "input": {"operation": operation, **arguments},
                }
            )

        add("list")
        add("cached-list")
        add("query", query="SYNTHETIC")
        add("whitespace-query", query=" \u001c")
        add("load-and-promote", "load_skill", skill_name="synthetic")
        add("load-cached", "load_skill", skill_name="synthetic")
        add(
            "resource-no-promotion",
            "load_skill",
            skill_name="synthetic",
            resource="resource.txt",
        )
        add("unknown", "load_skill", skill_name="missing")
        add(
            "missing-resource",
            "load_skill",
            skill_name="synthetic",
            resource="missing.txt",
        )
        add(
            "binary-resource",
            "load_skill",
            skill_name="synthetic",
            resource="binary.bin",
        )
        add(
            "traversal",
            "load_skill",
            skill_name="synthetic",
            resource="../../outside.txt",
        )
        add(
            "symlink-escape",
            "load_skill",
            skill_name="synthetic",
            resource="outside-link",
        )
        add("daily-bootstrap", "load_skill", skill_name="daily-summary")
        add(
            "script-disabled",
            "run_skill_script",
            skill_name="synthetic",
            script="output.sh",
        )
        add(
            "operation-disabled", "load_skill", tool="list_only", skill_name="synthetic"
        )
        add("all-disabled", tool="disabled")
        add("bad-argument", "load_skill", skill_name="synthetic", query="forbidden")
        add("bundled-catalog", tool="bundled")
        add(
            "bundled-instructions",
            "load_skill",
            tool="bundled",
            skill_name="creative-ideation",
        )
        for filename, arguments in [
            ("output.sh", {}),
            ("args.sh", {"args": 'one "two words" 雪\u001cfour'}),
            ("env.sh", {}),
            ("empty.sh", {}),
            ("timeout.sh", {}),
            ("python.py", {"args": "Synthetic 雪"}),
            ("flood.py", {}),
            ("missing.sh", {}),
        ]:
            add(
                "script-" + filename,
                "run_skill_script",
                tool="short_scripts" if filename == "timeout.sh" else "scripts",
                skill_name="synthetic",
                script=filename,
                **arguments,
            )
        with interpreter(args.python_image, root) as supplied_python:
            for label, image, minimal, preparation, authorization in candidates:
                peer, observed = SkillPeers(), []
                ports = []
                for name in ["late", "after-catalog"]:
                    shutil.rmtree(skills / name, ignore_errors=True)

                def configure(config, port, *_):
                    ports.append(port)
                    common = {"_type": "agent_skills", "skills_directory": str(skills)}
                    config["functions"] = {
                        "skills": common,
                        "scripts": {**common, "allow_script_execution": True},
                        "short_scripts": {
                            **common,
                            "allow_script_execution": True,
                            "script_timeout": 1,
                        },
                        "list_only": {**common, "enabled_operations": ["list_skills"]},
                        "disabled": {**common, "enabled_operations": []},
                        "bundled": {"_type": "agent_skills"},
                    }
                    config["workflow"]["tools"] = list(config["functions"])
                    config["workflow"]["skill_model_profiles"] = {"synthetic": "deep"}
                    config["workflow"]["tool_output_compaction_enabled"] = False

                with environment(
                    image,
                    args.redis_image,
                    minimal=minimal,
                    memory=False,
                    peers=peer,
                    configure=configure,
                    fixture_mounts=[(root, root)],
                    extra_env=lambda _, p=preparation, a=authorization: {
                        "DAEDALUS_PREPARATION": p,
                        "DAEDALUS_AUTHORIZATION": a,
                        "DAEDALUS_TOOL_EXECUTOR": "disabled"
                        if p == a == "rust"
                        else "python",
                        "PATH": str(supplied_python / "bin")
                        + ":/workspace/.venv/bin:/usr/bin:/bin",
                        "USER": "synthetic-user",
                        "FUTURE_PROVIDER_SECRET": "synthetic-private-provider",
                    },
                ) as env:
                    materialize(
                        skills,
                        {
                            "files": {
                                "late/SKILL.md": skill(
                                    "late", "Added after startup", "Late instructions"
                                )
                            }
                        },
                    )
                    for case in cases:
                        before, outputs = len(peer.requests), len(peer.results)
                        peer.plan = [{"name": case["tool"], "arguments": case["input"]}]
                        result = chat_result(measure(env, message="hi"))
                        require(
                            result["done"] and not result["errors"],
                            f"Skill chat failed: {label}/{case['name']}",
                        )
                        result["model_outputs"] = copy.deepcopy(peer.results[outputs:])
                        if case["name"] in {"list", "cached-list"}:
                            listed = json.loads(peer.results[outputs][0]["output"])[
                                "skills"
                            ]
                            require(
                                "late" in [entry["name"] for entry in listed],
                                "Startup validation cached the runtime catalog",
                            )
                            require(
                                "after-catalog"
                                not in [entry["name"] for entry in listed],
                                "Initialized skill catalog was unexpectedly refreshed",
                            )
                        if case["name"] == "list":
                            materialize(
                                skills,
                                {
                                    "files": {
                                        "after-catalog/SKILL.md": skill(
                                            "after-catalog",
                                            "Added after discovery",
                                            "Not cached",
                                        )
                                    }
                                },
                            )
                        result["models"] = [
                            item["model"] for item in peer.requests[before:]
                        ]
                        if case["name"] in {"load-and-promote", "load-cached"}:
                            require(
                                result["models"] == ["fixture", "fixture/deep"],
                                "Main instructions did not promote the model exactly once",
                            )
                        else:
                            require(
                                all(model == "fixture" for model in result["models"]),
                                "Resource or failed load promoted the model",
                            )
                        schemas = [
                            tool.get("function", tool)
                            for tool in peer.requests[before]["tools"]
                        ]
                        schema = next(
                            tool for tool in schemas if tool.get("name") == case["tool"]
                        )
                        result["schema"] = {
                            key: schema[key]
                            for key in ["name", "description", "parameters"]
                        }
                        item = {"name": case["name"], "result": clock_values(result)}
                        observed.append(item)
                        if baseline is not None:
                            require(
                                item == baseline[len(observed) - 1],
                                f"Skill HTTP mismatch: {label}/{case['name']}\n{summarized(item)}\n{summarized(baseline[len(observed)-1])}",
                            )
                        print(f"Skill HTTP: {label}/{case['name']}", flush=True)
                    cancellation = stop_script(env, peer, ports[0])
                    if cancellation_baseline is None:
                        cancellation_baseline = cancellation
                    else:
                        require(
                            cancellation == cancellation_baseline,
                            f"Skill Stop mismatch: {label}\n{cancellation}\n{cancellation_baseline}",
                        )
                if baseline is None:
                    baseline = observed
                profiles.append(
                    {
                        "name": label,
                        "cases": summarized(observed),
                        "cancellation": cancellation,
                        "image": run(
                            "docker",
                            "image",
                            "inspect",
                            image,
                            "--format",
                            "{{.Id}}",
                            capture_output=True,
                            text=True,
                        ).stdout.strip(),
                    }
                )
        startup = startup_checks(args, candidates, root, skills)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-native-skills-http",
                "profiles": profiles,
                "startup": startup,
                "packaging": packaging,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        ROOT / "runtime/src/agent_skills.rs",
                        ROOT / "runtime/src/preparation.rs",
                        ROOT / "runtime/src/agent.rs",
                        Path(__file__),
                    ]
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["python-image", "image", "minimal-image", "redis-image"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
