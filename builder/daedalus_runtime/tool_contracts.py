"""Model-facing operation contracts, enforced before invoking a native tool.

Fields retain their implementation's types and bounds. These contracts add the
relationships a flat dispatcher schema cannot express: enabled operations,
required arguments, mutually exclusive inputs, and irrelevant arguments.
"""

from __future__ import annotations

from copy import deepcopy


def operation(required=(), optional=(), one_of=()):
    return {"required": required, "optional": optional, "one_of": one_of}


OPERATIONS = {
    "agent_skills": {
        "list_skills": operation(optional=("query",)),
        "load_skill": operation(("skill_name",), ("resource",)),
        "run_skill_script": operation(("skill_name", "script"), ("args",)),
    },
    "source_verifier": {
        "verify_claim": operation(("claim", "source_url"), ("context",)),
        "plan_sources": operation(
            ("research_question",),
            ("selected_sources_json", "disabled_sources_json", "depth"),
        ),
        "audit_citations": operation(
            ("answer_markdown",), ("source_urls_json", "require_references")
        ),
    },
    "visual_media": {
        "generate": operation(
            ("prompt",), ("brief", "options", "guidance", "background")
        ),
        "edit": operation(
            ("prompt", "imageRef"), ("brief", "options", "guidance", "background")
        ),
        "analyze": operation(
            ("question",), one_of=("imageRef", "image_url", "videoRef", "video_url")
        ),
    },
    "nat_nv_ingest": {
        "search": operation(("query",), ("collection_name", "top_k", "filters")),
        "list_collections": operation(),
        "ingest": operation(
            optional=("collection_name", "provenance", "chunk_size", "chunk_overlap"),
            one_of=("documentRef", "documentRefs"),
        ),
        "extract": operation(("documentRef",)),
    },
    "llm_sandbox": {
        "list_commands": operation(),
        "execute": operation(
            optional=("timeout_seconds", "env_json", "working_directory"),
            one_of=("argv", "command"),
        ),
        "write_file": operation(("file_path", "file_content"), ("append",)),
        "read_file": operation(("file_path",)),
        "publish_file": operation(("file_path",)),
    },
    "user_interaction": {
        "confirm_action": operation(("action", "reason"), ("risks", "alternatives")),
        "delete_memory_guarded": operation(("approval_token",)),
    },
}


def _present(_schema):
    """Require an actual value, not null or an empty string/list/object."""
    return {
        "not": {"type": "null"},
        "minLength": 1,
        "pattern": r"\S",
        "minItems": 1,
        "minProperties": 1,
    }


def parameters(kind, original, config):
    if kind == "rss_feed":
        schema = deepcopy(original)
        schema["additionalProperties"] = False
        props = schema["properties"]
        schema["oneOf"] = [
            {
                "required": ["query"],
                "properties": {"query": _present(props["query"]), "queries": False},
            },
            {
                "required": ["mode", "queries"],
                "properties": {
                    "mode": {"const": "discover"},
                    "queries": _present(props["queries"]),
                    "query": False,
                    "feed_scope": False,
                },
            },
        ]
        return schema
    contracts = OPERATIONS.get(kind)
    if contracts is None:
        return deepcopy(original)
    enabled = getattr(config, "enabled_operations", None)
    enabled = set(contracts if enabled is None else enabled)
    if kind == "agent_skills" and not config.allow_script_execution:
        enabled.discard("run_skill_script")
    if enabled - contracts.keys():
        raise ValueError("Configured tool operation has no argument contract")
    schema = deepcopy(original)
    if not enabled:
        return {"type": "object", "not": {}}
    properties = schema["properties"]
    used = {"operation"}
    for name in enabled:
        for fields in contracts[name].values():
            used.update(fields)
    if used - properties.keys():
        raise ValueError("Tool operation contract references an unknown argument")
    schema["properties"] = {
        key: value for key, value in properties.items() if key in used
    }
    for key, field in schema["properties"].items():
        if key == "operation":
            continue
        permitted = [
            name
            for name, spec in contracts.items()
            if name in enabled and any(key in fields for fields in spec.values())
        ]
        required = [
            name
            for name, spec in contracts.items()
            if name in enabled and key in spec["required"]
        ]
        field["description"] = " ".join(
            filter(
                None,
                (
                    field.get("description"),
                    f"Allowed only for: {', '.join(permitted)}.",
                    f"Required for: {', '.join(required)}." if required else "",
                ),
            )
        )
    schema["properties"]["operation"] = {
        "type": "string",
        "enum": [name for name in contracts if name in enabled],
        "description": "Required operation; supply only the arguments for that operation.",
    }
    schema["required"] = ["operation"]
    schema["additionalProperties"] = False
    rules = []
    for name, contract in contracts.items():
        if name not in enabled:
            continue
        allowed = {
            "operation",
            *contract["required"],
            *contract["optional"],
            *contract["one_of"],
        }
        constraints = {key: False for key in used - allowed}
        for key in contract["required"]:
            # Empty files are valid; their content must still be supplied.
            if key != "file_content":
                constraints[key] = _present(properties[key])
        branch = {"required": list(contract["required"]), "properties": constraints}
        if contract["one_of"]:
            branch["oneOf"] = [
                {"required": [key], "properties": {key: _present(properties[key])}}
                for key in contract["one_of"]
            ]
        if kind == "visual_media" and name == "analyze":
            branch["properties"]["imageRef"] = {"not": {"type": "array"}}
        rules.append(
            {"if": {"properties": {"operation": {"const": name}}}, "then": branch}
        )
    schema.setdefault("allOf", []).extend(rules)
    return schema
