#!/usr/bin/env python3
"""Supervise the Rust agent and its loopback-only Python tool service."""

import logging
import os
import signal
import subprocess  # nosec B404 - fixed executable argv, no shell
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger("daedalus.runtime")


def main():
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    binary = Path(
        os.getenv(
            "DAEDALUS_RUNTIME_BINARY", str(Path(__file__).with_name("daedalus-runtime"))
        )
    ).resolve()
    if not binary.is_file():
        raise RuntimeError("The Daedalus Rust runtime binary is missing")
    children = []
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    tools_port = int(os.getenv("DAEDALUS_TOOLS_PORT", "8001"))
    env = os.environ.copy()
    env["DAEDALUS_TOOLS_URL"] = f"http://127.0.0.1:{tools_port}"
    try:
        children.append(
            subprocess.Popen(  # nosec B603 - fixed server command
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "daedalus_runtime.service:create_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(tools_port),
                    "--no-access-log",
                    "--timeout-graceful-shutdown",
                    "25",
                ],
                env=env,
                start_new_session=True,
            )
        )
        deadline = time.monotonic() + 120
        while not stopping:
            if children[0].poll() is not None:
                raise RuntimeError("The Python tool service failed to start")
            try:
                with urllib.request.urlopen(
                    env["DAEDALUS_TOOLS_URL"] + "/health", timeout=1
                ) as response:  # nosec B310 - fixed loopback URL
                    if response.status == 200:
                        break
            except (OSError, urllib.error.URLError):
                pass
            if time.monotonic() > deadline:
                raise RuntimeError("The Python tool service did not become healthy")
            time.sleep(0.1)
        if stopping:
            return
        children.append(
            subprocess.Popen([str(binary)], env=env, start_new_session=True)  # nosec B603 - operator-selected runtime executable
        )
        while not stopping:
            if any(child.poll() is not None for child in children):
                raise RuntimeError("A Daedalus runtime process exited unexpectedly")
            time.sleep(0.2)
    finally:
        stop(None, None)
        deadline = time.monotonic() + 30
        for child in children:
            try:
                child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == "__main__":
    main()
