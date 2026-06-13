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
AUTONOMOUS_AGENT_DEPLOYMENT_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "autonomous-agent-worker.yaml"
)
HELM_VALUES = Path(__file__).resolve().parents[2] / "helm" / "daedalus" / "values.yaml"
CUSTOM_VALUES = Path(__file__).resolve().parents[2] / "custom-values.yaml"
DEPLOYED_CONFIGS = (CONFIG,)
PROMPT_GUIDANCE_RUNTIME_PROMPTS = {
    "workflow",
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


def _walk_mapping_keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _walk_mapping_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_mapping_keys(child)


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
        i for i, line in enumerate(lines) if line.strip() == "RUN chmod -R a+rX \\"
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


def test_user_document_and_workspace_tools_are_direct_workflow_tools():
    workflow_tools = _config()["workflow"]["tool_names"]
    assert "user_document_tool" in workflow_tools
    assert "gmail_mcp_server" in workflow_tools
    assert "calendar_mcp_server" in workflow_tools


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

        removed_router_tool = "mas" + "_optimizer_tool"
        assert removed_router_tool not in functions, path
        assert removed_router_tool not in workflow_tools, path
        assert _effective_operation_count(config, workflow_tools) <= 48, path


def test_workflow_uses_single_tool_calling_agent_schema():
    removed_agent_names = [
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
        workflow = config["workflow"]
        # tool_calling_agent seeds the agent graph with the full inbound message
        # list. The retired responses_api_agent took a single input string, so
        # NAT collapsed the request to messages[-1].content and dropped all prior
        # turns -- chat history was never reaching the LLM. The Responses API is
        # only supported via responses_api_agent, so the agent LLM must use Chat
        # Completions (api_type omitted/chat_completions) to pair with this agent.
        assert (
            config["llms"]["tool_calling_llm"].get("api_type", "chat_completions")
            != "responses"
        ), path
        assert workflow["_type"] == "tool_calling_agent", path
        assert "tool_names" in workflow, path
        assert "nat_tools" not in workflow, path
        # max_history bounds how many recent messages stay in the prompt each
        # turn (trim_messages strategy="last"); it must keep enough that in-chat
        # history survives well beyond the latest turn.
        assert workflow.get("max_history", 0) >= 50, path
        assert not set(removed_agent_names) & set(config["functions"]), path


def test_openai_llms_use_tool_calling_compatible_parameters():
    expected = {
        "tool_calling_llm": {"priority": 9, "osl": 2048},
        "default_llm": {"priority": 8, "osl": 1024},
    }
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert set(config["llms"]) == set(expected), path
        for llm_name, params in expected.items():
            llm = config["llms"][llm_name]
            assert llm["_type"] == "openai", (path, llm_name)
            assert llm.get("api_type", "chat_completions") != "responses", (
                path,
                llm_name,
            )
            assert "temperature" not in llm, (path, llm_name)
            assert "top_p" not in llm, (path, llm_name)
            assert "extra_args" not in llm, (path, llm_name)
            assert (
                llm["extra_body"]["nvext"]["agent_hints"]["priority"]
                == params["priority"]
            ), (path, llm_name)
            assert llm["extra_body"]["nvext"]["agent_hints"]["osl"] == params["osl"], (
                path,
                llm_name,
            )
            assert llm["extra_body"]["nvext"]["cache_control"]["ttl"] == "120m", (
                path,
                llm_name,
            )


def test_backend_config_omits_unsupported_sampling_parameters():
    unsupported = {"temperature", "top_p"}
    for path in DEPLOYED_CONFIGS:
        keys = set(_walk_mapping_keys(_config(path)))
        assert keys.isdisjoint(unsupported), path


def test_workflow_exposes_configured_nvidia_docs_servers():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        tools = set(config["workflow"]["tool_names"])
        source_registry = config["functions"]["source_policy_tool"]["source_registry"]
        nvidia_docs = next(
            source for source in source_registry if source["id"] == "nvidia_docs"
        )

        assert "aistore_mcp_server" in config["function_groups"], path
        assert "aistore_mcp_server" in tools, path
        assert "AIStore" in nvidia_docs["description"], path
        assert "aistore_mcp_server" in nvidia_docs["tools"], path


def test_responses_api_workflow_exposes_required_leaf_tools():
    expected = [
        "user_interaction_tool",
        "visual_media_tool",
        "current_datetime_tool",
        "source_policy_tool",
        "research_plan_approval_tool",
        "ops_confirmation_tool",
        "domain_retriever_tool",
        "curated_feed_search_tool",
        "perplexity_search_tool",
        "webscrape_tool",
        "content_distiller_tool",
        "user_document_tool",
        "gmail_mcp_server",
        "calendar_mcp_server",
    ]
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_tools = set(config["workflow"]["tool_names"])
        for tool_name in expected:
            assert tool_name in workflow_tools, path


def test_visual_media_tool_is_top_level():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_tools = set(config["workflow"]["tool_names"])

        assert "visual_media_tool" in workflow_tools, path


def test_vtt_interpreter_tool_is_top_level():
    """Transcripts are handled by a top-level leaf tool (no media_agent hop), and
    its output can be acted on by the workflow in the same turn."""
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_tools = set(config["workflow"]["tool_names"])

        assert "vtt_interpreter_tool" in workflow_tools, path
        # The retired media_agent sub-agent must be gone entirely.
        assert "media_agent" not in config["functions"], path
        assert "media_agent" not in workflow_tools, path


def test_workflow_does_not_advertise_unconfigured_gmail_writes():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        exposed_ops = set(_effective_operations(config, "gmail_mcp_server"))
        text = config["workflow"]["system_prompt"].lower()

        assert "create_draft" not in exposed_ops, path
        assert "create draft" not in text, path
        assert "create_draft" not in text, path


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
            },
            "include": [
                "list_calendars",
            ],
        },
    }

    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        auth = config["authentication"]
        function_groups = config["function_groups"]
        workflow_tools = config["workflow"]["tool_names"]

        assert "gmail_mcp_server" in workflow_tools, path
        assert "calendar_mcp_server" in workflow_tools, path

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
            assert group["auth_flow_timeout"] >= 600, path


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


def test_nginx_v1_streaming_timeout_covers_google_oauth_wait():
    template = NGINX_TEMPLATE.read_text(encoding="utf-8")
    v1_start = template.index("location /v1/")
    generate_start = template.index("location /generate/", v1_start)
    v1_block = template[v1_start:generate_start]

    assert "proxy_send_timeout 600s;" in v1_block
    assert "proxy_read_timeout 600s;" in v1_block


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


def test_internal_api_token_is_injected_into_frontend_backend_and_autonomy():
    for path in (
        BACKEND_DEPLOYMENT_TEMPLATE,
        FRONTEND_DEPLOYMENT_TEMPLATE,
        AUTONOMOUS_AGENT_DEPLOYMENT_TEMPLATE,
    ):
        template = path.read_text(encoding="utf-8")
        assert "DAEDALUS_INTERNAL_API_TOKEN" in template, path
        assert '-internal-api" (include "daedalus.fullname" .)' in template, path


def test_autonomous_worker_env_overrides_cannot_shadow_internal_token():
    template = AUTONOMOUS_AGENT_DEPLOYMENT_TEMPLATE.read_text(encoding="utf-8")

    assert 'ne $key "DAEDALUS_INTERNAL_API_TOKEN"' in template


def test_backend_security_context_defaults_to_non_root():
    values = yaml.safe_load(HELM_VALUES.read_text(encoding="utf-8"))
    security_context = values["backend"]["default"]["securityContext"]

    assert security_context["runAsNonRoot"] is True
    assert security_context["runAsUser"] != 0
    assert security_context["runAsGroup"] != 0


def test_multi_operation_tools_are_filtered_in_production():
    expected = {
        "agent_skills_tool": ["list_skills", "load_skill"],
        "content_distiller_tool": ["distill_content"],
        "citation_auditor_tool": ["audit_citations"],
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


def test_serpapi_search_tool_is_removed():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert "serpapi_search_tool" not in config["functions"], path
        assert "serpapi_search_tool" not in config["workflow"]["tool_names"], path


def test_perplexity_search_documented_filters_are_configured():
    desc = _config()["functions"]["perplexity_search_tool"]["description"]
    assert "PERPLEXITY_SEARCH_API_KEY" in desc
    assert "search_recency_filter (hour, day, week, month, year)" in desc


def test_workflow_uses_configured_internet_search_providers():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        functions = config["functions"]
        workflow_tools = config["workflow"]["tool_names"]

        assert "exa_internet_search_tool" not in functions, path
        assert "exa_internet_search_tool" not in workflow_tools, path
        assert "perplexity_search_tool" in workflow_tools, path
        assert workflow_tools.index("curated_feed_search_tool") < workflow_tools.index(
            "perplexity_search_tool"
        ), path
        source_registry = functions["source_policy_tool"]["source_registry"]
        assert {source["id"] for source in source_registry}.isdisjoint(
            {"semantic_web", "google_search"}
        ), path
        assert all(
            "exa_internet_search_tool" not in source.get("tools", [])
            and "serpapi_search_tool" not in source.get("tools", [])
            for source in source_registry
        ), path
        internet_sources = {
            source["id"]: source["tools"]
            for source in source_registry
            if source["id"] == "perplexity_search"
        }
        assert internet_sources == {
            "perplexity_search": ["perplexity_search_tool"],
        }, path

        prompt = config["workflow"]["system_prompt"]
        assert "exa_internet_search_tool" not in prompt, path
        assert "live search for current events" in " ".join(prompt.split()), path


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


def test_workflow_has_no_removed_architecture_router_references():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        config_text = Path(path).read_text(encoding="utf-8")
        removed_package = "mas" + "_optimizer"
        removed_operation = "mas" + "_evaluate"
        removed_tool = removed_package + "_tool"
        assert removed_package not in config_text, path
        assert removed_operation not in config_text, path
        assert removed_tool not in config["functions"], path
        assert removed_tool not in config["workflow"]["tool_names"], path


def test_direct_leaf_routing_is_configured():
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        assert "Routing after memory" in prompt, path
        assert (
            "Route directly to the relevant leaf capability" in normalized_prompt
        ), path
        assert "broad multi-source synthesis or exploration" in normalized_prompt, path
        assert "Do not invoke nested architecture routers" in normalized_prompt, path


def test_daily_briefing_routes_to_structured_response_without_visual_media():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        visual_media_desc = config["functions"]["visual_media_tool"]["description"]

        assert "Daily briefing" in prompt, path
        assert "broad enough memory result count" in prompt, path
        assert "daily briefing" in normalized_prompt, path
        assert "weather locale location" in normalized_prompt, path
        assert "Routing after memory" in prompt, path
        assert prompt.index("Daily briefing") < prompt.index(
            "Research and sources"
        ), path
        assert "Load the nv-html skill before final synthesis" in prompt, path
        assert "Return only a standalone NVIDIA HTML" in normalized_prompt, path
        assert "top-level HTML fragment" in prompt, path
        assert "no Markdown fence" in prompt, path
        assert "Weather/Local Logistics" in prompt, path
        assert "read-only operations status" in normalized_prompt, path
        assert "teams, leagues, events" in normalized_prompt, path
        assert "NVIDIA HTML" in prompt, path
        assert "HTML-only output" in prompt, path
        assert "Markdown is allowed" not in prompt, path
        assert "Do not require raw HTML" not in prompt, path
        assert "Produce a concise structured Markdown briefing directly" not in prompt
        assert (
            "Do not generate, edit, or analyze visual media" in normalized_prompt
        ), path
        assert (
            "daily briefings unless the user explicitly asks" in normalized_prompt
        ), path
        assert "daedalus-feed" not in prompt, path
        assert "nv-html" in prompt, path
        assert "Never use this tool for a" in visual_media_desc, path
        assert "daily summary or daily briefing" in visual_media_desc, path
        assert "Saline" not in prompt, path
        assert "Yankees" not in prompt, path
        assert "Steelers" not in prompt, path


def test_daily_summary_contracts_structured_briefing():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        tools = set(config["workflow"]["tool_names"])

        assert "visual_media_tool" in tools, path
        assert "current_datetime_tool" in tools, path
        assert "get_memory" in tools, path
        assert "agent_skills_tool" in tools, path
        assert "calendar_mcp_server" in tools, path
        assert "k8s_mcp_server" in tools, path
        assert "curated_feed_search_tool" in tools, path
        assert "perplexity_search_tool" in tools, path

        assert "call current date/time" in prompt, path
        assert "broad enough memory result count" in prompt, path
        assert "daily briefing" in prompt, path
        assert "weather locale location" in prompt, path
        assert "authenticated identity" in prompt, path
        assert "calendar" in prompt, path
        assert "read-only operations status" in prompt, path
        assert "recent feeds or live search" in normalized_prompt, path
        assert "Load the nv-html skill before final synthesis" in prompt, path
        assert "Return only a standalone NVIDIA HTML" in normalized_prompt, path
        assert "HTML-only output" in prompt, path
        assert "Markdown is allowed" not in prompt, path
        assert "Do not require raw HTML" not in prompt, path
        assert "concise structured Markdown briefing" not in normalized_prompt, path
        assert '<article class="daedalus-feed"' not in prompt, path
        assert "Next Best Actions" in normalized_prompt, path
        assert "Brandon" not in prompt, path
        assert "Saline" not in prompt, path
        assert "Yankees" not in prompt, path
        assert "Steelers" not in prompt, path


def test_source_policy_metadata_is_handled_by_workflow():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_prompt = config["workflow"]["system_prompt"]

        assert "[SOURCE_POLICY]" in workflow_prompt, path
        assert "enabled_source_ids" in workflow_prompt, path
        assert "disabled_source_ids" in workflow_prompt, path
        assert "max_research_tool_calls" in workflow_prompt, path
        assert "require_deep_research_plan_approval" in workflow_prompt, path


def test_workflow_runs_get_memory_first_unconditionally():
    # get_memory must be the first action on every turn, with no exceptions
    # (greetings and direct-specialist routing included). This replaces the
    # prior "direct specialists skip get_memory" carve-out, which contradicted
    # the session-start memory requirement and let get_memory be skipped.
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        assert "memory retrieval before any answer" in normalized_prompt, path
        assert "No exceptions" in normalized_prompt, path
        assert (
            "before any answer, route, skill load, or other capability call"
            in normalized_prompt
        ), path
        assert "without memory" not in prompt.lower(), path


def test_workflow_prompt_omits_configured_tool_identifiers():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]

        assert "curated_memory_store" not in config["workflow"]["tool_names"], path
        assert "curated_memory_store" not in prompt, path
        for tool_name in config["workflow"]["tool_names"]:
            assert tool_name not in prompt, (path, tool_name)


def test_skill_routing_precedes_other_substantive_requests():
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        assert prompt.index("Skill-routed substantive requests") < prompt.index(
            "Other substantive requests"
        ), path
        assert (
            "discover available skills when the exact skill is unknown"
            in normalized_prompt
        ), path
        assert "open PR summaries" in normalized_prompt, path
        assert "merged PR listings/history" in normalized_prompt, path
        assert "PR monitoring skill path" in normalized_prompt, path


def test_pr_monitor_skill_is_available_for_pr_routing():
    skill_path = SKILLS_DIR / "pr-monitor" / "SKILL.md"
    assert skill_path.is_file()
    text = skill_path.read_text(encoding="utf-8")
    assert "name: pr-monitor" in text
    assert "read-only GitHub pull request status summaries" in text
    assert (
        "Do not create, merge, close, label, approve, comment on, or edit PRs" in text
    )


def test_nat_coding_agent_skills_are_available_and_routed():
    guide = AGENTS_GUIDE.read_text(encoding="utf-8")
    assert "skills/nat-user-rules/SKILL.md" in guide

    for skill_name in NAT_CODING_AGENT_SKILLS:
        assert (SKILLS_DIR / skill_name / "SKILL.md").is_file(), skill_name

    # The orchestrator prompt routes toolkit work through the skill system
    # without hard-coding individual skill identifiers. Availability of the
    # focused nat-* skills is asserted on disk above.
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        assert "NeMo Agent Toolkit work" in normalized_prompt, path
        assert "load the toolkit entry skill first" in normalized_prompt, path
        assert "workflow YAML, custom functions/tools" in normalized_prompt, path
        assert "skill-governance guidance" in normalized_prompt, path


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


def test_explicit_memory_writes_do_not_require_confirmation():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]
        add_memory_desc = config["functions"]["add_memory"]["description"]
        ops_desc = config["functions"]["ops_confirmation_tool"]["description"]
        normalized_prompt = " ".join(prompt.split())

        assert "Explicit memory write" in prompt, path
        assert "stored directly without confirmation" in prompt, path
        assert "No approval is required" in prompt, path
        assert (
            "Do not use operational confirmation for memory creation"
            in normalized_prompt
        ), path
        assert "explicit user requests" in add_memory_desc, path
        assert "Never use for" in ops_desc, path
        assert "memory_update" in ops_desc, path


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
        assert 'explicit "remember" requests' in text, surface
        assert "delete_memory)" not in text, surface
        assert "Do not echo this identity message" in text, surface
