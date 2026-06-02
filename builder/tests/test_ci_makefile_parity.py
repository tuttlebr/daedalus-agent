"""F-008: enforce that the local `make builder` gate mirrors the CI builder job.

The Makefile header promises it mirrors `.github/workflows/ci.yml`, but nothing
enforced it — a new pytest flag added to CI (e.g. `--cov-fail-under=50`) without
updating the Makefile would pass `make builder` locally yet fail in CI (or the
reverse). This test parses the pytest invocation from the Makefile `builder`
target and the ci.yml `builder` job and asserts their flag sets are identical, so
drift fails fast in the unit suite itself.
"""

from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MAKEFILE = _REPO_ROOT / "Makefile"
_CI = _REPO_ROOT / ".github" / "workflows" / "ci.yml"


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
