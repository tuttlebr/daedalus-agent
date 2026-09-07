#!/usr/bin/env python3
"""Check local Markdown resource and cross-skill links without network access."""

import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def local_links(path):
    text = re.sub(r"^(```|~~~).*?^\1[^\n]*$", "", path.read_text(), flags=re.M | re.S)
    for target in re.findall(r"\]\(([^\n)]+)\)", text):
        target = target.strip().split(' "', 1)[0].strip("<>")
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or target.startswith("/"):
            continue
        yield (path.parent / unquote(parsed.path)).resolve(), unquote(parsed.fragment)


def check(root=ROOT / "skills"):
    errors = []
    for source in sorted(root.rglob("*.md")):
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


if __name__ == "__main__":
    failures = check()
    for failure in failures:
        print(failure)
    if not failures:
        print("All local skill links resolve.")
    raise SystemExit(bool(failures))
