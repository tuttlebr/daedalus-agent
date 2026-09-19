"""Import an authorized RAML HTML export into the skill's compact Hue reference.

This optional maintenance command never fetches documentation or contacts a bridge.
"""

import argparse
import hashlib
import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

OUTPUT = Path(__file__).resolve().parents[1] / "references/api-reference.json"
MODAL = re.compile(r'<div\b[^>]*class="modal fade"[^>]*\bid="([^\"]+)"[^>]*>')
DIV = re.compile(r"</?div\b[^>]*>", re.IGNORECASE)
VOID = {
    "br",
    "hr",
    "img",
    "input",
    "meta",
    "link",
    "source",
    "wbr",
    "area",
    "base",
    "embed",
}


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines = []
        self.current = []
        self.depth = 0
        self.indent = 0
        self.pre = False

    def flush(self):
        line = "".join(self.current).strip()
        if line:
            self.lines.append("  " * self.indent + line)
        self.current = []
        self.indent = self.depth

    def handle_starttag(self, tag, attrs):
        if tag in {"p", "div", "li", "ul", "ol", "pre", "br", "h1", "h2", "h3", "h4"}:
            self.flush()
        if tag in {"ul", "ol"}:
            self.depth += 1
            self.indent = self.depth
        if tag == "li":
            self.current.append("- ")
        if tag in {"h1", "h2", "h3", "h4"}:
            self.current.append("#" * int(tag[1]) + " ")
        if tag == "pre":
            self.pre = True

    def handle_endtag(self, tag):
        if tag in {"p", "div", "li", "ul", "ol", "pre", "h1", "h2", "h3", "h4"}:
            self.flush()
        if tag in {"ul", "ol"}:
            self.depth = max(0, self.depth - 1)
            self.indent = self.depth
        if tag == "pre":
            self.pre = False

    def handle_data(self, data):
        if self.pre:
            self.current.append(data)
        elif data.strip():
            self.current.append(" ".join(data.split()) + " ")


def render(fragment):
    parser = Text()
    parser.feed(fragment)
    parser.close()
    parser.flush()
    return "\n".join(parser.lines)


def extract(source, start):
    depth = 0
    for match in DIV.finditer(source, start):
        depth += -1 if match.group().startswith("</") else 1
        if depth == 0:
            return source[start : match.end()]
    raise ValueError("The selected documentation section has no closing div.")


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)

    def text(self):
        return " ".join(
            "".join(
                c.text() if isinstance(c, Node) else c for c in self.children
            ).split()
        )

    def elements(self, tag=None):
        return [
            c
            for c in self.children
            if isinstance(c, Node) and (tag is None or c.tag == tag)
        ]

    def find(self, **attrs):
        if all(self.attrs.get(k) == v for k, v in attrs.items()):
            return self
        return next(
            (found for c in self.elements() if (found := c.find(**attrs))), None
        )


class Tree(HTMLParser):
    def __init__(self, fragment):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]
        self.feed(fragment)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def children_schema(container, location):
    lists = container.elements("ul")
    if not lists or not lists[0].elements("li"):
        return {"type": "object", "additionalProperties": True}
    properties, required = {}, []
    for li in lists[0].elements("li"):
        strong, em = li.elements("strong"), li.elements("em")
        if not strong or not em:
            raise ValueError(f"Unrecognized property at {location}")
        name = strong[0].text()
        annotation = em[0].text()
        mandatory = any(c.attrs.get("class") == "required" for c in em[0].elements())
        expression = annotation.removeprefix("required").strip()
        if not expression.startswith("(") or not expression.endswith(")"):
            raise ValueError(f"Unrecognized type for {location}.{name}: {expression}")
        properties[name] = type_schema(expression[1:-1], li, f"{location}.{name}")
        descriptions = []
        for paragraph in li.elements("p"):
            if paragraph.elements("strong"):
                continue
            if text := paragraph.text():
                descriptions.append(text)
        if descriptions:
            properties[name]["description"] = " ".join(descriptions)
        if mandatory:
            required.append(name)
    schema = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = required
    return schema


def type_schema(expression, container, location):
    kind, *bounds = expression.split(" – ")
    if kind == "object":
        schema = children_schema(container, location)
    elif kind.startswith("array of "):
        item_type = kind.removeprefix("array of ")
        items = next(
            (c for c in container.elements("div") if c.attrs.get("class") == "items"),
            None,
        )
        if items is not None and items.elements("ul"):
            item_schema = children_schema(items, location + "[]")
        elif item_type in {"string", "number", "integer", "boolean"}:
            item_schema = {"type": item_type}
        elif item_type == "WeekDay":
            # Expanded in the same reference's smart-scene week_timeslots response.
            item_schema = {
                "type": "string",
                "enum": [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                ],
            }
        elif item_type == "SearchCode":
            # The supplied HTML names but never expands this alias. Preserve the
            # documented array option without inventing item constraints.
            item_schema = {
                "description": (
                    "Hue SearchCode; item schema is not expanded in the supplied reference "
                    "and is validated by the bridge."
                )
            }
        else:
            enum = next(
                (
                    p.text().removeprefix("Enum:").strip()
                    for p in (items or container).elements("p")
                    if p.text().startswith("Enum:")
                ),
                None,
            )
            if not enum:
                raise ValueError(f"Unresolved array item {item_type} at {location}")
            item_schema = {
                "type": "string",
                "enum": [v.strip() for v in enum.split(",")],
            }
        schema = {"type": "array", "items": item_schema}
    elif kind.startswith("one of "):
        schema = {"type": "string", "enum": kind.removeprefix("one of ").split(", ")}
    elif kind in {"string", "number", "integer", "boolean"}:
        schema = {"type": kind}
    elif re.fullmatch(r"[a-z][a-z0-9_]*", kind):
        schema = {"type": "string", "const": kind}
    else:
        raise ValueError(f"Unresolved type {kind} at {location}")
    for bound in bounds:
        key, value = bound.split(": ", 1)
        if key in {
            "minimum",
            "maximum",
            "minItems",
            "maxItems",
            "minLength",
            "maxLength",
        }:
            schema[key] = float(value) if "." in value else int(value)
        elif key == "pattern":
            schema[key] = value
        elif key == "default":
            schema[key] = json.loads(value) if schema["type"] != "string" else value
        else:
            raise ValueError(f"Unknown constraint {key} at {location}")
    return schema


def compile_reference(source):
    operations = {}
    copies = {}
    for match in MODAL.finditer(source):
        anchor = match[1]
        fragment = extract(source, match.start())
        tree = Tree(fragment).root
        title = tree.find(**{"class": "modal-title"}).text()
        method, path = title.split(maxsplit=1)
        method, path = method.upper(), "".join(path.split())
        sections = {}
        for part in ("request", "response", "securedby"):
            section = re.search(
                r'<div\b[^>]*\bid="' + re.escape(anchor + "_" + part) + '"', fragment
            )
            if section:
                sections[part] = render(extract(fragment, section.start()))
        if "response" not in sections or "securedby" not in sections:
            raise ValueError(f"Missing response or security documentation for {anchor}")
        operation = {
            "anchor": anchor,
            "method": method,
            "path": path,
            "sections": sections,
        }
        if method in {"PUT", "POST"}:
            request = tree.find(id=anchor + "_request")
            if request is None:
                raise ValueError(f"Missing write contract for {anchor}")
            elements = request.elements()
            body_index = next(
                i
                for i, c in enumerate(elements)
                if c.tag == "h3" and c.text() == "Body"
            )
            body = Node("body", children=elements[body_index + 1 :])
            body_type = next(
                c.text().removeprefix("Type:").strip()
                for c in body.elements("p")
                if c.text().startswith("Type:")
            )
            operation["body_schema"] = type_schema(body_type, body, anchor)
        if anchor in operations and operations[anchor] != operation:
            raise ValueError(
                f"Conflicting repeated operation documentation for {anchor}"
            )
        operations[anchor] = operation
        copies[anchor] = copies.get(anchor, 0) + 1
    if not operations:
        raise ValueError("No Hue operations found in the supplied HTML export.")
    return {
        "format_version": 1,
        "source": {
            "title": "Hue CLIP API resource reference",
            "sha256": hashlib.sha256(source.encode()).hexdigest(),
            "copies_per_operation": copies,
        },
        "operations": list(operations.values()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", type=Path, help="Authorized RAML HTML export to import"
    )
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    try:
        document = compile_reference(args.source.read_text(encoding="utf-8"))
        content = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    except (OSError, ValueError) as exc:
        parser.exit(1, f"{exc}\n")
    print(f"Wrote {len(document['operations'])} operations to {args.output}")


if __name__ == "__main__":
    main()
