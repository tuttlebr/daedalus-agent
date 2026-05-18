"""Contract checks between backend YAML and custom tool signatures."""

from pathlib import Path

import yaml

CONFIG = Path(__file__).resolve().parents[2] / "backend" / "tool-calling-config.yaml"
HELM_CONFIG = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "files"
    / "tool-calling-config.yaml"
)
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
HELM_VALUES = Path(__file__).resolve().parents[2] / "helm" / "daedalus" / "values.yaml"
CUSTOM_VALUES = Path(__file__).resolve().parents[2] / "custom-values.yaml"
DEPLOYED_CONFIGS = (CONFIG, HELM_CONFIG)
MULTI_OPERATION_TYPES = {
    "agent_skills": ["list_skills", "load_skill", "run_skill_script"],
    "content_distiller": ["distill_content", "extract_structured", "synthesize"],
    "mas_optimizer": ["mas_evaluate", "mas_verify", "mas_log_outcome"],
    "rss_feed": ["rss_feed_search", "search_rss"],
    "source_verifier": ["verify_claim", "verify_memory", "audit_memories"],
    "user_interaction": [
        "clarify",
        "confirm_action",
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


def test_helm_backend_config_stays_in_sync_with_repo_backend():
    assert HELM_CONFIG.read_text(encoding="utf-8") == CONFIG.read_text(encoding="utf-8")


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
    ]
    for copy_instruction in runtime_copies:
        copy_lines = [
            i for i, line in enumerate(lines) if line.strip() == copy_instruction
        ]
        assert copy_lines
        assert max(copy_lines) < chmod_line

    assert "mkdir -p /workspace/.tmp" in "\n".join(lines)
    assert "chmod 1777 /workspace/.tmp" in "\n".join(lines)


def test_production_skill_scripts_are_disabled():
    functions = _config()["functions"]
    assert functions["agent_skills_tool"]["allow_script_execution"] is False


def test_user_document_tool_contract_uses_username_collection_pair():
    desc = _config()["functions"]["user_document_tool"]["description"]
    assert "username" in desc
    assert "collection_name" in desc
    assert "Args: query, user_id" not in desc


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

        assert _effective_operation_count(config, workflow_tools) <= 14, path
        assert (
            _effective_operation_count(
                config, functions["research_agent"]["tool_names"]
            )
            <= 7
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
            _effective_operation_count(config, functions["media_agent"]["tool_names"])
            <= 2
        ), path
        assert (
            _effective_operation_count(
                config, functions["user_data_agent"]["tool_names"]
            )
            <= 10
        ), path


def test_tool_calling_agents_use_resilient_runner():
    agent_names = [
        "research_agent",
        "nvidia_docs_agent",
        "ops_agent",
        "media_agent",
        "user_data_agent",
    ]
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert config["workflow"]["_type"] == "tool_calling_agent_resilient", path
        for name in agent_names:
            assert (
                config["functions"][name]["_type"] == "tool_calling_agent_resilient"
            ), (path, name)


def test_return_direct_tools_are_exposed_to_their_agents():
    expected = {
        "workflow": ["user_interaction_tool"],
        "ops_agent": ["ops_confirmation_tool"],
    }
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_tools = set(config["workflow"]["tool_names"])
        for tool_name in expected["workflow"]:
            assert tool_name in workflow_tools, path
        assert config["workflow"]["return_direct"] == expected["workflow"], path

        ops_agent = config["functions"]["ops_agent"]
        ops_tools = set(ops_agent["tool_names"])
        for tool_name in expected["ops_agent"]:
            assert tool_name in ops_tools, path
        assert ops_agent["return_direct"] == expected["ops_agent"], path


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


def test_multi_operation_tools_are_filtered_in_production():
    expected = {
        "agent_skills_tool": ["load_skill"],
        "content_distiller_tool": ["distill_content"],
        "curated_feed_search_tool": ["search_rss"],
        "mas_optimizer_tool": ["mas_evaluate"],
        "ops_confirmation_tool": ["confirm_action"],
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
        'active_tool_names="research_agent,nvidia_docs_agent,ops_agent,'
        'media_agent,user_data_agent"'
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
        assert "without get_memory or mas_evaluate" in prompt, path


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


def test_mas_procedure_has_bounded_execution_budget():
    skill = (SKILLS_DIR / "mas-procedure" / "SKILL.md").read_text(encoding="utf-8")
    assert "Global Execution Budget" in skill
    assert "Stop after 8 external retrieval/search/scrape calls" in skill
    assert "use AMD as the default semiconductor competitor" in skill
    assert "one targeted search" in skill
