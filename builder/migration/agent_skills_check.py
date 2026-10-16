#!/usr/bin/env python3
"""Compare the retained skill dispatcher with Rust using actual child processes."""

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

from export_agent_skills import materialize, skill
from image_check import require, run

ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT = {
    "PATH": "/workspace/.venv/bin:/usr/bin:/bin",
    "HOME": "/synthetic-home",
    "USER": "synthetic-user",
    "LANG": "C.UTF-8",
    "TZ": "UTC",
    "PYTHONUNBUFFERED": "1",
    "DAEDALUS_INTERNAL_API_TOKEN": "synthetic-private-internal",
    "FUTURE_PROVIDER_SECRET": "synthetic-private-provider",
    "REDIS_URL": "synthetic-private-storage",
}


def scenarios(root):
    cases = []

    def add(
        name,
        source="print('Synthetic script output 雪🌲')\n",
        *,
        filename="script.py",
        config=None,
        arguments=None,
        **fields,
    ):
        directory = root / name / "skills"
        files = {
            "probe/SKILL.md": skill(
                "synthetic", "Synthetic script skill", "Synthetic script instructions"
            ),
            "probe/" + filename: source,
            "../outside.py": "print('must never execute')\n",
        }
        cases.append(
            {
                "name": name,
                "files": files,
                "config": {
                    "skills_directory": str(directory),
                    "allow_script_execution": True,
                    "script_timeout": 1,
                    **(config or {}),
                },
                "input": {
                    "operation": "run_skill_script",
                    "skill_name": "synthetic",
                    "script": filename,
                    **(arguments or {}),
                },
                "processes": str(directory / "probe/pids.json"),
                "ready": str(directory / "probe/ready"),
                **fields,
            }
        )

    add("python-output")
    add(
        "bash-output",
        "printf 'Synthetic stdout\\n'\nprintf 'Synthetic stderr\\n' >&2\nexit 7\n",
        filename="script.sh",
    )
    add("empty-output", "pass\n")
    add(
        "unicode-arguments",
        "import json,sys\nprint(json.dumps(sys.argv[1:]))\n",
        arguments={"args": 'one "two words" 雪\u001cfour'},
    )
    add(
        "environment",
        "import json,os\nprint(json.dumps(dict(os.environ), sort_keys=True))\n",
    )
    add("working-directory", "import os\nprint(os.getcwd())\n")
    add(
        "invalid-output-utf8",
        "import os\nos.write(1,b'good\\xff\\xed\\xa0\\x80tail')\nos.write(2,b'bad\\xe2\\x82')\n",
    )
    add("nonzero", "raise SystemExit(23)\n")
    add("signal-exit", "import os,signal\nos.kill(os.getpid(),signal.SIGTERM)\n")
    add("uppercase-extension", filename="script.PY")
    add("forbidden-extension", filename="script.txt")
    add("empty-extensions", config={"allowed_script_extensions": []})
    add("case-sensitive-allowlist", config={"allowed_script_extensions": [".PY"]})
    add(
        "direct-executable",
        "#!/bin/sh\nprintf 'Direct executable\\n'\n",
        filename="script.bin",
        config={"allowed_script_extensions": [".bin"]},
        permissions={"probe/script.bin": 0o755},
    )
    add(
        "nonexecutable",
        "#!/bin/sh\nexit 0\n",
        filename="script.bin",
        config={"allowed_script_extensions": [".bin"]},
    )
    add("no-interpreter", env={"PATH": "/synthetic-missing"})
    add(
        "no-bash",
        "printf 'unreachable'\n",
        filename="script.sh",
        env={"PATH": "/synthetic-missing"},
    )
    add("unknown-skill", arguments={"skill_name": "missing"})
    add("missing-script", arguments={"script": "missing.py"})
    add("directory-script", arguments={"script": "."})
    add("traversal", arguments={"script": "../../outside.py"})
    add(
        "outside-symlink",
        links={"probe/outside.py": "../../outside.py"},
        arguments={"script": "outside.py"},
    )
    add(
        "inside-symlink",
        links={"probe/inside.py": "script.py"},
        arguments={"script": "inside.py"},
    )
    add("null-path", arguments={"script": "script\x00.py"})
    add("stdout-limit", "import os\nos.write(1,b'x'*1048577)\n")
    add("stderr-limit", "import os\nos.write(2,b'y'*1048577)\n")
    add("timeout", "import time\nprint('Before timeout',flush=True)\ntime.sleep(30)\n")
    record = "import json,os,pathlib,subprocess,sys,time\n"
    record += "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']{redirect})\n"
    record += "pathlib.Path('pids.json').write_text(json.dumps(dict(parent=os.getpid(),group=os.getpgrp(),session=os.getsid(0),children=[child.pid])))\n"
    record += (
        "pathlib.Path('ready').write_text('ready')\nprint('Parent ready',flush=True)\n"
    )
    add("descendant-timeout", record.replace("{redirect}", ""))
    add(
        "descendant-normal-exit",
        record.replace(
            "{redirect}", ",stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL"
        ),
    )
    add(
        "cancel-process-group",
        record.replace("{redirect}", "") + "time.sleep(30)\n",
        cancel=True,
        config={"script_timeout": 30},
    )
    return cases


def prepare(cases):
    for case in cases:
        directory = Path(case["config"]["skills_directory"])
        if directory.parent.exists():
            shutil.rmtree(directory.parent)
        materialize(directory, case)


def summarized(value):
    if isinstance(value, str) and len(value) > 10000:
        return {
            "length": len(value),
            "sha256": hashlib.sha256(value.encode()).hexdigest(),
            "prefix": value[:100],
            "suffix": value[-250:],
        }
    if isinstance(value, dict):
        return {k: summarized(v) for k, v in value.items()}
    if isinstance(value, list):
        return [summarized(v) for v in value]
    return value


def main(args):
    with tempfile.TemporaryDirectory(prefix="daedalus-skills-process-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        cases = scenarios(root)
        prepare(cases)
        document = {"environment": ENVIRONMENT, "cases": cases}
        (root / "input.json").write_text(json.dumps(document))
        run(
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "-e",
            "PYTHONPATH=/workspace",
            "-e",
            "PYTHONHASHSEED=0",
            "-v",
            f"{ROOT / 'migration'}:/migration:ro",
            "-v",
            f"{root}:{root}",
            "--entrypoint",
            "/workspace/.venv/bin/python",
            args.python_image,
            "/migration/agent_skills_baseline.py",
            "--input",
            str(root / "input.json"),
            "--output",
            str(root / "python.json"),
        )
        expected = json.loads((root / "python.json").read_text())
        prepare(cases)
        run(
            "cargo",
            "test",
            "--locked",
            "agent_skills::actual_processes",
            "--",
            "--ignored",
            "--nocapture",
            cwd=ROOT / "runtime",
            env={
                **os.environ,
                "DAEDALUS_SKILLS_INPUT": str(root / "input.json"),
                "DAEDALUS_SKILLS_OUTPUT": str(root / "rust.json"),
            },
        )
        actual = json.loads((root / "rust.json").read_text())
        require(len(expected) == len(actual), "Missing script observations")
        for python, rust in zip(expected, actual, strict=True):
            require(
                python == rust,
                f"Script mismatch: {python['name']}\n{summarized(python)}\n{summarized(rust)}",
            )
        report = {
            "status": "passed-native-skill-processes",
            "cases": summarized(actual),
            "python_image": run(
                "docker",
                "image",
                "inspect",
                args.python_image,
                "--format",
                "{{.Id}}",
                capture_output=True,
                text=True,
            ).stdout.strip(),
            "source_sha256": {
                str(path.relative_to(ROOT)): hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                for path in [
                    ROOT / "runtime/src/agent_skills.rs",
                    ROOT / "runtime/src/yaml.rs",
                    Path(__file__),
                    Path(__file__).with_name("agent_skills_baseline.py"),
                ]
            },
        }
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
