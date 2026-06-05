"""Contract checks between backend YAML and custom tool signatures."""

from pathlib import Path

import yaml

CONFIG = Path(__file__).resolve().parents[2] / "backend" / "tool-calling-config.yaml"
ENV_TEMPLATE = Path(__file__).resolve().parents[2] / ".env.template"
AGENTS_GUIDE = Path(__file__).resolve().parents[2] / "AGENTS.md"
SKILLS_DIR = Path(__file__).resolve().parents[2] / "skills"
DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"
NGINX_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "config-nginx.yaml"
)
CILIUM_NGINX_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "cilium-nginx.yaml"
)
NETWORK_POLICY_BACKEND_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "networkpolicy-backend.yaml"
)
CILIUM_BACKEND_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "cilium-backend.yaml"
)
BACKEND_DEPLOYMENT_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "backend-default-deployment.yaml"
)
FRONTEND_DEPLOYMENT_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "frontend-deployment.yaml"
)
HELM_VALUES = Path(__file__).resolve().parents[2] / "helm" / "daedalus" / "values.yaml"
CUSTOM_VALUES = Path(__file__).resolve().parents[2] / "custom-values.yaml"
DEPLOYED_CONFIGS = (CONFIG,)
PROMPT_GUIDANCE_RUNTIME_PROMPTS = {
    "workflow",
    "research_agent",
    "deep_research_agent",
    "nvidia_docs_agent",
    "ops_agent",
    "daily_summary_agent",
    "user_data_agent",
    "user_document_agent",
}
PROMPT_GUIDANCE_CODE_SURFACES = (
    Path("builder/autonomous_agent/src/autonomous_agent/prompt.py"),
    Path(
        "builder/content_distiller/src/content_distiller/content_distiller_function.py"
    ),
    Path("builder/source_verifier/src/source_verifier/source_verifier_function.py"),
    Path("builder/vtt_interpreter/src/vtt_interpreter/vtt_interpreter_function.py"),
    Path("builder/smart_milvus/src/smart_milvus/configs/config.yml"),
)
NAT_CODING_AGENT_SKILLS = {
    "nat-agent-configuration",
    "nat-evaluation",
    "nat-installation",
    "nat-mcp-and-serving",
    "nat-optimization",
    "nat-path-checks",
    "nat-telemetry",
    "nat-tools-and-functions",
    "nat-user-rules",
    "nat-workflow-creation",
    "skill-evolution",
}
LEGACY_RERANKER_PREFIX = "REA" + "NKER_"
LEGACY_CLUSTER_LOCAL_PORT = "cluster.local" + ".:"
MULTI_OPERATION_TYPES = {
    "agent_skills": ["list_skills", "load_skill", "run_skill_script"],
    "content_distiller": ["distill_content", "extract_structured", "synthesize"],
    "mas_optimizer": ["mas_evaluate", "mas_verify", "mas_log_outcome"],
    "source_verifier": [
        "verify_claim",
        "verify_memory",
        "audit_memories",
        "audit_citations",
        "plan_sources",
    ],
    "user_interaction": [
        "clarify",
        "confirm_action",
        "confirm_research_plan",
        "present_options",
        "delete_memory_guarded",
    ],
}


def _config(path=CONFIG):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _effective_operations(config, tool_name):
    if tool_name in config.get("function_groups", {}):
        group = config["function_groups"][tool_name]
        return group.get("include") or [tool_name]

    function = config["functions"].get(tool_name, {})
    operations = MULTI_OPERATION_TYPES.get(function.get("_type"), [tool_name])
    enabled = function.get("enabled_operations")
    if enabled:
        operations = [op for op in operations if op in set(enabled)]
    return operations


def _effective_operation_count(config, tool_names):
    return sum(
        len(_effective_operations(config, tool_name)) for tool_name in tool_names
    )


def _env_placeholders(text: str) -> set[str]:
    import re

    return {
        match.group(1)
        for match in re.finditer(r"\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}", text)
    }


def _template_env_names() -> set[str]:
    return {
        line.split("=", 1)[0]
        for line in ENV_TEMPLATE.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    }


def test_backend_dockerfile_chmods_runtime_files_after_copy():
    lines = DOCKERFILE.read_text(encoding="utf-8").splitlines()
    chmod_lines = [
        i for i, line in enumerate(lines) if "chmod -R a+rX /workspace /skills" in line
    ]
    assert chmod_lines
    chmod_line = max(chmod_lines)

    runtime_copies = [
        "COPY entrypoint.py /workspace/entrypoint.py",
        "COPY llm_diagnostics.py /workspace/llm_diagnostics.py",
        "COPY mcp_patches.py /workspace/mcp_patches.py",
        "COPY image_api.py /workspace/image_api.py",
        "COPY document_ingest_api.py /workspace/document_ingest_api.py",
    ]
    for copy_instruction in runtime_copies:
        copy_lines = [
            i for i, line in enumerate(lines) if line.strip() == copy_instruction
        ]
        assert copy_lines
        assert max(copy_lines) < chmod_line

    assert "mkdir -p /workspace/.tmp" in "\n".join(lines)
    assert "chmod 1777 /workspace/.tmp" in "\n".join(lines)


def test_backend_config_env_placeholders_are_declared_in_template():
    config_text = CONFIG.read_text(encoding="utf-8")

    assert _env_placeholders(config_text) - _template_env_names() == set()


def test_backend_config_uses_canonical_env_names():
    config_text = CONFIG.read_text(encoding="utf-8")
    template_text = ENV_TEMPLATE.read_text(encoding="utf-8")

    assert LEGACY_RERANKER_PREFIX not in config_text
    assert LEGACY_RERANKER_PREFIX not in template_text
    assert "${REDIS_URL}:${REDIS_PORT}" not in config_text
    assert "KUBERNETES_MCP_TOKEN=" in template_text


def test_frontend_deployment_uses_canonical_service_urls():
    template_text = FRONTEND_DEPLOYMENT_TEMPLATE.read_text(encoding="utf-8")

    assert LEGACY_CLUSTER_LOCAL_PORT not in template_text


def test_production_skill_scripts_are_disabled():
    functions = _config()["functions"]
    assert functions["agent_skills_tool"]["allow_script_execution"] is False


def test_user_document_tool_contract_uses_username_collection_pair():
    desc = _config()["functions"]["user_document_tool"]["description"]
    assert "username" in desc
    assert "collection_name" in desc
    assert "Args: query, user_id" not in desc


def test_user_document_tool_is_decoupled_from_user_data_agent():
    functions = _config()["functions"]
    assert functions["user_data_agent"]["tool_names"] == [
        "gmail_mcp_server",
        "calendar_mcp_server",
    ]
    assert functions["user_document_agent"]["tool_names"] == ["user_document_tool"]
    assert "user_document_agent" in _config()["workflow"]["tool_names"]


def test_top_level_workflow_does_not_expose_unguarded_delete_memory():
    workflow_tools = _config()["workflow"]["tool_names"]
    assert "delete_memory" not in workflow_tools
    assert "user_interaction_tool" in workflow_tools


def test_deployed_tool_surface_is_optimized():
    forbidden_tools = {
        "think_tool",
        "image_generation_tool",
        "image_augmentation_tool",
        "image_comprehension_tool",
        "nv_ingest_tool",
        "user_uploaded_files_retriever_tool",
        "nvidia_retriever_tool",
        "semianalysis_retriever_tool",
        "kubernetes_retriever_tool",
        "veterinarian_retriever_tool",
        "mentalhealth_retriever_tool",
        "nvidia_blog_rss",
        "nvidia_developer_blog_rss",
        "nvidia_news_room_rss",
        "semianalysis_rss",
        "karpathy_bearblog_rss",
        "karpathy_github_rss",
    }

    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        functions = config["functions"]
        workflow_tools = config["workflow"]["tool_names"]
        assert not forbidden_tools & set(functions), path
        assert not forbidden_tools & set(workflow_tools), path

        # visual_media_tool is intentionally exposed at the top level and marked
        # return_direct so generated image refs are delivered without the
        # additional media-agent routing delay.
        assert _effective_operation_count(config, workflow_tools) <= 20, path
        assert (
            _effective_operation_count(
                config, functions["research_agent"]["tool_names"]
            )
            <= 15
        ), path
        assert (
            _effective_operation_count(
                config, functions["deep_research_agent"]["tool_names"]
            )
            <= 16
        ), path
        assert (
            _effective_operation_count(config, functions["ops_agent"]["tool_names"])
            <= 15
        ), path
        assert (
            _effective_operation_count(
                config, functions["nvidia_docs_agent"]["tool_names"]
            )
            <= 14
        ), path
        assert (
            _effective_operation_count(
                config, functions["user_data_agent"]["tool_names"]
            )
            <= 10
        ), path
        assert (
            _effective_operation_count(
                config, functions["daily_summary_agent"]["tool_names"]
            )
            <= 10
        ), path


def test_tool_calling_agents_use_resilient_runner():
    agent_names = [
        "research_agent",
        "deep_research_agent",
        "nvidia_docs_agent",
        "ops_agent",
        "daily_summary_agent",
        "user_document_agent",
        "user_data_agent",
    ]
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert config["workflow"]["_type"] == "tool_calling_agent_resilient", path
        for name in agent_names:
            assert (
                config["functions"][name]["_type"] == "tool_calling_agent_resilient"
            ), (path, name)


def test_nvidia_docs_agent_exposes_configured_docs_servers():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        agent = config["functions"]["nvidia_docs_agent"]
        tools = set(agent["tool_names"])
        source_registry = config["functions"]["source_policy_tool"]["source_registry"]
        nvidia_docs = next(
            source for source in source_registry if source["id"] == "nvidia_docs"
        )

        assert "aistore_mcp_server" in config["function_groups"], path
        assert "aistore_mcp_server" in tools, path
        assert "AIStore" in agent["description"], path
        assert "AIStore -> aistore_mcp_server" in agent["system_prompt"], path
        assert "AIStore" in nvidia_docs["description"], path


def test_return_direct_tools_are_exposed_to_their_agents():
    expected = {
        "workflow": [
            "user_interaction_tool",
            "visual_media_tool",
            "daily_summary_agent",
        ],
        "deep_research_agent": ["research_plan_approval_tool"],
        "ops_agent": ["ops_confirmation_tool"],
    }
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_tools = set(config["workflow"]["tool_names"])
        for tool_name in expected["workflow"]:
            assert tool_name in workflow_tools, path
        assert config["workflow"]["return_direct"] == expected["workflow"], path

        deep_research_agent = config["functions"]["deep_research_agent"]
        deep_tools = set(deep_research_agent["tool_names"])
        for tool_name in expected["deep_research_agent"]:
            assert tool_name in deep_tools, path
        assert (
            deep_research_agent["return_direct"] == expected["deep_research_agent"]
        ), path

        ops_agent = config["functions"]["ops_agent"]
        ops_tools = set(ops_agent["tool_names"])
        for tool_name in expected["ops_agent"]:
            assert tool_name in ops_tools, path
        assert ops_agent["return_direct"] == expected["ops_agent"], path


def test_visual_media_tool_is_direct_return_for_latency():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_tools = set(config["workflow"]["tool_names"])
        return_direct = set(config["workflow"]["return_direct"])

        assert "visual_media_tool" in workflow_tools, path
        assert "visual_media_tool" in return_direct, path


def test_vtt_interpreter_tool_is_top_level_and_not_return_direct():
    """Transcripts are handled by a top-level leaf tool (no media_agent hop), and
    its output is NOT return_direct so the agent can act on it (e.g. draft a
    follow-up) in the same turn."""
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_tools = set(config["workflow"]["tool_names"])
        return_direct = set(config["workflow"].get("return_direct", []))

        assert "vtt_interpreter_tool" in workflow_tools, path
        assert "vtt_interpreter_tool" not in return_direct, path
        # The retired media_agent sub-agent must be gone entirely.
        assert "media_agent" not in config["functions"], path
        assert "media_agent" not in workflow_tools, path


def test_user_data_agent_does_not_advertise_unconfigured_gmail_writes():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        user_data = config["functions"]["user_data_agent"]
        exposed_ops = set(_effective_operations(config, "gmail_mcp_server"))
        text = (
            user_data.get("description", "") + "\n" + user_data.get("system_prompt", "")
        ).lower()

        assert "create_draft" not in exposed_ops, path
        assert "draft" not in text, path


def test_google_workspace_mcp_uses_per_user_oauth():
    expected = {
        "gmail_mcp_server": {
            "server_url": "https://gmailmcp.googleapis.com/mcp/v1",
            "auth_server_url": "https://gmailmcp.googleapis.com/mcp",
            "scopes": {
                "https://www.googleapis.com/auth/gmail.readonly",
            },
            "include": [
                "search_threads",
                "get_thread",
                "list_labels",
            ],
        },
        "calendar_mcp_server": {
            "server_url": "https://calendarmcp.googleapis.com/mcp/v1",
            "auth_server_url": "https://calendarmcp.googleapis.com/mcp/v1",
            "scopes": {
                "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
                "https://www.googleapis.com/auth/calendar.events.readonly",
                "https://www.googleapis.com/auth/calendar.events.freebusy",
            },
            "include": [
                "list_calendars",
                "list_events",
                "get_event",
                "suggest_time",
            ],
        },
    }

    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        auth = config["authentication"]
        function_groups = config["function_groups"]
        workflow_tools = config["workflow"]["tool_names"]
        user_data_tools = config["functions"]["user_data_agent"]["tool_names"]

        assert "gmail_mcp_server" not in workflow_tools, path
        assert "calendar_mcp_server" not in workflow_tools, path
        assert "gmail_mcp_server" in user_data_tools, path
        assert "calendar_mcp_server" in user_data_tools, path

        for name, values in expected.items():
            provider = auth[name]
            assert provider["_type"] == "mcp_oauth2", path
            assert provider["server_url"] == values["auth_server_url"], path
            assert provider["client_id"] == "${GOOGLE_MCP_CLIENT_ID}", path
            assert provider["client_secret"] == "${GOOGLE_MCP_CLIENT_SECRET}", path
            assert provider["redirect_uri"] == "${GOOGLE_MCP_REDIRECT_URI}", path
            assert provider["enable_dynamic_registration"] is False, path
            assert provider["allow_default_user_id_for_tool_calls"] is False, path
            assert set(provider["scopes"]) == values["scopes"], path

            group = function_groups[name]
            assert group["include"] == values["include"], path
            assert group["server"]["auth_provider"] == name, path
            assert group["server"]["url"] == values["server_url"], path


def test_interactive_extensions_are_enabled_for_mcp_oauth():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert config["general"]["front_end"]["enable_interactive_extensions"] is True


def test_restricted_nginx_allows_oauth_redirect_callback():
    template = NGINX_TEMPLATE.read_text(encoding="utf-8")
    callback_location = "location = /auth/redirect"
    direct_api_block = (
        "location ~ ^/(v1|generate|chat|evaluate|upload|tools|health|auth)/"
    )

    assert callback_location in template
    assert direct_api_block in template
    assert template.index(callback_location) < template.index(direct_api_block)
    assert "proxy_pass {{ ._backendDefaultUpstream }};" in template


def test_restricted_nginx_cilium_policy_allows_oauth_callback_upstream():
    template = CILIUM_NGINX_TEMPLATE.read_text(encoding="utf-8")

    assert "Restricted mode still needs this for the exact" in template
    assert "app.kubernetes.io/component: backend-default" in template
    assert "{{- if not .Values.nginx.config.restrictedMode }}" not in template


def test_backend_trusts_nginx_forwarded_proto_for_oauth_callback():
    for path in (HELM_VALUES, CUSTOM_VALUES):
        values = yaml.safe_load(path.read_text(encoding="utf-8"))
        overrides = values["backend"]["default"]["env"]["overrides"]
        assert overrides["FORWARDED_ALLOW_IPS"] == "*", path


def test_backend_network_policy_uses_explicit_namespace_access():
    template = NETWORK_POLICY_BACKEND_TEMPLATE.read_text(encoding="utf-8")

    assert "Allow traffic from the same namespace" not in template
    assert "extraIngressNamespaces" in template
    assert "extraEgressNamespaces" in template
    assert "{{- if not .Values.backend.networkPolicy.cilium.enabled }}" in template


def test_cilium_backend_policy_exposes_extra_namespace_access():
    template = CILIUM_BACKEND_TEMPLATE.read_text(encoding="utf-8")

    assert "extraIngressNamespaces" in template
    assert "extraEgressNamespaces" in template
    assert "io.kubernetes.pod.namespace: {{ .name | quote }}" in template


def test_internal_api_token_is_injected_into_frontend_and_backend():
    for path in (BACKEND_DEPLOYMENT_TEMPLATE, FRONTEND_DEPLOYMENT_TEMPLATE):
        template = path.read_text(encoding="utf-8")
        assert "DAEDALUS_INTERNAL_API_TOKEN" in template, path
        assert '-internal-api" (include "daedalus.fullname" .)' in template, path


def test_backend_security_context_defaults_to_non_root():
    values = yaml.safe_load(HELM_VALUES.read_text(encoding="utf-8"))
    security_context = values["backend"]["default"]["securityContext"]

    assert security_context["runAsNonRoot"] is True
    assert security_context["runAsUser"] != 0
    assert security_context["runAsGroup"] != 0


def test_multi_operation_tools_are_filtered_in_production():
    expected = {
        "agent_skills_tool": ["load_skill"],
        "content_distiller_tool": ["distill_content"],
        "citation_auditor_tool": ["audit_citations"],
        "mas_optimizer_tool": ["mas_evaluate"],
        "ops_confirmation_tool": ["confirm_action"],
        "research_plan_approval_tool": ["confirm_research_plan"],
        "source_policy_tool": ["plan_sources"],
        "source_verifier_tool": ["verify_claim"],
        "user_interaction_tool": [
            "clarify",
            "confirm_action",
            "delete_memory_guarded",
        ],
    }
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        for tool_name, operations in expected.items():
            assert _effective_operations(config, tool_name) == operations, path


def test_serpapi_documented_aliases_are_configured():
    desc = _config()["functions"]["serpapi_search_tool"]["description"]
    assert "search_type (organic, news, images, shopping)" in desc


def test_research_agents_use_serpapi_as_only_internet_search_provider():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        research_agent = config["functions"]["research_agent"]
        deep_research_agent = config["functions"]["deep_research_agent"]
        functions = config["functions"]
        research_tools = research_agent["tool_names"]
        deep_tools = deep_research_agent["tool_names"]

        assert "exa_internet_search_tool" not in functions, path
        assert "exa_internet_search_tool" not in research_tools, path
        assert "exa_internet_search_tool" not in deep_tools, path
        assert "serpapi_search_tool" in research_tools, path
        assert "serpapi_search_tool" in deep_tools, path
        assert research_tools.index("curated_feed_search_tool") < research_tools.index(
            "serpapi_search_tool"
        ), path
        source_registry = functions["source_policy_tool"]["source_registry"]
        assert {source["id"] for source in source_registry}.isdisjoint(
            {"semantic_web"}
        ), path
        assert all(
            "exa_internet_search_tool" not in source.get("tools", [])
            for source in source_registry
        ), path

        prompt = research_agent["system_prompt"]
        deep_prompt = deep_research_agent["system_prompt"]
        assert "exa_internet_search_tool" not in prompt, path
        assert "exa_internet_search_tool" not in deep_prompt, path
        assert "only internet search provider" in prompt, path


def test_source_verifier_fast_llm_has_no_unsupported_extra_args():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        fast_llm_name = config["functions"]["source_verifier_tool"]["fast_llm_name"]
        fast_llm = config["llms"][fast_llm_name]
        assert "extra_args" not in fast_llm, path


def test_async_frontend_uses_process_dask_workers():
    for path in DEPLOYED_CONFIGS:
        assert _config(path)["general"]["front_end"]["dask_workers"] == "processes"


def test_top_level_workflow_exposes_source_verifier_when_add_memory_requires_it():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        add_memory_desc = config["functions"]["add_memory"]["description"]
        if "source_verifier_tool.verify_claim" in add_memory_desc:
            assert "source_verifier_tool" in config["workflow"]["tool_names"], path


def test_mas_evaluate_uses_effective_routing_domains_not_global_tool_catalog():
    expected = (
        'active_tool_names="research_agent,deep_research_agent,'
        'nvidia_docs_agent,ops_agent,user_document_agent,user_data_agent"'
    )
    forbidden = "nvidia_retriever_tool,semianalysis_retriever_tool"
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        assert expected in prompt, path
        assert forbidden not in prompt, path


def test_direct_specialist_routing_precedes_generic_mas_gate():
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        assert "Direct specialist requests" in prompt, path
        assert "MAS candidate requests" in prompt, path
        assert prompt.index("Direct specialist requests") < prompt.index(
            "MAS candidate requests"
        ), path


def test_daily_briefing_routes_to_raw_html_before_visual_media():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        visual_media_desc = config["functions"]["visual_media_tool"]["description"]

        assert "Daily briefing" in prompt, path
        assert "set top_k=12" in prompt, path
        assert "daedalus-feed nv-html weather" in prompt, path
        assert "Direct specialist requests" in prompt, path
        assert prompt.index("Daily briefing") < prompt.index(
            "Direct specialist requests"
        ), path
        assert "call daily_summary_agent" in normalized_prompt, path
        assert "Return the tool output" in prompt, path
        assert 'agent_skills_tool.load_skill("nv-html")' in prompt, path
        assert "memory-derived local weather and logistics" in prompt, path
        assert "read-only operations status" in normalized_prompt, path
        assert "teams, leagues, and events found in memory" in normalized_prompt, path
        assert "raw HTML only: one renderable HTML" in normalized_prompt, path
        assert '`<article class="daedalus-feed"`' in prompt, path
        assert "Do not call visual_media_tool for" in normalized_prompt, path
        assert (
            "daily briefings unless the user explicitly asks" in normalized_prompt
        ), path
        assert "Never use this tool for a" in visual_media_desc, path
        assert "daily summary or daily briefing" in visual_media_desc, path
        assert "Saline" not in prompt, path
        assert "Yankees" not in prompt, path
        assert "Steelers" not in prompt, path


def test_daily_summary_agent_contracts_raw_nv_html_fragment():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        daily = config["functions"]["daily_summary_agent"]
        prompt = daily["system_prompt"]
        tools = set(daily["tool_names"])

        assert daily["_type"] == "tool_calling_agent_resilient", path
        assert "daily_summary_agent" in config["workflow"]["tool_names"], path
        assert "daily_summary_agent" in config["workflow"]["return_direct"], path
        assert "visual_media_tool" not in tools, path
        assert "current_datetime_tool" in tools, path
        assert "get_memory" in tools, path
        assert "agent_skills_tool" in tools, path
        assert "user_data_agent" in tools, path
        assert "ops_agent" in tools, path
        assert "curated_feed_search_tool" in tools, path
        assert "serpapi_search_tool" in tools, path

        assert "Call current_datetime_tool first" in prompt, path
        assert "Call get_memory with top_k=12" in prompt, path
        assert "daedalus-feed nv-html weather" in prompt, path
        assert "personalization source of truth" in prompt, path
        assert "Do not fall back to hardcoded names" in prompt, path
        assert "Build a memory profile" in prompt, path
        assert 'agent_skills_tool.load_skill("nv-html")' in prompt, path
        assert "Calendar: call user_data_agent" in prompt, path
        assert "Operations: call ops_agent" in prompt, path
        assert "Weather and logistics: call serpapi_search_tool" in prompt, path
        assert "Sports and live events: call serpapi_search_tool" in prompt, path
        assert "curated_feed_search_tool" in prompt, path
        assert "raw HTML only" in prompt, path
        assert (
            '<article class="daedalus-feed" aria-label="Daily Summary">' in prompt
        ), path
        assert "Do not return Markdown" in prompt, path
        assert "fenced code" in prompt, path
        assert "<img>" in prompt, path
        assert "Stop after returning the single HTML fragment" in prompt, path
        assert "Brandon" not in prompt, path
        assert "Saline" not in prompt, path
        assert "Yankees" not in prompt, path
        assert "Steelers" not in prompt, path


def test_source_policy_metadata_is_propagated_to_research_agents():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_prompt = config["workflow"]["system_prompt"]
        research_prompt = config["functions"]["research_agent"]["system_prompt"]
        deep_prompt = config["functions"]["deep_research_agent"]["system_prompt"]

        assert "[SOURCE_POLICY]" in workflow_prompt, path
        assert "enabled_source_ids" in workflow_prompt, path
        assert "source_policy_tool.plan_sources" in research_prompt, path
        assert "selected_sources_json" in research_prompt, path
        assert "disabled_sources_json" in deep_prompt, path
        assert "require_deep_research_plan_approval" in deep_prompt, path


def test_workflow_runs_get_memory_first_unconditionally():
    # get_memory must be the first action on every turn, with no exceptions
    # (greetings and direct-specialist routing included). This replaces the
    # prior "direct specialists skip get_memory" carve-out, which contradicted
    # the session-start memory requirement and let get_memory be skipped.
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        assert "get_memory FIRST" in prompt, path
        assert "No exceptions" in prompt, path
        assert "without get_memory" not in prompt, path


def test_research_agent_rejects_stale_curated_memory_store_alias():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        research_agent = config["functions"]["research_agent"]

        assert "curated_memory_store" not in research_agent["tool_names"], path
        assert "curated_memory_store" in research_agent["system_prompt"], path
        assert "domain_retriever_tool" in research_agent["system_prompt"], path
        assert (
            "never call curated_memory_store" in research_agent["system_prompt"]
        ), path


def test_mas_optimizer_description_exposes_skill_name_contract():
    for path in DEPLOYED_CONFIGS:
        desc = _config(path)["functions"]["mas_optimizer_tool"]["description"]
        assert "skill_name" in desc, path
        assert "matched_signals" in desc, path


def test_skill_routing_precedes_generic_mas_gate():
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        assert prompt.index("Skill-routed substantive requests") < prompt.index(
            "Other substantive requests"
        ), path
        assert "open PRs" in prompt, path
        assert "merged PR listings/history" in prompt, path
        assert "pr-monitor" in prompt, path


def test_nat_coding_agent_skills_are_available_and_routed():
    guide = AGENTS_GUIDE.read_text(encoding="utf-8")
    assert "skills/nat-user-rules/SKILL.md" in guide

    for skill_name in NAT_CODING_AGENT_SKILLS:
        assert (SKILLS_DIR / skill_name / "SKILL.md").is_file(), skill_name

    # The orchestrator prompt routes the focused nat-* docs skills through
    # nat-user-rules rather than enumerating each one, to keep the skill list
    # lean. So the prompt names only the entry points (nat-user-rules,
    # skill-evolution) plus the routing rule; the focused nat-* skills are
    # reached via nat-user-rules, and their availability is asserted on disk
    # above.
    prompt_named_nat_skills = {"nat-user-rules", "skill-evolution"}
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        for skill_name in prompt_named_nat_skills:
            assert skill_name in prompt, (path, skill_name)
        assert "load nat-user-rules first" in prompt, path
        assert "workflow YAML, custom functions/tools" in prompt, path


def test_memory_findings_require_supported_exact_claims():
    for path in DEPLOYED_CONFIGS:
        functions = _config(path)["functions"]
        add_memory_desc = functions["add_memory"]["description"]
        verifier_desc = functions["source_verifier_tool"]["description"]
        assert "exact final memory sentence" in add_memory_desc, path
        assert "store only if verdict=supported" in add_memory_desc, path
        assert "do not store" in add_memory_desc, path
        assert "exact final claim" in verifier_desc, path
        assert "speculative candidate claims" in verifier_desc, path
        assert "version-specific release note alone is not proof" in verifier_desc, path


def test_memory_verification_prompt_limits_failed_retries():
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        assert "at most one targeted retry" in prompt, path
        assert "placeholder URLs" in prompt, path


def test_backend_system_prompts_follow_prompt_guidance_shape():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompts = {"workflow": config["workflow"]["system_prompt"]}
        prompts.update(
            {
                name: data["system_prompt"]
                for name, data in config["functions"].items()
                if isinstance(data, dict) and "system_prompt" in data
            }
        )

        assert set(prompts) == PROMPT_GUIDANCE_RUNTIME_PROMPTS, path
        for name, prompt in prompts.items():
            assert "Role:" in prompt, (path, name)
            assert "Goal" in prompt, (path, name)
            assert "Output" in prompt, (path, name)
            assert "stop" in prompt.lower(), (path, name)


def test_hardcoded_builder_prompts_follow_prompt_guidance_shape():
    root = Path(__file__).resolve().parents[2]
    for relative_path in PROMPT_GUIDANCE_CODE_SURFACES:
        text = (root / relative_path).read_text(encoding="utf-8")
        assert "Role:" in text, relative_path
        assert "Goal" in text, relative_path
        assert "Output" in text, relative_path


def test_identity_control_messages_match_backend_memory_contract():
    root = Path(__file__).resolve().parents[2]
    surfaces = (
        root / "frontend" / "pages" / "api" / "chat" / "async.ts",
        root / "evals" / "runner.py",
    )
    for surface in surfaces:
        text = surface.read_text(encoding="utf-8")
        assert "[IDENTITY]" in text, surface
        assert "delete_memory_guarded" in text, surface
        assert "delete_memory)" not in text, surface
        assert "Do not echo this identity message" in text, surface
