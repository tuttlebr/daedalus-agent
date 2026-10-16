"""Capture skill schemas and filesystem behavior from the retained Python tool.

No filesystem or parser implementation is replaced. A fixed clock makes the
daily-summary rendering fixtures reproducible; script execution has a separate
real-process acceptance gate.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from export_authorization import fixture_strings
from export_user_interaction import failure

OPERATIONS = ["list_skills", "load_skill", "run_skill_script"]


def skill(
    name="alpha", description="Synthetic skill 雪", body="Synthetic instructions 🌲"
):
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


def materialize(root, spec):
    root.mkdir(parents=True, exist_ok=True)
    for name, value in spec.get("files", {}).items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(
            bytes.fromhex(value["hex"]) if isinstance(value, dict) else value.encode()
        )
    for name, target in spec.get("links", {}).items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)
    for name, mode in spec.get("permissions", {}).items():
        (root / name).chmod(mode)


def catalogs():
    files = {
        "a/SKILL.md": skill("beta", "Synthetic second skill", "Beta instructions"),
        "z/SKILL.md": skill(),
        "z/a.txt": "Synthetic CRLF\r\nnext\rlast\n",
        "z/a/nested.md": "Nested resource",
        "z/.hidden.md": "Hidden but explicitly readable",
        "z/.cache/hidden.md": "Hidden subtree",
        "z/__pycache__/cached.txt": "Cache subtree",
        "z/nested/SKILL.md": "Nested skill file",
        "z/compiled.pyc": "compiled",
        "z/compiled.pyo": "compiled",
        "z/signature.sig": "signature",
        "z/UPPER.SIG": "Uppercase suffix is listed",
        "z/binary.bin": {"hex": "00fffe"},
        "../outside.txt": "Synthetic external file",
        "nested/child/SKILL.md": skill("nested"),
        "SKILL.md": skill("root-file-is-ignored"),
    }
    calls = [
        {"operation": "list_skills", "query": query}
        for query in [
            None,
            "",
            " ",
            "ALPHA",
            "not-found skill",
            "雪",
            "beta\u001calpha",
        ]
    ] + [
        {"operation": "load_skill", "skill_name": name, "resource": resource}
        for name, resource in [
            ("alpha", None),
            ("beta", None),
            ("missing", None),
            ("alpha", "a.txt"),
            ("alpha", "a/../a.txt"),
            ("alpha", "a/nested.md"),
            ("alpha", ".hidden.md"),
            ("alpha", "binary.bin"),
            ("alpha", "missing.txt"),
            ("alpha", "../../outside.txt"),
            ("alpha", "."),
            ("alpha", "SKILL.md"),
            ("missing", "a.txt"),
            ("alpha", "outside-link"),
            ("alpha", "inside-link"),
        ]
    ]
    cases = [
        {
            "name": "catalog-resources",
            "files": files,
            "links": {
                "z/outside-link": "../../outside.txt",
                "z/inside-link": "a.txt",
                "z/directory-link": "a",
            },
            "calls": calls,
        }
    ]
    cases.append(
        {
            "name": "duplicate-name",
            "files": {
                "a/SKILL.md": skill("same", "First", "First instructions"),
                "b/SKILL.md": skill("middle"),
                "c/SKILL.md": skill("same", "Last", "Last instructions"),
            },
            "calls": [
                {"operation": "list_skills"},
                {"operation": "load_skill", "skill_name": "same"},
            ],
        }
    )
    cases.append(
        {
            "name": "instruction-cache",
            "files": {"a/SKILL.md": skill()},
            "calls": [
                {"operation": "load_skill", "skill_name": "alpha"},
                {
                    "operation": "load_skill",
                    "skill_name": "alpha",
                    "write": {
                        "a/SKILL.md": skill(body="Changed instructions"),
                        "a/new.txt": "New resource",
                    },
                },
                {
                    "operation": "load_skill",
                    "skill_name": "alpha",
                    "resource": "SKILL.md",
                },
                {
                    "operation": "load_skill",
                    "skill_name": "alpha",
                    "delete": ["a/SKILL.md"],
                },
            ],
        }
    )
    cases.append(
        {
            "name": "changed-before-first-load",
            "files": {"a/SKILL.md": skill()},
            "calls": [
                {
                    "operation": "load_skill",
                    "skill_name": "alpha",
                    "write": {"a/SKILL.md": "Changed plain instructions\r\n"},
                },
            ],
        }
    )
    cases.append(
        {
            "name": "missing-before-first-load",
            "files": {"a/SKILL.md": skill()},
            "calls": [
                {
                    "operation": "load_skill",
                    "skill_name": "alpha",
                    "delete": ["a/SKILL.md"],
                },
            ],
        }
    )
    cases.append(
        {
            "name": "binary-before-first-load",
            "files": {"a/SKILL.md": skill()},
            "calls": [
                {
                    "operation": "load_skill",
                    "skill_name": "alpha",
                    "write": {"a/SKILL.md": {"hex": "ff"}},
                },
                {
                    "operation": "load_skill",
                    "skill_name": "alpha",
                    "write": {"a/SKILL.md": {"hex": "e282"}},
                },
            ],
        }
    )
    cases.append(
        {
            "name": "missing-root",
            "files": {},
            "calls": [
                {"operation": "list_skills"},
                {"operation": "load_skill", "skill_name": "missing"},
            ],
        }
    )
    daily_files = {
        "daily/SKILL.md": skill(
            "daily-summary", "Synthetic daily summary", "Daily instructions"
        ),
        "daily/references/edition-policy.json": json.dumps(
            {"edition": {"timezone": "America/Detroit"}}
        ),
        "daily/references/research-and-sourcing.md": "Synthetic source policy",
        "daily/references/edition-format.md": "Synthetic edition format",
        "daily/references/editorial-spec.md": "Synthetic editorial specification",
        "daily/extra.txt": "Extra resource",
    }
    for name, changes in [
        ("daily-summary", {}),
        (
            "daily-invalid-zone",
            {
                "daily/references/edition-policy.json": '{"edition":{"timezone":"Invalid/Zone"}}'
            },
        ),
        ("daily-invalid-policy", {"daily/references/edition-policy.json": "[]"}),
    ]:
        cases.append(
            {
                "name": name,
                "files": {**daily_files, **changes},
                "calls": [{"operation": "load_skill", "skill_name": "daily-summary"}],
            }
        )
    return cases


async def export(root):
    from agent_skills import agent_skills_function as module
    from agent_skills import skill_parser
    from agent_skills.load_events import skill_load_scope

    factory = contextlib.asynccontextmanager(module.agent_skills_function)
    defaults = module.AgentSkillsConfig()
    resources = {
        "defaults": defaults.model_dump(mode="json"),
        "configuration_schema": defaults.model_json_schema(),
        "schemas": {},
        "script_output_limit": module._MAX_SCRIPT_OUTPUT_BYTES,
        "allowed_environment": sorted(module._ALLOWED_ENV_VARS),
        "daily_resources": module.DAILY_SUMMARY_BOOTSTRAP_RESOURCES,
    }
    resources["yaml_scalar_patterns"] = sorted(
        {
            pattern.pattern
            for entries in skill_parser.yaml.SafeLoader.yaml_implicit_resolvers.values()
            for tag, pattern in entries
            if tag.rsplit(":", 1)[-1] in {"bool", "int", "float", "null", "timestamp"}
        }
    )
    for mask in range(8):
        config = module.AgentSkillsConfig(
            skills_directory="/synthetic-missing",
            allow_script_execution=True,
            enabled_operations=[
                name for index, name in enumerate(OPERATIONS) if mask & (1 << index)
            ],
        )
        async with factory(config, None) as tool:
            resources["schemas"][str(mask)] = tool.schema("agent_skills")
    async with factory(
        module.AgentSkillsConfig(skills_directory="/synthetic-missing", description=""),
        None,
    ) as tool:
        resources["fallback_description"] = tool.description
    configurations = []
    for field in [*resources["configuration_schema"]["properties"], "unknown"]:
        for value in [
            None,
            "",
            "Synthetic setting",
            " \u001c",
            0,
            -1,
            1,
            1.5,
            30,
            300,
            301,
            True,
            False,
            [],
            {},
            "yes",
            "30",
            ".sh",
            [".sh", ".py"],
            ["load_skill"],
            ["load_skill", "load_skill", "list_skills"],
            ["run_skill_script"],
            ["unknown"],
        ]:
            raw = {field: value}
            try:
                config = module.AgentSkillsConfig.model_validate(raw)
                expected = {"ok": config.model_dump(mode="json")}
                try:
                    async with factory(config, None) as tool:
                        expected["schema"] = tool.schema("configured_skills")
                except Exception as exc:
                    expected["schema_error"] = type(exc).__name__
            except ValueError:
                expected = {"error": True}
            configurations.append({"input": raw, "expected": expected})
    inputs = []
    for allow in [False, True]:
        for mask in range(8):
            config = module.AgentSkillsConfig(
                skills_directory="/synthetic-missing",
                allow_script_execution=allow,
                enabled_operations=[
                    name for index, name in enumerate(OPERATIONS) if mask & (1 << index)
                ],
            )
            async with factory(config, None) as tool:
                for raw in [
                    None,
                    [],
                    {},
                    {"operation": "unknown"},
                    {"operation": "list_skills"},
                    {"operation": "list_skills", "query": ""},
                    {"operation": "list_skills", "query": None},
                    {"operation": "list_skills", "query": 1},
                    {"operation": "list_skills", "skill_name": "forbidden"},
                    {"operation": "load_skill"},
                    {"operation": "load_skill", "skill_name": " \u001c"},
                    {"operation": "load_skill", "skill_name": "missing"},
                    {"operation": "load_skill", "skill_name": None},
                    {
                        "operation": "load_skill",
                        "skill_name": "missing",
                        "resource": "",
                    },
                    {
                        "operation": "load_skill",
                        "skill_name": "missing",
                        "resource": None,
                    },
                    {"operation": "load_skill", "skill_name": "missing", "resource": 1},
                    {"operation": "load_skill", "skill_name": "missing", "query": None},
                    {
                        "operation": "run_skill_script",
                        "skill_name": "missing",
                        "script": "script.py",
                    },
                    {
                        "operation": "run_skill_script",
                        "skill_name": "missing",
                        "script": " ",
                    },
                    {
                        "operation": "run_skill_script",
                        "skill_name": "missing",
                        "script": "script.py",
                        "args": None,
                    },
                    {
                        "operation": "run_skill_script",
                        "skill_name": "missing",
                        "script": "script.py",
                        "args": [],
                    },
                ]:
                    try:
                        expected = {"ok": await tool.ainvoke(raw)}
                    except Exception as exc:
                        expected = failure(exc)
                    inputs.append(
                        {
                            "mask": mask,
                            "allow": allow,
                            "input": raw,
                            "expected": expected,
                        }
                    )
    frontmatter = []
    documents = [
        skill(),
        skill(body=""),
        skill().replace("\n", "\r\n"),
        skill().replace("\n", "\r"),
        "\ufeff" + skill(),
        " " + skill(),
        "---\nname: alpha\ndescription: Test\n---",
        "No frontmatter",
        "---\n[]\n---\n",
        "---\nname: [invalid\n---\n",
        "---\nname: alpha\ndescription: yes\n---\n",
        "---\nname: alpha\ndescription: !!str yes\n---\n",
        "---\nname: alpha\ndescription: 2026-10-14\n---\n",
        "---\nname: alpha\ndescription: .nan\n---\n",
        "---\nbase: &base {name: alpha, description: Merged}\n<<: *base\n---\n",
        "---\n!!map {name: alpha, description: Explicit map}\n---\n",
        "---\nname: alpha\ndescription: Explicit sequence\nextra: !!seq [one, two]\n---\n",
        "---\nname: alpha\ndescription: Set\nextra: !!set {one: null, two: null}\n---\n",
        "---\nname: alpha\ndescription: Ordered\nextra: !!omap [{one: 1}, {two: 2}]\n---\n",
        "---\nname: alpha\ndescription: Pairs\nextra: !!pairs [{one: 1}, {one: 2}]\n---\n",
        "---\n!!set {name: alpha, description: Set root}\n---\n",
        "---\nname: alpha\ndescription: !!map invalid\n---\n",
        "---\nname: alpha\ndescription: !!undefined invalid\n---\n",
    ]
    documents += [
        skill(name)
        for name in [
            "A",
            "a_b",
            "a--b",
            "雪",
            "a-",
            "a" * 64,
            "a" * 65,
            "' alpha '",
            "null",
            "123",
            "''",
        ]
    ]
    documents += [
        skill(description=description)
        for description in [
            "''",
            "'   '",
            "'雪'",
            "'" + "雪" * 1024 + "'",
            "'" + "雪" * 1025 + "'",
            "null",
            "[]",
            "{}",
            "123",
        ]
    ]
    with tempfile.TemporaryDirectory(prefix="daedalus-skill-export-") as directory:
        base = Path(directory)
        for index, content in enumerate(documents):
            location = base / f"frontmatter-{index}"
            location.mkdir()
            (location / "SKILL.md").write_bytes(content.encode())
            parser = skill_parser.SkillParser(str(location.parent))
            try:
                metadata = parser._parse_frontmatter(location / "SKILL.md", location)
                parser._skills[metadata.name] = metadata
                expected = {
                    "metadata": metadata.to_dict(),
                    "body": parser.get_skill_instructions(metadata.name),
                }
            except Exception as exc:
                expected = {"error": type(exc).__name__}
            frontmatter.append({"content": content, "expected": expected})
        catalog_cases = []

        class FixedClock(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 14, 12, 0, 0, 123456, tzinfo=UTC).astimezone(tz)

        for index, case in enumerate(catalogs()):
            directory_root = base / f"catalog-{index}" / "root"
            materialize(directory_root, case)
            parser = skill_parser.SkillParser(str(directory_root))
            metadata = [entry.to_dict() for entry in parser.discover_skills()]
            observed = []
            for call in case["calls"]:
                materialize(directory_root, {"files": call.get("write", {})})
                for name in call.get("delete", []):
                    (directory_root / name).unlink()
                loaded = []
                with skill_load_scope(
                    lambda event: loaded.append(event.skill_name)
                ), patch.object(module, "datetime", FixedClock):
                    if call["operation"] == "list_skills":
                        result = await module._list_skills(parser, call.get("query"))
                    else:
                        result = await module._load_skill(
                            parser, call["skill_name"], call.get("resource")
                        )
                observed.append(
                    {
                        "output": result.replace(str(directory_root), "{ROOT}"),
                        "loaded": loaded,
                    }
                )
            catalog_cases.append(
                {**case, "expected": {"metadata": metadata, "calls": observed}}
            )
    fixture = {
        "source_sha256": {
            Path(item.__file__).name: hashlib.sha256(
                Path(item.__file__).read_bytes()
            ).hexdigest()
            for item in [module, skill_parser]
        },
        "configuration": configurations,
        "inputs": inputs,
        "frontmatter": frontmatter,
        "catalogs": catalog_cases,
    }
    for folder, value in [
        ("resources", resources),
        ("tests/fixtures", fixture_strings(fixture)),
    ]:
        path = root / folder / "agent-skills.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=folder == "resources", indent=2) + "\n"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
