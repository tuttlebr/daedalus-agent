#!/usr/bin/env python3
"""Exercise the shipped Compose Redis command on disposable Docker resources."""

import argparse
import json
import os
import secrets
import shutil

# disposable local Docker fixture; shell-free argv
import subprocess  # nosec B404
import sys
import time
import uuid
from pathlib import Path


def run(*args, **kwargs):
    # resolved Docker and fixture-controlled argv
    output = subprocess.check_output(  # nosec B603
        args, text=True, shell=False, timeout=60, **kwargs
    )
    return output.strip()


def require(condition, message):
    """Keep fixture operations and checks active under python -O."""
    if not condition:
        raise AssertionError(message)


def cleanup(commands):
    failures = []
    for command in commands:
        try:
            # only UUID-named resources owned by this fixture
            result = subprocess.run(  # nosec B603
                command, capture_output=True, text=True, timeout=60, shell=False
            )
            if result.returncode:
                failures.append(f"{' '.join(command[1:])}: exit {result.returncode}")
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(f"{' '.join(command[1:])}: {type(error).__name__}")
    if failures:
        message = "Fixture cleanup failed: " + "; ".join(failures)
        if error := sys.exception():
            # Preserve the primary setup/test error, even if a resource was
            # never created or the Docker daemon also fails during cleanup.
            error.add_note(message)
        else:
            raise RuntimeError(message)


def check_user(image, username):
    root = Path(__file__).resolve().parents[1]
    docker = shutil.which("docker")
    if docker is None:
        raise FileNotFoundError("Required executable not found: docker")
    docker = str(Path(docker).resolve())
    prefix = f"daedalus-redis-test-{uuid.uuid4().hex[:10]}"
    password = secrets.token_urlsafe(32) + " with # ACL characters"
    env = dict(os.environ, REDIS_USERNAME=username, REDIS_PASSWORD=password)
    config = json.loads(
        run(
            docker,
            "compose",
            "--env-file",
            str(root / ".env.template"),
            "-f",
            str(root / "docker-compose.yaml"),
            "config",
            "--no-env-resolution",
            "--format",
            "json",
            env=env,
        )
    )["services"]["redis"]
    network, volume, server = prefix + "-net", prefix + "-data", prefix + "-server"
    run(docker, "network", "create", "--internal", network)
    cleanup_commands = [[docker, "network", "rm", network]]
    try:
        run(docker, "volume", "create", volume)
        cleanup_commands.insert(0, [docker, "volume", "rm", "-f", volume])
        # A failed start can still leave a created container behind.
        cleanup_commands.insert(0, [docker, "rm", "-f", server])
        run(
            docker,
            "run",
            "-d",
            "--name",
            server,
            "--network",
            network,
            "--mount",
            f"type=volume,source={volume},target=/data",
            "--env",
            f"REDIS_USERNAME={username}",
            "--env",
            f"REDIS_PASSWORD={password}",
            "--entrypoint",
            config["entrypoint"][0],
            image,
            *config["command"],
        )

        def cli(*args, auth=True):
            command = [docker, "run", "--rm", "--network", network]
            if auth:
                command += ["--env", f"REDISCLI_AUTH={password}"]
            return run(
                *command,
                "--entrypoint",
                "redis-cli",
                image,
                "-h",
                server,
                "--user",
                username,
                *args,
            )

        def ready():
            for _ in range(30):
                try:
                    if cli("PING") == "PONG":
                        return
                except subprocess.CalledProcessError:
                    pass
                time.sleep(0.2)
            raise AssertionError(run(docker, "logs", server))

        ready()
        require("NOAUTH" in cli("GET", "private", auth=False), "Anonymous GET allowed")
        require("NOPERM" in cli("CONFIG", "GET", "*"), "App user can read CONFIG")
        require(
            cli("JSON.SET", "fixture", "$", '{"retained":true}') == "OK",
            "JSON.SET failed",
        )
        entry = cli("XADD", "fixture-stream", "*", "field", "value")
        require(
            cli("XGROUP", "CREATE", "fixture-stream", "fixture-group", "0") == "OK",
            "XGROUP CREATE failed",
        )
        require(
            entry
            in cli(
                "XREADGROUP",
                "GROUP",
                "fixture-group",
                "consumer",
                "STREAMS",
                "fixture-stream",
                ">",
            ),
            "Consumer did not receive the stream entry",
        )
        run(docker, "restart", server)
        ready()
        require(
            json.loads(cli("JSON.GET", "fixture")) == {"retained": True},
            "JSON document lost across restart",
        )
        require(
            entry in cli("XPENDING", "fixture-stream", "fixture-group"),
            "Stream pending entry lost across restart",
        )
        require(
            "NOAUTH" in cli("PING", auth=False), "Anonymous PING allowed after restart"
        )
    finally:
        cleanup(cleanup_commands)
    print(
        f"PASS {username}: remote auth, anonymous/CONFIG denial, JSON and Stream PEL restart",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--image", required=True, help="Already built repository Redis image"
    )
    args = parser.parse_args()
    for user in ("default", "daedalus"):
        check_user(args.image, user)
