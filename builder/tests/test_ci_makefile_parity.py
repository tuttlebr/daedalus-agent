"""F-008: enforce that the local `make builder` gate mirrors the CI builder job.

The Makefile header promises it mirrors `.github/workflows/ci.yml`, but nothing
enforced it — a new pytest flag added to CI (e.g. `--cov-fail-under=50`) without
updating the Makefile would pass `make builder` locally yet fail in CI (or the
reverse). This test parses the pytest invocation from the Makefile `builder`
target and the ci.yml `builder` job and asserts their flag sets are identical, so
drift fails fast in the unit suite itself.
"""

import json
from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MAKEFILE = _REPO_ROOT / "Makefile"
_CI = _REPO_ROOT / ".github" / "workflows" / "ci.yml"
_MIGRATION = _REPO_ROOT / ".github" / "workflows" / "rust-migration.yml"
_RELEASE = _REPO_ROOT / ".github" / "workflows" / "release.yml"
_FRONTEND_PACKAGE = _REPO_ROOT / "frontend" / "package.json"
_FRONTEND_LOCK = _REPO_ROOT / "frontend" / "package-lock.json"


def _pytest_flags(command: str) -> set[str]:
    """Return the set of `-`-prefixed flags after the last `pytest` token."""
    tokens = command.split()
    pytest_idxs = [i for i, t in enumerate(tokens) if t == "pytest"]
    assert pytest_idxs, f"no pytest invocation found in: {command!r}"
    return {t for t in tokens[pytest_idxs[-1] + 1 :] if t.startswith("-")}


def _makefile_builder_pytest_line() -> str:
    in_builder = False
    for line in _MAKEFILE.read_text().splitlines():
        if line.startswith("builder:"):
            in_builder = True
            continue
        if in_builder:
            # A new col-0 target ends the recipe block.
            if line and not line[0].isspace():
                break
            if "pytest" in line and "--cov" in line:
                return line.strip()
    raise AssertionError("no `pytest --cov` recipe line in Makefile `builder` target")


def _ci_builder_pytest_command() -> str:
    ci = yaml.safe_load(_CI.read_text())
    for step in ci["jobs"]["builder"]["steps"]:
        run = step.get("run", "") or ""
        if "pytest" in run and "--cov" in run:
            return run
    raise AssertionError("no `pytest --cov` step in ci.yml `builder` job")


def test_makefile_and_ci_exist():
    assert _MAKEFILE.is_file(), _MAKEFILE
    assert _CI.is_file(), _CI


def test_local_runtime_http_checks_provision_the_same_dependencies_as_ci():
    # A successful image build must reach the HTTP contracts even when the
    # system Python lacks the test client's imports. CI provisions its own venv.
    steps = yaml.safe_load(_CI.read_text())["jobs"]["docker"]["steps"]
    command = next(
        step["run"]
        for step in steps
        if "builder/runtime_http_check.py" in step.get("run", "")
    )
    assert '"$RUNNER_TEMP/runtime-check/bin/pip" install httpx pyyaml' in command
    local = [
        line.strip()
        for line in _MAKEFILE.read_text().splitlines()
        if "builder/runtime_http_check.py" in line
    ]
    assert len(local) == 2  # standalone runtime and Compose docker gates
    for invocation in local:
        assert invocation.startswith(
            "uv run --no-project --python 3.12 --with httpx --with pyyaml python "
        )


def test_pre_commit_hooks_run_in_ci_and_local_gate():
    ci = yaml.safe_load(_CI.read_text())
    steps = ci["jobs"]["hooks"]["steps"]
    commands = "\n".join(step.get("run", "") for step in steps)
    command = "pre-commit run --all-files --show-diff-on-failure"
    assert command in commands
    assert "npm ci --legacy-peer-deps" in commands
    assert "pre-commit==3.6.2" in commands
    makefile = _MAKEFILE.read_text()
    assert command in makefile
    assert "uvx --from pre-commit==3.6.2" in makefile
    ci_target = next(line for line in makefile.splitlines() if line.startswith("ci:"))
    assert "hooks" in ci_target.split()


def test_rust_gates_keep_expensive_migration_contracts_manual():
    ci = yaml.safe_load(_CI.read_text())
    commands = "\n".join(step.get("run", "") for step in ci["jobs"]["rust"]["steps"])
    makefile = _MAKEFILE.read_text()
    ci_target = next(line for line in makefile.splitlines() if line.startswith("ci:"))
    prerequisites = ci_target.partition("##")[0].split()[1:]
    for target in ("rust-check", "rust-coverage"):
        assert target in commands and target in prerequisites
        assert f"{target}:" in makefile

    # BaseLoader preserves GitHub's `on` key instead of YAML 1.1's boolean True.
    migration = yaml.load(_MIGRATION.read_text(), Loader=yaml.BaseLoader)
    assert set(migration["on"]) == {"workflow_dispatch"}
    manual_commands = "\n".join(
        step.get("run", "") for step in migration["jobs"]["rust-migration"]["steps"]
    )
    automatic_commands = "\n".join(
        step.get("run", "")
        for job in ci["jobs"].values()
        for step in job.get("steps", [])
    )
    for target in ("migration", "candidate-browser"):
        assert f"make {target}" in manual_commands
        assert f"make {target}" not in automatic_commands
        assert target not in prerequisites
        assert f"{target}:" in makefile
    assert "--rollback-image $(MIGRATION_BASELINE_IMAGE)" in makefile
    assert "--compare-image $(MIGRATION_BASELINE_IMAGE)" in makefile
    assert "--redis-image $(MIGRATION_REDIS_IMAGE)" in makefile
    assert "--target rust-minimal" in makefile
    assert "E2E_CANDIDATE_IMAGE=$(RUNTIME_IMAGE)" in makefile
    assert "builder/migration/authorization_check.py" in makefile
    assert "--report $(MIGRATION_REPORT_DIR)/authorization.json" in makefile
    assert (
        "--locked --manifest-path builder/runtime/Cargo.toml --all-targets -- -D warnings"
        in makefile
    )


def test_makefile_builder_mirrors_ci_pytest_flags():
    make_flags = _pytest_flags(_makefile_builder_pytest_line())
    ci_flags = _pytest_flags(_ci_builder_pytest_command())
    assert make_flags == ci_flags, (
        "Makefile `builder` target and ci.yml `builder` job pytest flags differ:\n"
        f"  Makefile: {sorted(make_flags)}\n"
        f"  CI:       {sorted(ci_flags)}\n"
        "They must match — update both in the same commit (the Makefile mirrors CI)."
    )


def test_builder_ci_provisions_helm_before_rendered_chart_tests():
    # Rendered-chart regressions fail instead of skipping when CI is set, so
    # the job must install Helm rather than rely on the runner image.
    steps = yaml.safe_load(_CI.read_text())["jobs"]["builder"]["steps"]
    helm_steps = [
        index
        for index, step in enumerate(steps)
        if str(step.get("uses", "")).startswith("azure/setup-helm@")
    ]
    pytest_steps = [
        index
        for index, step in enumerate(steps)
        if "pytest" in (step.get("run", "") or "")
    ]
    assert helm_steps and pytest_steps
    assert max(helm_steps) < min(pytest_steps)
    conftest = (_REPO_ROOT / "builder" / "conftest.py").read_text()
    assert 'get_closest_marker("requires_helm")' in conftest
    assert "pytest.fail(" in conftest
    tools_line = next(
        line
        for line in _MAKEFILE.read_text().splitlines()
        if "for t in uv helm" in line
    )
    assert " helm " in tools_line


def test_python_coverage_measures_every_shipped_runtime_module():
    # `source` limits what coverage measures. A shipped module missing here
    # keeps its tests running but hides its coverage from the 65% floor.
    builder = _REPO_ROOT / "builder"
    shipped = set()
    for line in (builder / "Dockerfile").read_text().splitlines():
        parts = line.split()
        if len(parts) != 3 or parts[0] != "COPY" or parts[1].startswith("--"):
            continue
        source, destination = parts[1], parts[2]
        if "/" in source.rstrip("/") or destination != f"/workspace/{source}":
            continue
        path = builder / source
        if path.suffix == ".py" and not path.stem.endswith("_check"):
            shipped.add(path.stem)
        elif path.is_dir() and (path / "src").is_dir():
            shipped.add(f"{source}/src")
        elif path.is_dir() and any(path.glob("*.py")):
            shipped.add(source)
    assert {"memory_api", "daedalus_runtime", "llm_sandbox/src"} <= shipped

    sources = _coveragerc_list("source")
    assert shipped - sources == set()

    # `omit` can hide a shipped module just as silently, for example a
    # basename pattern matching smart_milvus/register.py.
    from fnmatch import fnmatchcase

    omit = _coveragerc_list("omit")
    assert omit, "expected the test and conftest exclusions"
    shipped_files = [
        path.relative_to(builder).as_posix()
        for entry in shipped
        for path in (
            (builder / entry).rglob("*.py")
            if (builder / entry).is_dir()
            else [builder / f"{entry}.py"]
        )
    ]
    assert "smart_milvus/src/smart_milvus/register.py" in shipped_files
    hidden = sorted(
        path
        for path in shipped_files
        if any(fnmatchcase(path, pattern) for pattern in omit)
    )
    assert hidden == []


def _coveragerc_list(option: str) -> set[str]:
    values, collecting = set(), False
    for line in (_REPO_ROOT / "builder" / ".coveragerc").read_text().splitlines():
        if line.strip() == f"{option} =":
            collecting = True
        elif collecting and line.startswith((" ", "\t")) and line.strip():
            values.add(line.strip())
        elif collecting and line.strip():
            collecting = False
    return values


def test_python_coverage_floor_and_real_redis_gate_are_enforced():
    # The parity check above only compares CI with the Makefile; it would
    # accept both dropping the floor. The integration job must also select the
    # real-Redis tests and enable them (conftest rejects -m integration without).
    import re

    floors = re.findall(r"--cov-fail-under=(\d+)", _ci_builder_pytest_command())
    assert floors and int(floors[0]) >= 65
    ci = yaml.safe_load(_CI.read_text())
    integration = [
        step
        for step in ci["jobs"]["builder-integration"]["steps"]
        if "pytest" in (step.get("run", "") or "")
    ]
    assert len(integration) == 1
    assert "-m integration" in integration[0]["run"]
    assert str(integration[0]["env"]["PYTEST_USE_REAL_REDIS"]) == "1"
    assert integration[0]["env"]["REDIS_URL"]
    recipe = _MAKEFILE.read_text().split("\ntest-integration:", 1)[1]
    recipe = recipe.split("\n\n", 1)[0]
    assert "PYTEST_USE_REAL_REDIS=1" in recipe
    assert "-m integration" in recipe


def test_frontend_coverage_measures_every_server_runtime_module():
    # Vitest only instruments coverage.include. Server modules outside it
    # (job admission, atomic writers, workers) would look green when untested.
    import re
    from fnmatch import fnmatchcase

    config = (_REPO_ROOT / "frontend" / "vitest.config.ts").read_text()
    include_block = re.search(
        r"include:\s*\[(.*?)\]", config.split("coverage:")[1], re.S
    )
    assert include_block
    patterns = re.findall(r"'([^']+)'", include_block.group(1))

    def included(relative: str) -> bool:
        return any(
            fnmatchcase(relative, pattern)
            or fnmatchcase(relative, pattern.replace("**/", ""))
            for pattern in patterns
        )

    frontend = _REPO_ROOT / "frontend"
    modules = [
        path.relative_to(frontend).as_posix()
        for directory in ("server", "state")
        for path in (frontend / directory).rglob("*.ts")
        if not path.name.endswith((".d.ts", ".test.ts"))
    ] + ["stream-worker.ts", "ws-server.ts"]
    assert len(modules) > 10
    assert [module for module in modules if not included(module)] == []


def test_compose_redis_gate_targets_the_redis_image_in_ci_and_local_gate():
    # The local recipe previously reused the last value of a scan loop.
    gate = next(
        line.strip()
        for line in _MAKEFILE.read_text().splitlines()
        if "scripts/test_compose_redis.py" in line
    )
    assert ".services.redis.image" in gate
    assert '"$$image"' not in gate
    steps = yaml.safe_load(_CI.read_text())["jobs"]["docker"]["steps"]
    ci_gate = next(
        step["run"]
        for step in steps
        if "scripts/test_compose_redis.py" in (step.get("run", "") or "")
    )
    assert ci_gate.endswith(":redis-0.1.0")


def test_bandit_production_scan_fails_closed_in_ci_and_local_gate():
    # GitHub's default `bash -e` has no pipefail: a missing filter executable
    # or an empty list with `xargs -r` previously exited 0 without scanning.
    steps = yaml.safe_load(_CI.read_text())["jobs"]["security"]["steps"]
    ci = next(step for step in steps if step.get("name") == "Python security analysis")
    makefile = _MAKEFILE.read_text()
    recipe = makefile[makefile.index("\nsecurity:") : makefile.index("\ntools-check:")]
    for command in (ci["run"], recipe):
        assert "grep -Ev '(^|/)tests/'" in command
        assert "xargs -r" not in command and "rg -v" not in command
        assert "bandit==1.8.6" in command and "-ll -c pyproject.toml" in command
    assert ci["shell"] == "bash"
    assert 'test -n "$files"' in ci["run"]
    assert "set -euo pipefail" in recipe and 'test -n "$$files"' in recipe


def test_playwright_installs_webkit_for_ci_and_local_gate():
    ci = yaml.safe_load(_CI.read_text())
    browser_install = next(
        step["run"]
        for step in ci["jobs"]["frontend-e2e"]["steps"]
        if step.get("name") == "Install pinned browser runtimes"
    )
    makefile = _MAKEFILE.read_text()

    assert browser_install == "npx playwright install --with-deps chromium webkit"
    assert "npx playwright install chromium webkit" in makefile


def test_trivy_fails_ci_and_local_gate_on_high_or_critical_findings():
    ci = yaml.safe_load(_CI.read_text())
    security_steps = ci["jobs"]["security"]["steps"]
    trivy_step = next(
        step
        for step in security_steps
        if str(step.get("uses", "")).startswith("aquasecurity/trivy-action@")
        and step["with"].get("scan-ref") == "."
    )
    upload_step = next(
        step
        for step in security_steps
        if str(step.get("uses", "")).startswith("github/codeql-action/upload-sarif@")
    )
    makefile = _MAKEFILE.read_text()

    assert trivy_step["with"]["severity"] == "CRITICAL,HIGH"
    assert str(trivy_step["with"]["exit-code"]) == "1"
    assert "always()" in upload_step["if"]
    assert (
        "$(TRIVY) fs --scanners vuln --severity CRITICAL,HIGH --exit-code 1 "
        "--format sarif" in makefile
    )
    assert (
        "$(TRIVY) fs --scanners vuln --list-all-pkgs --format json "
        "frontend/package-lock.json" in makefile
    )
    assert 'endswith("package-lock.json")' in makefile
    # CI carries the same lockfile-inventory guard before the clean scan.
    inventory = next(
        step
        for step in security_steps
        if str(step.get("uses", "")).startswith("aquasecurity/trivy-action@")
        and step["with"].get("scan-ref") == "frontend/package-lock.json"
    )
    assert str(inventory["with"]["list-all-pkgs"]) == "true"
    assert inventory["with"]["format"] == "json"
    verify = next(
        step
        for step in security_steps
        if step.get("name") == "Verify the lockfile inventory"
    )
    assert 'endswith("package-lock.json")' in verify["run"]
    assert inventory["with"]["output"] in verify["run"]
    assert security_steps.index(verify) < security_steps.index(trivy_step)


def test_trivy_image_secret_exception_is_limited_to_oci_sdk_example_files():
    ci = yaml.safe_load(_CI.read_text())
    docker_steps = ci["jobs"]["docker"]["steps"]
    trivy_steps = {
        step["name"]: step
        for step in docker_steps
        if str(step.get("uses", "")).startswith("aquasecurity/trivy-action@")
    }
    expected = {
        "/workspace/.venv/lib/python3.12/site-packages/oci/golden_gate/models/"
        "create_azure_data_lake_storage_connection_details.py",
        "/workspace/.venv/lib/python3.12/site-packages/oci/golden_gate/models/"
        "update_azure_data_lake_storage_connection_details.py",
    }

    backend_skip_files = set(
        trivy_steps["Scan backend image"]["with"]["skip-files"].split(",")
    )
    assert backend_skip_files == expected
    release = yaml.safe_load(_RELEASE.read_text())
    release_steps = {
        step["name"]: step
        for step in release["jobs"]["release-images"]["steps"]
        if str(step.get("uses", "")).startswith("aquasecurity/trivy-action@")
    }
    assert (
        set(release_steps["Scan backend image"]["with"]["skip-files"].split(","))
        == expected
    )
    for name in ("Scan backend image", "Scan frontend image", "Scan Redis image"):
        assert release_steps[name]["with"]["severity"] == "CRITICAL,HIGH"
        assert str(release_steps[name]["with"]["exit-code"]) == "1"
    for name in ("Scan frontend image", "Scan Redis image"):
        assert "skip-files" not in release_steps[name]["with"]
    assert "skip-files" not in trivy_steps["Scan frontend image"]["with"]
    assert "skip-files" not in trivy_steps["Scan Redis image"]["with"]

    makefile = _MAKEFILE.read_text()
    for path in expected:
        assert path in makefile
    assert '--skip-files "$(TRIVY_OCI_SAS_EXAMPLE_SKIP_FILES)"' in makefile


def test_production_javascript_audit_uses_same_fail_closed_policy_in_ci_and_local_gate():
    ci = yaml.safe_load(_CI.read_text())
    security_steps = ci["jobs"]["security"]["steps"]
    setup_node = next(
        step
        for step in security_steps
        if str(step.get("uses", "")).startswith("actions/setup-node@")
    )
    audit_command = next(
        step["run"]
        for step in security_steps
        if step.get("name") == "Audit production JavaScript dependencies"
    )
    expected = "npm run audit:production"

    assert setup_node["with"]["node-version"] == "22"
    assert setup_node["with"]["cache-dependency-path"] == "frontend/package-lock.json"
    assert audit_command == expected
    assert f"cd frontend && {expected}" in _MAKEFILE.read_text()

    package = json.loads(_FRONTEND_PACKAGE.read_text())
    assert package["scripts"]["audit:production"] == (
        "node scripts/check-production-audit.mjs"
    )
    audit_policy = (
        _REPO_ROOT / "frontend/scripts/check-production-audit.mjs"
    ).read_text()
    assert "--omit=dev" in audit_policy
    assert "--audit-level=moderate" in audit_policy
    assert "--package-lock-only" in audit_policy
    assert "fixAvailable !== false" in audit_policy


def test_ci_oidc_permissions_are_limited_to_main_branch_attestations():
    ci = yaml.safe_load(_CI.read_text())
    assert ci["permissions"] == {"contents": "read"}

    docker = ci["jobs"]["docker"]
    assert docker["permissions"] == {"contents": "read"}
    assert set(docker["outputs"]) == {
        "backend-digest",
        "frontend-digest",
        "redis-digest",
    }

    attest = ci["jobs"]["docker-attest"]
    assert attest["needs"] == "docker"
    assert "github.event_name == 'push'" in attest["if"]
    assert "github.ref == 'refs/heads/main'" in attest["if"]
    assert attest["permissions"] == {
        "contents": "read",
        "id-token": "write",
        "attestations": "write",
    }
    assert (
        len(
            [
                step
                for step in attest["steps"]
                if str(step.get("uses", "")).startswith("actions/attest@")
            ]
        )
        == 3
    )


def test_release_workflow_grants_elevated_permissions_only_to_release_job():
    release = yaml.safe_load(_RELEASE.read_text())
    assert release["permissions"] == {"contents": "read"}
    assert release["jobs"]["verify-ci"]["permissions"] == {
        "actions": "read",
        "contents": "read",
    }
    assert release["jobs"]["release-images"]["permissions"] == {
        "actions": "read",
        "contents": "read",
        "packages": "write",
        "id-token": "write",
        "attestations": "write",
    }


def test_frontend_forces_a_security_fixed_postcss_for_next_runtime():
    package = json.loads(_FRONTEND_PACKAGE.read_text())
    lock = json.loads(_FRONTEND_LOCK.read_text())

    assert package["devDependencies"]["postcss"] == "^8.5.23"
    assert package["overrides"]["postcss"] == "$postcss"
    assert "node_modules/next/node_modules/postcss" not in lock["packages"]

    version = lock["packages"]["node_modules/postcss"]["version"]
    assert tuple(int(part) for part in version.split(".")[:3]) >= (8, 5, 23)


def test_frontend_pins_the_fixed_mermaid_sanitization_graph():
    package = json.loads(_FRONTEND_PACKAGE.read_text())
    lock = json.loads(_FRONTEND_LOCK.read_text())

    assert package["dependencies"]["mermaid"] == "11.16.1"
    assert package["overrides"]["@mermaid-js/parser"] == "1.1.0"
    assert package["overrides"]["dompurify"] == "^3.4.13"

    versions = {
        name: lock["packages"][f"node_modules/{name}"]["version"]
        for name in ("mermaid", "dompurify")
    }
    assert versions["mermaid"] == "11.16.1"
    assert tuple(int(part) for part in versions["dompurify"].split(".")) >= (
        3,
        4,
        13,
    )
