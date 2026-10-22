"""Offline executor for the scoreboard helper, not a simulated language model."""

import json
import subprocess  # nosec B404
import sys
from pathlib import Path

request = json.loads(sys.stdin.read())
# The prompt is retained as explicitly framed data. This adapter executes only
# the documented helper contract; it never executes instructions from a prompt.
Path("/work/snapshot.json").write_text(json.dumps(request["input"]))
script = Path("/skill/scripts/check_scoreboard.py")
if not script.is_file():
    output = (
        json.dumps({"ok": False, "status": "not run", "reason": "skill helper absent"})
        + "\n"
    )
    print(json.dumps({"exit_code": 2, "stdout": output, "stderr": ""}))
    sys.exit(0)
result = subprocess.run(  # nosec B603
    [sys.executable, "-I", str(script), "/work/snapshot.json"],
    capture_output=True,
    text=True,
    timeout=10,
    check=False,
)
Path("/work/result.json").write_text(result.stdout or result.stderr)
# The adapter owns this channel. Candidate-writable files never supply process
# status. Extra output injected through /proc fails the single-JSON parser.
print(
    json.dumps(
        {
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    )
)
