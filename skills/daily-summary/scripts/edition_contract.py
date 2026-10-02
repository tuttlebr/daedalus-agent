"""Canonical edition schema and aggregate structural checks using only stdlib.

This is deliberately a validator for the keyword subset used by the bundled
schema, not a general JSON Schema implementation. Unsupported schema keywords
fail closed. Rendering retains the separate semantic and source-policy gates.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

_KEYWORDS = {
    "$schema",
    "$defs",
    "$ref",
    "title",
    "description",
    "type",
    "enum",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "anyOf",
}
_TYPES = {"object": dict, "array": list, "string": str, "null": type(None)}
_MAX_ERRORS = 100
_MAX_ERROR_JSON_BYTES = 500


def _bounded_message(message: str) -> str:
    """Keep escaped diagnostics within the subprocess's output budget."""
    if len(json.dumps(message)) <= _MAX_ERROR_JSON_BYTES:
        return message
    suffix = " ... [truncated]"
    low, high = 0, len(message)
    while low < high:
        middle = (low + high + 1) // 2
        if len(json.dumps(message[:middle] + suffix)) <= _MAX_ERROR_JSON_BYTES:
            low = middle
        else:
            high = middle - 1
    return message[:low] + suffix


class ValidationErrors(list[str]):
    """Bound displayed diagnostics while retaining the exact error count."""

    def __init__(self, errors: Iterable[str] = ()) -> None:
        super().__init__()
        self.error_count = 0
        self.errors_truncated = False
        self.extend(errors)

    def append(self, error: str) -> None:
        self.error_count += 1
        if len(self) >= _MAX_ERRORS:
            self.errors_truncated = True
            return
        bounded = _bounded_message(error)
        self.errors_truncated |= bounded != error
        super().append(bounded)

    def extend(self, errors: Iterable[str]) -> None:
        count = 0
        for error in errors:
            self.append(error)
            count += 1
        self.error_count += max(0, getattr(errors, "error_count", count) - count)
        self.errors_truncated |= getattr(errors, "errors_truncated", False)


def load_schema(schema_path: Path | str | None = None) -> dict[str, Any]:
    if schema_path is None:
        directory = Path(__file__).resolve().parent
        staged = directory / "edition-schema.json"
        schema_path = (
            staged
            if staged.exists()
            else directory.parent / "references" / "edition-schema.json"
        )
    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    _check_schema(schema)
    return schema


def _check_schema(schema: Any) -> None:
    if not isinstance(schema, dict):
        raise ValueError("Edition schema nodes must be objects")
    unknown = set(schema) - _KEYWORDS
    if unknown:
        raise ValueError(f"Unsupported edition schema keywords: {sorted(unknown)}")
    if "type" in schema and (
        not isinstance(schema["type"], str) or schema["type"] not in _TYPES
    ):
        raise ValueError("Unsupported edition schema type")
    if "additionalProperties" in schema and schema["additionalProperties"] is not False:
        raise ValueError("Edition object schemas must reject additional properties")
    if "$ref" in schema and (
        not isinstance(schema["$ref"], str)
        or not schema["$ref"].startswith("#/$defs/")
        or set(schema) - {"$ref", "title", "description"}
    ):
        raise ValueError("Edition schema references must be local definitions")
    for keyword in ("minItems", "maxItems"):
        if keyword in schema and (
            type(schema[keyword]) is not int or schema[keyword] < 0
        ):
            raise ValueError("Edition array bounds must be nonnegative integers")
    if schema.get("minItems", 0) > schema.get("maxItems", float("inf")):
        raise ValueError("Edition array bounds are inconsistent")
    if "enum" in schema and (
        not isinstance(schema["enum"], list)
        or not schema["enum"]
        or any(not isinstance(value, str) for value in schema["enum"])
    ):
        raise ValueError("Edition enum values must be nonempty lists of strings")
    for keyword in ("properties", "$defs"):
        if keyword in schema:
            if not isinstance(schema[keyword], dict):
                raise ValueError(f"Edition schema {keyword} must be an object")
            for child in schema[keyword].values():
                _check_schema(child)
    if "required" in schema:
        required = schema["required"]
        if (
            not isinstance(required, list)
            or any(not isinstance(key, str) for key in required)
            or len(required) != len(set(required))
            or not set(required) <= set(schema.get("properties", {}))
        ):
            raise ValueError("Edition required keys must name declared properties")
    if "items" in schema:
        _check_schema(schema["items"])
    if "anyOf" in schema:
        branches = schema["anyOf"]
        if not isinstance(branches, list) or not branches:
            raise ValueError("Edition anyOf must contain schema alternatives")
        for branch in branches:
            _check_schema(branch)


def expanded_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Inline local references so a nested tool field has no dangling root refs."""
    _check_schema(schema)
    definitions = schema.get("$defs", {})

    def expand(node: Any, stack: tuple[str, ...] = ()) -> Any:
        if isinstance(node, list):
            return [expand(value, stack) for value in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            name = node["$ref"][len("#/$defs/") :]
            if name not in definitions or name in stack:
                raise ValueError("Missing or cyclic edition schema reference")
            resolved = expand(definitions[name], (*stack, name))
            return {
                **resolved,
                **{key: value for key, value in node.items() if key != "$ref"},
            }
        return {
            key: expand(value, stack)
            for key, value in node.items()
            if key not in {"$defs", "$schema"}
        }

    return expand(schema)


def resolved_schema(schema_path: Path | str | None = None) -> dict[str, Any]:
    return expanded_schema(load_schema(schema_path))


def _matches_type(value: Any, schema: dict[str, Any]) -> bool:
    if "type" in schema and not isinstance(value, _TYPES[schema["type"]]):
        return False
    if "anyOf" in schema:
        return any(_matches_type(value, branch) for branch in schema["anyOf"])
    return True


def _errors(value: Any, schema: dict[str, Any], path: str) -> ValidationErrors:
    if not _matches_type(value, schema):
        expected = schema.get("type", "one of the declared types")
        return ValidationErrors([f"{path} must be {expected}"])
    errors = ValidationErrors()
    if "anyOf" in schema:
        branches = [b for b in schema["anyOf"] if _matches_type(value, b)]
        # Block, source, and status alternatives have explicit discriminators.
        # Report the selected shape's errors, never noise from unrelated shapes.
        if isinstance(value, dict) and all(b.get("type") == "object" for b in branches):
            for key in ("type", "kind", "status"):
                choices = [
                    b.get("properties", {}).get(key, {}).get("enum") for b in branches
                ]
                if all(choice and len(choice) == 1 for choice in choices) and all(
                    key in branch.get("required", []) for branch in branches
                ):
                    matching = [
                        b
                        for b, choice in zip(branches, choices)
                        if value.get(key) in choice
                    ]
                    if len(matching) == 1:
                        branches = matching
                    elif not matching:
                        allowed = ", ".join(choice[0] for choice in choices)
                        return ValidationErrors(
                            [f"{path}.{key} must be one of: {allowed}"]
                        )
                    break
        alternatives = [_errors(value, branch, path) for branch in branches]
        errors.extend(min(alternatives, key=lambda errors: errors.error_count))
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path} must be one of: {', '.join(schema['enum'])}")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            unknown = sorted(set(value) - set(properties))
            if unknown:
                errors.append(
                    f"{path} contains unsupported field(s): {', '.join(unknown)}"
                )
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key} is required")
        for key, child in properties.items():
            if key in value:
                errors.extend(_errors(value[key], child, f"{path}.{key}"))
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path} must contain at least {schema['minItems']} item(s)")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path} must contain at most {schema['maxItems']} item(s)")
        if "items" in schema:
            for index, child in enumerate(value):
                errors.extend(_errors(child, schema["items"], f"{path}[{index}]"))
    return errors


def validate_edition(
    value: Any, schema: dict[str, Any] | None = None
) -> ValidationErrors:
    """Count structural errors and return bounded diagnostics without mutation."""
    return _errors(
        value,
        expanded_schema(schema if schema is not None else load_schema()),
        "edition",
    )


def embedded_image_error(value: str) -> str:
    """Check bounded embedded raster bytes without network access or dependencies."""
    match = re.fullmatch(
        r"data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)", value
    )
    if not match or len(value) > 100_000:
        return "image must be a bounded embedded base64 raster data URL"
    try:
        data = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error):
        return "image has invalid base64 bytes"
    signatures = {
        "png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "jpeg": data.startswith(b"\xff\xd8\xff"),
        "gif": data.startswith((b"GIF87a", b"GIF89a")),
        "webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
    }
    return "" if signatures[match[1]] else "image MIME type does not match raster bytes"
