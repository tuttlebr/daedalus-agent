"""Offline checks of the model-facing native catalog in the installed application runtime.

With --config, also compare production configuration and bundled skill tool
references. No provider, storage, MCP, or mutation calls are made.
"""

import argparse
import asyncio
import importlib
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

# All native tools in the production workflow. The configuration check rejects
# additions without a runtime fixture, so new tools cannot silently evade it.
FACTORIES = {
    "agent_skills_tool": (
        "agent_skills.agent_skills_function",
        "AgentSkillsConfig",
        "agent_skills_function",
    ),
    "briefing_renderer_tool": (
        "nat_helpers.briefing_renderer",
        "BriefingRendererConfig",
        "briefing_renderer",
    ),
    "add_memory": (
        "nat_helpers.daedalus_memory_tools",
        "DaedalusAddMemoryConfig",
        "daedalus_add_memory",
    ),
    "current_datetime_tool": (
        "daedalus_runtime.datetime_tool",
        "DateTimeConfig",
        "current_datetime",
    ),
    "get_memory": (
        "nat_helpers.daedalus_memory_tools",
        "DaedalusGetMemoryConfig",
        "daedalus_get_memory",
    ),
    "visual_media_tool": (
        "visual_media.visual_media_function",
        "VisualMediaFunctionConfig",
        "visual_media_function",
    ),
    "domain_retriever_tool": (
        "smart_milvus.register",
        "DomainRetrieverConfig",
        "domain_retriever_function",
    ),
    "user_document_tool": (
        "nat_nv_ingest.nat_nv_ingest",
        "NvIngestFunctionConfig",
        "nv_ingest_function",
    ),
    "curated_feed_search_tool": (
        "rss_feed.rss_feed_function",
        "RssFeedFunctionConfig",
        "rss_feed_function",
    ),
    "content_distiller_tool": (
        "content_distiller.content_distiller_function",
        "ContentDistillerConfig",
        "content_distiller_function",
    ),
    "tool_output_retriever_tool": (
        "nat_helpers.tool_output_retriever",
        "ToolOutputRetrieverConfig",
        "tool_output_retriever",
    ),
    "user_interaction_tool": (
        "user_interaction.user_interaction_function",
        "UserInteractionConfig",
        "user_interaction_function",
    ),
    "perplexity_search_tool": (
        "perplexity_search.perplexity_search_function",
        "PerplexitySearchConfig",
        "perplexity_search_function",
    ),
    "webscrape_tool": (
        "webscrape.webscrape_function",
        "WebscrapeFunctionConfig",
        "webscrape_function",
    ),
    "nws_weather_tool": (
        "webscrape.nws_weather_function",
        "NwsWeatherFunctionConfig",
        "nws_weather_function",
    ),
    "llm_sandbox_tool": (
        "llm_sandbox.llm_sandbox_function",
        "LlmSandboxConfig",
        "llm_sandbox_function",
    ),
    "nvidia_docs_tool": ("nat_helpers.nvidia_docs", "NvidiaDocsConfig", "nvidia_docs"),
    "source_verifier_tool": (
        "source_verifier.source_verifier_function",
        "SourceVerifierConfig",
        "source_verifier_function",
    ),
}

SAMPLES = {
    "agent_skills_tool": [
        {"operation": "list_skills"},
        {"operation": "load_skill", "skill_name": "daily-summary"},
    ],
    "briefing_renderer_tool": [{"edition": {"schema": "daily-daedalus/v1"}}],
    "add_memory": [{"memory": "A user-requested preference."}],
    "current_datetime_tool": [{}],
    "get_memory": [{"query": "daily summary preferences"}],
    "visual_media_tool": [
        {"operation": "generate", "prompt": "A tree"},
        {
            "operation": "edit",
            "prompt": "Blue background",
            "imageRef": {"imageId": "fixture"},
        },
        {
            "operation": "analyze",
            "question": "What is shown?",
            "image_url": "https://8.8.8.8/image.png",
        },
    ],
    "domain_retriever_tool": [{"query": "Pod conditions", "domain": "kubernetes"}],
    "user_document_tool": [
        {"operation": "search", "query": "Summary"},
        {"operation": "ingest", "documentRef": {"documentId": "fixture"}},
        {"operation": "extract", "documentRef": {"documentId": "fixture"}},
        {"operation": "list_collections"},
    ],
    "curated_feed_search_tool": [
        {"query": "NVIDIA updates", "feed_scope": "nvidia_developer"},
        {
            "mode": "discover",
            "queries": [
                {"query": "Developer releases", "feed_scope": "nvidia_developer"},
                {"query": "Infrastructure analysis", "feed_scope": "semianalysis"},
            ],
            "top_k": 3,
        },
    ],
    "nws_weather_tool": [{"latitude": 42.1667, "longitude": -83.7833, "days": 4}],
    "content_distiller_tool": [
        {
            "content": "Observed public source prose.",
            "focus": "changes",
            "max_words": 100,
        }
    ],
    "tool_output_retriever_tool": [
        {"reference": "00000000-0000-4000-8000-000000000001", "query": "Ready"}
    ],
    "user_interaction_tool": [
        {"operation": "clarify", "question": "Which site?"},
        {
            "operation": "confirm_action",
            "action": "Delete the selected memory",
            "action_type": "delete_memory",
        },
        {"operation": "confirm_research_plan", "title": "Requested research"},
        {"operation": "delete_memory_guarded", "approval_token": "invalid-fixture"},
    ],
    "perplexity_search_tool": [
        {"query": "NVIDIA release", "search_recency_filter": "week"}
    ],
    "webscrape_tool": [{"url": "https://8.8.8.8/source"}],
    "llm_sandbox_tool": [
        {"operation": "list_commands"},
        {"operation": "execute", "argv": ["python", "--version"]},
        {
            "operation": "write_file",
            "file_path": "report.txt",
            "file_content": "Report",
        },
        {"operation": "read_file", "file_path": "report.txt"},
        {"operation": "publish_file", "file_path": "report.txt"},
    ],
    "nvidia_docs_tool": [{"product": "dynamo", "query": "router modes"}],
    "source_verifier_tool": [
        {
            "operation": "plan_sources",
            "research_question": "Current cluster and UniFi briefing",
            "selected_sources_json": '["cluster_state", "network_state"]',
            "depth": "quick",
        },
        {
            "operation": "verify_claim",
            "claim": "The release supports the feature.",
            "source_url": "https://8.8.8.8/source",
        },
        {
            "operation": "audit_citations",
            "answer_markdown": "The feature is supported [1].\n\n## References\n- [1] Release: https://8.8.8.8/source",
            "source_urls_json": '["https://8.8.8.8/source"]',
        },
    ],
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def check_configuration(config):
    from daedalus_runtime.approval import _parse_mcp_group_approval_policy

    functions = config["functions"]
    groups = config["function_groups"]
    available = set(config["workflow"]["tools"])
    require(
        set(functions) == set(FACTORIES),
        "Native catalog changed: update runtime fixtures",
    )
    require(
        available == set(functions) | set(groups),
        "Configured tools and workflow exposure differ",
    )
    for entry in functions["source_verifier_tool"]["source_registry"]:
        require(
            set(entry["tools"]) <= available,
            f"Unknown source capability: {entry['id']}",
        )
    for name, group in groups.items():
        _parse_mcp_group_approval_policy(name, group)
        included = set(group.get("include", []))
        overrides = set(group.get("tool_overrides", {}))
        if included:
            require(overrides <= included, f"Stale MCP override: {name}")
        else:
            require(
                not overrides.intersection(group.get("exclude", [])),
                f"Override for excluded MCP tool: {name}",
            )


def check_mcp_catalog(config, catalog, skills_directory=None):
    """Validate a tools/list capture without executing any remote leaf tools."""
    groups = config["function_groups"]
    require(
        set(groups) == set(catalog), "MCP capture does not cover every configured group"
    )
    exposed = {}
    for name, group in groups.items():
        entry = catalog[name]
        require(
            entry.get("status") == "ok",
            f"MCP catalog unavailable or incomplete: {name}",
        )
        tools = {tool["name"]: tool for tool in entry["tools"]}
        require(len(tools) == len(entry["tools"]), f"Duplicate MCP leaf names: {name}")
        included = set(group.get("include", [])) or (
            set(tools) - set(group.get("exclude", []))
        )
        require(
            included <= set(tools),
            f"Configured MCP tools missing: {name}: {included - set(tools)}",
        )
        exposed[name] = {leaf: tools[leaf] for leaf in included}
    samples = (
        ("gmail_mcp_server", "get_thread", {"threadId": "fixture"}),
        (
            "calendar_mcp_server",
            "list_events",
            {
                "startTime": "2026-09-11T00:00:00-04:00",
                "endTime": "2026-09-15T00:00:00-04:00",
                "timeZone": "America/Detroit",
            },
        ),
        ("calendar_mcp_server", "get_event", {"eventId": "fixture"}),
        ("k8s_mcp_server", "getAPIResources", {}),
        (
            "unifi_mcp_server",
            "listAdoptedDevices",
            {"siteId": "fixture", "offset": 0, "limit": 25},
        ),
        (
            "espn_mcp_server",
            "get_roster",
            {"league_id": 1, "season": 2026, "team_id": 1, "week": 1},
        ),
    )
    for group, leaf, arguments in samples:
        schema = exposed[group][leaf]["inputSchema"]
        require(
            set(arguments) <= set(schema.get("properties", {})),
            f"Unsupported arguments for {group}.{leaf}",
        )
        require(
            set(schema.get("required", [])) <= set(arguments),
            f"Missing arguments for {group}.{leaf}",
        )
    if skills_directory:
        for path in Path(skills_directory).rglob("*.md"):
            for group, leaf in re.findall(
                r"\b([a-z_]+_mcp_server)\.([A-Za-z_]+)", path.read_text()
            ):
                require(
                    leaf in exposed.get(group, {}),
                    f"Unavailable skill tool: {path}: {group}.{leaf}",
                )
    print(
        f"Validated {len(exposed)} MCP groups and {sum(len(tools) for tools in exposed.values())} exposed leaves."
    )


async def check_catalog(config=None, skills_directory=None):
    if config:
        check_configuration(config)
    catalog = {}
    for name, (module_name, config_name, factory_name) in FACTORIES.items():
        module = importlib.import_module(module_name)
        config_type = getattr(module, config_name)
        factory = getattr(module, factory_name)
        raw = (config or {}).get("functions", {}).get(name, {})
        # Provider/connection fields keep offline defaults. Carry production
        # routing and operation policy into real registration without secrets.
        kwargs = {
            key: raw[key]
            for key in (
                "description",
                "enabled_operations",
                "source_registry",
                "allow_script_execution",
            )
            if key in raw
        }
        if name != "current_datetime_tool":
            kwargs.setdefault("description", f"Runtime routing contract for {name}.")
            require(
                "description" in config_type.model_fields,
                f"{name} discards configured descriptions",
            )
        if name == "domain_retriever_tool":
            kwargs.update(uri="http://milvus.invalid:19530", embedding_model="fixture")
        if name == "curated_feed_search_tool":
            kwargs["feeds"] = raw.get(
                "feeds",
                {
                    "nvidia_developer": "https://example.com/developer.xml",
                    "semianalysis": "https://example.com/analysis.xml",
                },
            )
        if name == "agent_skills_tool" and skills_directory:
            kwargs["skills_directory"] = str(skills_directory)
        if name == "briefing_renderer_tool" and skills_directory:
            kwargs["skill_directory"] = str(Path(skills_directory) / "daily-summary")
        if name == "agent_skills_tool":
            kwargs.setdefault("enabled_operations", ["list_skills", "load_skill"])
        tool_config = config_type(**kwargs)
        builder = SimpleNamespace(
            get_function=AsyncMock(
                return_value=SimpleNamespace(
                    ainvoke=AsyncMock(
                        side_effect=AssertionError("Unexpected sandbox execution")
                    )
                )
            )
        )
        # The real async context manager catches zero/multiple yields, unlike
        # direct async-generator iteration in unit-test NAT stubs.
        async with asynccontextmanager(factory)(tool_config, builder) as info:
            schema = info.input_schema.model_json_schema()
            properties = schema.get("properties", {})
            if name == "briefing_renderer_tool":
                from nat_helpers.agent_loop_guard import agent_run_scope

                serialized = {"function": info.schema(name)}
                edition_schema = serialized["function"]["parameters"]["properties"][
                    "edition"
                ]
                blocks = edition_schema["properties"]["operations_details"]["items"][
                    "properties"
                ]["blocks"]["items"]["anyOf"]
                briefs = next(
                    block
                    for block in blocks
                    if block["properties"]["type"]["enum"] == ["briefs"]
                )
                require(
                    briefs["required"] == ["type", "items"]
                    and "items" in briefs["properties"]
                    and briefs["additionalProperties"] is False
                    and '"$ref"' not in json.dumps(edition_schema),
                    "Canonical briefing block constraints did not reach the model schema",
                )
                # Exercise the real typed invocation used by the Python service.
                sandbox = await builder.get_function(tool_config.sandbox_tool)
                sandbox.ainvoke.side_effect = None
                sandbox.ainvoke.return_value = (
                    "## Sandbox Capabilities\n"
                    'Isolation: "bubblewrap"\nStateless: true\n'
                    'Conversation workspaces: true\nCommands (JSON): ["true"]\n'
                    "Maximum timeout: 60 seconds"
                )
                submitted = {"format": "daily-daedalus/v1", "editors_note": []}
                with agent_run_scope():
                    result = json.loads(await info.ainvoke({"edition": submitted}))
                require(
                    result.get("passed") is False
                    and result.get("failure_type") == "validation"
                    and result.get("error_count", 0) > 1
                    and result.get("edition") == submitted,
                    "Wrapped renderer invocation did not preserve the edition and aggregate errors",
                )
            if name != "current_datetime_tool":
                require(
                    kwargs["description"] in info.description,
                    f"{name} loses routing description",
                )
            enabled = kwargs.get("enabled_operations")
            if enabled and name != "content_distiller_tool":
                operation = properties.get("operation", {})
                require(
                    set(enabled) <= set(operation.get("enum", [])),
                    f"{name} hides enabled operations",
                )
            for sample in SAMPLES[name]:
                require(
                    set(sample) <= set(properties),
                    f"{name} rejects documented arguments: {set(sample) - set(properties)}",
                )
                info.input_schema.model_validate(sample)
            catalog[name] = {"schema": schema, "description": info.description}
            if name == "source_verifier_tool":
                with patch.object(
                    module,
                    "_fetch_source",
                    AsyncMock(
                        return_value=module.FetchResult(
                            status="ok", content="The release supports the feature."
                        )
                    ),
                ), patch.object(
                    module,
                    "_call_llm",
                    AsyncMock(
                        return_value=json.dumps(
                            {
                                "verdict": "supported",
                                "confidence": 0.9,
                                "evidence": "The release supports the feature.",
                                "reasoning": "Direct evidence",
                                "claim_issues": [],
                            }
                        )
                    ),
                ):
                    outputs = [
                        json.loads(
                            await info.ainvoke(info.input_schema.model_validate(sample))
                        )
                        for sample in SAMPLES[name]
                    ]
                require(
                    outputs[0]["passed"]
                    and outputs[1]["verdict"] == "supported"
                    and outputs[2]["passed"],
                    "Combined verifier operation execution failed",
                )
    if skills_directory:
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            AgentSkillsInput,
            agent_skills_function,
        )
        from agent_skills.skill_parser import SkillParser

        parser = SkillParser(str(skills_directory))
        skills = parser.discover_skills()
        resource_count = 0
        async with asynccontextmanager(agent_skills_function)(
            AgentSkillsConfig(
                skills_directory=str(skills_directory),
                enabled_operations=["list_skills", "load_skill"],
            ),
            SimpleNamespace(),
        ) as info:
            listed = json.loads(
                await info.ainvoke(AgentSkillsInput(operation="list_skills"))
            )
            require(len(listed["skills"]) == len(skills), "Skill discovery mismatch")
            for skill in skills:
                loaded = await info.ainvoke(
                    AgentSkillsInput(operation="load_skill", skill_name=skill.name)
                )
                require(
                    parser.get_skill_instructions(skill.name) in loaded,
                    f"Cannot load {skill.name}",
                )
                for resource in parser.list_skill_resources(skill.name):
                    loaded = await info.ainvoke(
                        AgentSkillsInput(
                            operation="load_skill",
                            skill_name=skill.name,
                            resource=resource,
                        )
                    )
                    require(
                        loaded == (skill.directory / resource).read_text(),
                        f"Cannot load {skill.name}/{resource}",
                    )
                    resource_count += 1
        print(
            f"Loaded {len(skills)} skills and {resource_count} resources through the tool registry."
        )
    print(
        f"Validated {len(catalog)} native tool schemas, routing descriptions, and registration lifecycles."
    )
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--skills", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--mcp-catalog",
        type=Path,
        help="Read-only tools/list JSON capture; requires --config",
    )
    args = parser.parse_args()
    config = None
    if args.config:
        import yaml

        config = yaml.safe_load(args.config.read_text())
    catalog = asyncio.run(check_catalog(config, args.skills))
    if args.mcp_catalog:
        require(config is not None, "--mcp-catalog requires --config")
        check_mcp_catalog(config, json.loads(args.mcp_catalog.read_text()), args.skills)
    if args.output:
        args.output.write_text(json.dumps(catalog, indent=2) + "\n")


if __name__ == "__main__":
    main()
