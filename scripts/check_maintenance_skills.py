#!/usr/bin/env python3
"""Check that maintenance skills name repository paths and Make targets that exist.

Skills under .agents/skills/ describe this repository for coding agents. Renaming
a file or target anywhere can strand their references, so the hook always runs.
It checks existence only; outdated descriptions still need review.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ".agents/skills"
# Placeholders, URLs and home or absolute paths are not repository paths.
NOT_A_PATH = re.compile(r"[<>${}~]|://|^/")
# Root files such as `Makefile` or `pyproject.toml` have no directory part.
FILE_NAME = re.compile(r"^(?:Makefile|Dockerfile|\.?[\w-]+(?:\.[\w-]+)*\.[A-Za-z]\w*)$")
# Make options such as -j4 and VAR=value assignments are not targets.
TARGET = re.compile(r"^\w[\w.-]*$")


def make_targets(makefile):
    return set(re.findall(r"^([\w.-]+)\s*:(?!=)", makefile.read_text(), re.M))


def references(text):
    text = re.sub(r"^(```|~~~).*?^\1[^\n]*$", "", text, flags=re.M | re.S)
    for span in re.findall(r"`([^`\n]+)`", text):
        words = span.split()
        if not words:
            continue
        if words[0] == "make":
            yield "target", [word for word in words[1:] if TARGET.match(word)]
        elif (
            len(words) == 1
            and ("/" in span or FILE_NAME.match(span))
            and not NOT_A_PATH.search(span)
        ):
            yield "path", span


def resolves(path, skill, root):
    # Skill files are named relative to the skill; everything else to the root.
    for base in (skill, root):
        if any(char in path for char in "*?["):
            if any(base.glob(path.rstrip("/"))):
                return True
        elif (base / path).exists():
            return True
    return False


def check(root=ROOT):
    errors = []
    targets = make_targets(root / "Makefile")
    for skill in sorted(path for path in (root / SKILLS).iterdir() if path.is_dir()):
        entry = skill / "SKILL.md"
        if not entry.is_file():
            errors.append(f"{skill.relative_to(root)}: missing SKILL.md")
            continue
        name = re.search(r"\A---\n(?:.*\n)*?name:\s*(\S+)\s*\n", entry.read_text())
        if not name or name.group(1) != skill.name:
            errors.append(f"{entry.relative_to(root)}: name must be {skill.name}")
        for source in sorted(skill.rglob("*.md")):
            missing = []
            for kind, value in references(source.read_text()):
                if kind == "path" and not resolves(value, skill, root):
                    missing.append(f"missing path {value}")
                elif kind == "target":
                    missing += [
                        f"missing make target {t}" for t in value if t not in targets
                    ]
            label = source.relative_to(root)
            errors += [f"{label}: {problem}" for problem in dict.fromkeys(missing)]
    return errors


if __name__ == "__main__":
    failures = check()
    for failure in failures:
        print(failure)
    if failures:
        print("Update the maintenance skill to match the repository (see AGENTS.md).")
    else:
        print("All maintenance skill references resolve.")
    raise SystemExit(bool(failures))
