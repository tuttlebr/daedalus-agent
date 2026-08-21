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


def test_makefile_builder_mirrors_ci_pytest_flags():
    make_flags = _pytest_flags(_makefile_builder_pytest_line())
    ci_flags = _pytest_flags(_ci_builder_pytest_command())
    assert make_flags == ci_flags, (
        "Makefile `builder` target and ci.yml `builder` job pytest flags differ:\n"
        f"  Makefile: {sorted(make_flags)}\n"
        f"  CI:       {sorted(ci_flags)}\n"
        "They must match — update both in the same commit (the Makefile mirrors CI)."
    )


def test_trivy_fails_ci_and_local_gate_on_high_or_critical_findings():
    ci = yaml.safe_load(_CI.read_text())
    security_steps = ci["jobs"]["security"]["steps"]
    trivy_step = next(
        step
        for step in security_steps
        if str(step.get("uses", "")).startswith("aquasecurity/trivy-action@")
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

    assert package["devDependencies"]["postcss"] == "^8.5.10"
    assert package["overrides"]["postcss"] == "$postcss"
    assert "node_modules/next/node_modules/postcss" not in lock["packages"]

    version = lock["packages"]["node_modules/postcss"]["version"]
    assert tuple(int(part) for part in version.split(".")[:3]) >= (8, 5, 10)
