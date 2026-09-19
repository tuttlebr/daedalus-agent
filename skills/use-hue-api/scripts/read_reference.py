"""Read the skill's bundled Hue API contracts locally; never contact a bridge."""

import argparse
import json
from pathlib import Path

DEFAULT_SOURCE = Path(__file__).resolve().parents[1] / "references/api-reference.json"


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("Use a positive integer.")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=DEFAULT_SOURCE, help="Compact JSON reference"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser(
        "list", help="List operation anchors, methods, and paths"
    )
    listing.add_argument("filter", nargs="?", default="")
    showing = commands.add_parser(
        "show", help="Read one operation's request, response, or security"
    )
    showing.add_argument("anchor", help="Operation anchor from list, without a #")
    showing.add_argument(
        "--part", choices=["request", "response", "securedby", "all"], default="request"
    )
    showing.add_argument("--start-line", type=positive, default=1)
    showing.add_argument("--lines", type=positive, default=100)
    args = parser.parse_args()
    try:
        document = json.loads(args.source.read_text(encoding="utf-8"))
        if document["format_version"] != 1:
            raise ValueError("Unsupported reference format; expected version 1.")
        operations = {op["anchor"]: op for op in document["operations"]}
        if args.command == "list":
            for anchor, op in operations.items():
                label = f"{op['method']} {op['path']}"
                if args.filter.lower() in (anchor + " " + label).lower():
                    print(f"{anchor}\t{label}")
            return
        if args.anchor not in operations:
            raise ValueError(
                "Unknown operation anchor. Use list to find a documented operation."
            )
        operation = operations[args.anchor]
        sections = operation["sections"]
        if args.part == "all":
            content = "\n\n".join(
                f"## {part}\n{sections[part]}"
                for part in ("request", "response", "securedby")
                if part in sections
            )
        elif args.part in sections:
            content = sections[args.part]
        else:
            raise ValueError(
                "This operation has no documentation for the selected part. "
                "For collection GETs, try --part response."
            )
        lines = content.splitlines()
        start = args.start_line - 1
        if start >= len(lines) and lines:
            raise ValueError(f"The section has only {len(lines)} text lines.")
        end = min(start + args.lines, len(lines))
        print(f"Source: {args.source}; operation: {args.anchor}; part: {args.part}")
        print(f"{operation['method']} {operation['path']}")
        print(f"Text lines {start + 1 if lines else 0}-{end} of {len(lines)}:")
        for index in range(start, end):
            print(f"{index + 1:4}: {lines[index]}")
        if end < len(lines):
            print(f"More content remains; continue with --start-line {end + 1}.")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
