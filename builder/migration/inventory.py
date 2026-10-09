#!/usr/bin/env python3
"""Record the immutable baseline's capabilities and dependency inventory."""

import argparse
import ast
import hashlib
import json
import subprocess  # nosec B404 - read-only Git and isolated image inspection
import tomllib
from pathlib import Path

BASELINE = "7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b"
ROOT = Path(__file__).resolve().parents[2]


def output(*args):
    return subprocess.check_output(args, cwd=ROOT)  # nosec B603


def inventory(image):
    files = (
        output("git", "ls-tree", "-r", "--name-only", BASELINE).decode().splitlines()
    )
    routes, hashes = [], {}
    for path in files:
        if path.startswith("backend/") and path.endswith((".yaml", ".yml")):
            hashes[path] = hashlib.sha256(
                output("git", "show", f"{BASELINE}:{path}")
            ).hexdigest()
        if (
            not path.startswith("builder/")
            or not path.endswith(".py")
            or "/tests/" in path
        ):
            continue
        source = output("git", "show", f"{BASELINE}:{path}")
        tree = ast.parse(source)
        prefixes = {}
        for call in ast.walk(tree):
            if (
                isinstance(call, ast.Assign)
                and isinstance(call.value, ast.Call)
                and isinstance(call.value.func, ast.Name)
                and call.value.func.id == "APIRouter"
            ):
                prefix = next(
                    (
                        kw.value.value
                        for kw in call.value.keywords
                        if kw.arg == "prefix" and isinstance(kw.value, ast.Constant)
                    ),
                    "",
                )
                for target in call.targets:
                    if isinstance(target, ast.Name):
                        prefixes[target.id] = prefix
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_api_route"
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                methods = next(
                    (kw.value for kw in node.keywords if kw.arg == "methods"), None
                )
                if isinstance(methods, ast.List):
                    for method in methods.elts:
                        routes.append(
                            {
                                "source": path,
                                "line": node.lineno,
                                "method": method.value,
                                "path": node.args[0].value,
                            }
                        )
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if (
                    isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Attribute)
                    and decorator.func.attr in {"get", "post", "put", "delete", "patch"}
                    and decorator.args
                    and isinstance(decorator.args[0], ast.Constant)
                    and isinstance(decorator.args[0].value, str)
                    and decorator.args[0].value.startswith("/")
                ):
                    routes.append(
                        {
                            "source": path,
                            "line": node.lineno,
                            "method": decorator.func.attr.upper(),
                            "path": prefixes.get(
                                getattr(decorator.func.value, "id", ""), ""
                            )
                            + decorator.args[0].value,
                            "handler": node.name,
                        }
                    )
    routes.extend(
        [
            {
                "source": "builder/runtime/src/main.rs",
                "method": "POST",
                "path": "/v1/chat/completions",
            },
            {
                "source": "builder/runtime/src/main.rs",
                "method": "POST",
                "path": "/v1/runs/{run_id}/control",
            },
        ]
    )
    script = """
import hashlib, importlib.metadata as m, json
from pathlib import Path
packages = [{"name": d.metadata['Name'], "version": d.version, "license": d.metadata.get('License-Expression') or d.metadata.get('License') or 'not declared'} for d in m.distributions()]
sources = {p:hashlib.sha256(Path('/workspace',p).read_bytes()).hexdigest() for p in ['entrypoint.py','daedalus_runtime/service.py','daedalus_runtime/config.py','daedalus_runtime/mcp.py','daedalus_runtime/oauth.py']}
print(json.dumps({"packages": sorted(packages, key=lambda p:p['name'].lower()), "source_hashes":sources}))
"""
    installed = json.loads(
        output(
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "python",
            image,
            "-c",
            script,
        )
    )
    for path, digest in installed["source_hashes"].items():
        if (
            hashlib.sha256(
                output("git", "show", f"{BASELINE}:builder/{path}")
            ).hexdigest()
            != digest
        ):
            raise ValueError(f"Baseline source mismatch: {path}")
    info = json.loads(output("docker", "image", "inspect", image))[0]
    lockfiles = [
        "builder/runtime/Cargo.toml",
        "builder/runtime/Cargo.lock",
        "builder/pylock.runtime-linux-amd64.toml",
        "builder/pylock.runtime-linux-arm64.toml",
        "builder/Dockerfile",
    ]
    source_hashes = {
        path: hashlib.sha256(output("git", "show", f"{BASELINE}:{path}")).hexdigest()
        for path in lockfiles
    }
    rust_packages = tomllib.loads(
        output("git", "show", f"{BASELINE}:builder/runtime/Cargo.lock").decode()
    )["package"]
    compressed = None
    if "@sha256:" in image:
        manifest = json.loads(
            output("docker", "buildx", "imagetools", "inspect", image, "--raw")
        )
        if "manifests" in manifest:
            platform = next(
                m
                for m in manifest["manifests"]
                if m.get("platform", {}).get("architecture") == info["Architecture"]
                and m.get("platform", {}).get("os") == "linux"
            )
            manifest = json.loads(
                output(
                    "docker",
                    "buildx",
                    "imagetools",
                    "inspect",
                    image.split("@")[0] + "@" + platform["digest"],
                    "--raw",
                )
            )
        compressed = sum(layer["size"] for layer in manifest["layers"])
    return {
        "version": 1,
        "baseline_sha": BASELINE,
        "image_id": info["Id"],
        "image_digests": [v.split("@")[-1] for v in info["RepoDigests"]],
        "architecture": info["Architecture"],
        "image_bytes": info["Size"],
        "compressed_layer_bytes": compressed,
        "configuration_sha256": hashes,
        "build_input_sha256": source_hashes,
        "rust_packages": rust_packages,
        "routes": routes,
        **installed,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(inventory(args.image), indent=2) + "\n")
