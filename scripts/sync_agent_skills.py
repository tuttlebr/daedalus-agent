#!/usr/bin/env python3
"""Keep repository skills in .agents/skills visible to every coding-agent harness.

.agents/skills is the single source of truth and is tracked. Harnesses that read
it directly (Codex, Pi, OpenCode) need nothing. Claude Code only reads
.claude/skills, which stays git-ignored, so each skill is symlinked there. The
links are relative, so they survive moving the checkout.

    python3 scripts/sync_agent_skills.py          # create, repair and prune links
    python3 scripts/sync_agent_skills.py --check  # fail when links are out of sync

Hermes has no project-local skills directory; see docs or AGENTS.md for its
`skills.external_dirs` setting. Same-named personal copies shadow or duplicate
the repository skill, so they are reported as warnings.
"""

import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(".agents/skills")
# Directories that only a link mirror can serve; the rest read SOURCE directly.
MIRRORS = (Path(".claude/skills"),)
# Per-user locations that can hold a stale copy of a repository skill.
PERSONAL = (Path(".claude/skills"), Path(".codex/skills"), Path(".agents/skills"))


def skill_names(root):
    source = root / SOURCE
    return sorted(p.name for p in source.iterdir() if (p / "SKILL.md").is_file())


def sync(root=ROOT, fix=True):
    """Return problems found; repair them when fix is true."""
    problems = []
    names = skill_names(root)
    for mirror in MIRRORS:
        directory = root / mirror
        # A fresh clone has no ignored .claude/; only a check run may skip it.
        if not directory.exists() and not fix:
            continue
        if fix:
            directory.mkdir(parents=True, exist_ok=True)
        for name in names:
            link = directory / name
            want = Path(os.path.relpath(SOURCE / name, mirror))
            if link.is_symlink() and Path(os.readlink(link)) == want:
                continue
            if link.exists() and not link.is_symlink():
                problems.append(f"{mirror / name}: real directory shadows the skill")
                continue
            problems.append(f"{mirror / name}: missing or wrong link")
            if fix:
                if link.is_symlink():
                    link.unlink()
                link.symlink_to(want)
        for link in sorted(directory.iterdir()) if directory.exists() else ():
            if link.is_symlink() and link.name not in names:
                # Only links into this repository's skills are ours to prune;
                # personal links in the same directory are left alone.
                target = Path(os.path.normpath(directory / os.readlink(link)))
                if target.parent == Path(os.path.normpath(root / SOURCE)):
                    problems.append(f"{mirror / link.name}: stale link")
                    if fix:
                        link.unlink()
    return problems


def personal_copies(root=ROOT, home=None):
    home = home or Path.home()
    return [
        str(home / base / name)
        for name in skill_names(root)
        for base in PERSONAL
        if (home / base / name).exists()
        and (home / base / name).resolve().parent != (root / SOURCE).resolve()
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--check", action="store_true", help="report only; do not change anything"
    )
    args = parser.parse_args()
    for path in personal_copies():
        print(
            f"warning: personal copy shadows or duplicates the repository skill: {path}"
        )
    problems = sync(fix=not args.check)
    for problem in problems:
        print(problem)
    if problems and args.check:
        print("Run `python3 scripts/sync_agent_skills.py` to relink agent skills.")
        return 1
    print(
        "Agent skills are synchronized."
        if not problems
        else f"Repaired {len(problems)} skill link(s)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
