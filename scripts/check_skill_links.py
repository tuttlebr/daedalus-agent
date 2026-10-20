#!/usr/bin/env python3
"""Check local Markdown resource and cross-skill links without network access."""

import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")


def prose(text):
    """Return Markdown outside fenced blocks (including indented list fences)
    and inline code, where link syntax is only an example."""
    lines, fence = [], None
    for line in text.splitlines():
        stripped = line.strip()
        if fence:
            if set(stripped) == {fence[0]} and len(stripped) >= len(fence):
                fence = None
            continue
        match = FENCE.match(line)
        if match:
            fence = match.group(1)
            continue
        lines.append(re.sub(r"(`+).+?\1", "", line))
    return "\n".join(lines)


def local_links(path):
    for target in re.findall(r"\]\(([^\n)]+)\)", prose(path.read_text())):
        target = target.strip().split(' "', 1)[0].strip("<>")
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or target.startswith("/"):
            continue
        # A bare #fragment names a heading in the linking file itself.
        resolved = path.parent / unquote(parsed.path) if parsed.path else path
        yield resolved.resolve(), unquote(parsed.fragment)


def skill_directory(path):
    """The skill root a resource path is relative to: the nearest ancestor
    holding SKILL.md, or the file's own directory."""
    for directory in [path.parent, *path.parents]:
        if (directory / "SKILL.md").is_file():
            return directory
    return path.parent


def resource_references(path):
    """Resources named in prose for `load_skill(... resource=<path>)` calls.

    The loader resolves them against the skill directory; a renamed file would
    otherwise fail only at run time, inside the model's tool call."""
    root = skill_directory(path)
    for target in re.findall(r"\bresource=([^\s`'\")\],]+)", prose(path.read_text())):
        target = target.strip().rstrip(".")
        if not target or any(marker in target for marker in "<>{}$"):
            continue
        yield (root / target).resolve()


def check(root=ROOT / "skills"):
    errors = []
    for source in sorted(root.rglob("*.md")):
        for resource in resource_references(source):
            if not resource.exists():
                errors.append(
                    f"{source.relative_to(ROOT)}: missing resource {resource}"
                )
        for target, anchor in local_links(source):
            if not target.is_file():
                errors.append(
                    f"{source.relative_to(ROOT)}: missing local file {target}"
                )
            elif anchor and target.suffix == ".md":
                headings = re.findall(r"^#{1,6}\s+(.+)$", target.read_text(), re.M)
                slugs = {
                    re.sub(r"[^\w\- ]", "", h.lower()).replace(" ", "-")
                    for h in headings
                }
                if anchor not in slugs and f'id="{anchor}"' not in target.read_text():
                    errors.append(
                        f"{source.relative_to(ROOT)}: missing anchor {target.name}#{anchor}"
                    )
    return errors


def main():
    # Runtime skills and repository maintenance skills share link conventions.
    failures = check(ROOT / "skills") + check(ROOT / ".agents/skills")
    for failure in failures:
        print(failure)
    if not failures:
        print("All local skill links resolve.")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
