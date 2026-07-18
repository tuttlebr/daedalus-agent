"""Contract checks between backend YAML and custom tool signatures."""

import ast
import re
import sys
import tomllib
from pathlib import Path
from urllib.parse import urlparse

import yaml

CONFIG = Path(__file__).resolve().parents[2] / "backend" / "tool-calling-config.yaml"
ENV_TEMPLATE = Path(__file__).resolve().parents[2] / ".env.template"
DOCKER_COMPOSE = Path(__file__).resolve().parents[2] / "docker-compose.yaml"
NAT_ENTRY_SKILL = (
    Path(__file__).resolve().parents[2] / "skills" / "nat-user-rules" / "SKILL.md"
)
SKILLS_DIR = Path(__file__).resolve().parents[2] / "skills"
DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"
DOCKERIGNORE = DOCKERFILE.parent / ".dockerignore"
RUNTIME_REQUIREMENTS = DOCKERFILE.parent / "requirements-runtime.in"
RUNTIME_OVERRIDES = DOCKERFILE.parent / "requirements-runtime-overrides.in"
NAT_NV_INGEST_SAMPLE_CONFIG = (
    DOCKERFILE.parent
    / "nat_nv_ingest"
    / "src"
    / "nat_nv_ingest"
    / "configs"
    / "config.yml"
)
WEBSCRAPE_SAMPLE_CONFIG = (
    DOCKERFILE.parent / "webscrape" / "src" / "webscrape" / "configs" / "config.yml"
)
RUNTIME_LOCKS = {
    "x86_64-unknown-linux-gnu": (DOCKERFILE.parent / "pylock.runtime-linux-amd64.toml"),
    "aarch64-unknown-linux-gnu": (
        DOCKERFILE.parent / "pylock.runtime-linux-arm64.toml"
    ),
}
NAT_COMMIT = "9d320c3645fe654cd68e59d0843ed7a294673a17"
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
NETWORK_POLICY_FRONTEND_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "networkpolicy-frontend.yaml"
)
CILIUM_BACKEND_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "cilium-backend.yaml"
)
CILIUM_FRONTEND_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "helm"
    / "daedalus"
    / "templates"
    / "cilium-frontend.yaml"
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
    "content_distiller": ["distill_content"],
    "source_verifier": [
        "verify_claim",
        "plan_sources",
        "audit_citations",
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


def _normalized_distribution_name(dependency: str) -> str:
    match = re.match(r"[A-Za-z0-9_.-]+", dependency)
    assert match, dependency
    return re.sub(r"[-_.]+", "-", match.group(0)).lower()


def _declared_runtime_dependencies(manifest: Path) -> set[str]:
    project = tomllib.loads(manifest.read_text(encoding="utf-8"))["project"]
    return {
        _normalized_distribution_name(dependency)
        for dependency in project.get("dependencies", [])
    }


def _imported_runtime_distributions(package_dir: Path) -> set[str]:
    builder_dir = DOCKERFILE.parent
    local_modules = {
        manifest.parent.name for manifest in builder_dir.glob("*/pyproject.toml")
    }
    local_modules.update(path.stem for path in builder_dir.glob("*.py"))
    import_to_distribution = {
        "langchain_core": "langchain-core",
        "nat": "nvidia-nat",
        "nv_ingest_client": "nv-ingest-client",
        "yaml": "pyyaml",
    }
    imported: set[str] = set()

    for source in (package_dir / "src").rglob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            module = None
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top_level = alias.name.split(".", 1)[0]
                    if (
                        top_level not in sys.stdlib_module_names
                        and top_level not in local_modules
                    ):
                        imported.add(import_to_distribution.get(top_level, top_level))
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                module = node.module.split(".", 1)[0]
            if (
                module
                and module not in sys.stdlib_module_names
                and module not in local_modules
            ):
                imported.add(import_to_distribution.get(module, module))

    return {_normalized_distribution_name(name) for name in imported}


def test_backend_dockerfile_assigns_runtime_files_to_non_root_user():
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    final_stage = dockerfile.split("FROM runtime_base AS backend", 1)[1]

    assert "COPY --from=build --chown=1000:1000 /workspace /workspace" in final_stage
    assert "COPY --from=skills --chown=1000:1000 . /skills" in final_stage
    permission_normalization = "find /workspace /skills ! -type l -exec chmod a+rX {} +"
    assert permission_normalization in final_stage
    assert (
        final_stage.index("--chown=1000:1000")
        < final_stage.index(permission_normalization)
        < final_stage.index("USER 1000:1000")
    )
    assert "chmod -R" not in final_stage
    assert "/workspace/.tmp" not in dockerfile


def test_backend_build_context_excludes_local_generated_metadata():
    dockerignore = DOCKERIGNORE.read_text(encoding="utf-8")

    assert ".venv/" in dockerignore
    assert "**/*.egg-info/" in dockerignore
    assert "**/__pycache__/" in dockerignore
    assert "tests/" in dockerignore


def test_local_packages_declare_every_direct_runtime_import():
    for manifest in sorted(DOCKERFILE.parent.glob("*/pyproject.toml")):
        imported = _imported_runtime_distributions(manifest.parent)
        declared = _declared_runtime_dependencies(manifest)
        assert imported <= declared, (
            manifest,
            f"undeclared direct imports: {sorted(imported - declared)}",
        )


def test_runtime_locks_cover_local_sources_nat_commit_and_registry_hashes():
    requirement_text = RUNTIME_REQUIREMENTS.read_text(encoding="utf-8")
    local_paths = {
        line.removeprefix("-e ./").strip()
        for line in requirement_text.splitlines()
        if line.startswith("-e ./")
    }
    assert local_paths

    for platform, lock_path in RUNTIME_LOCKS.items():
        lock_text = lock_path.read_text(encoding="utf-8")
        lock = tomllib.loads(lock_text)
        packages = lock["packages"]
        by_name = {package["name"]: package for package in packages}
        assert lock["lock-version"] == "1.0"
        assert f"--python-platform {platform}" in lock_text.splitlines()[1]
        assert (
            "--overrides requirements-runtime-overrides.in" in lock_text.splitlines()[1]
        )
        assert by_name["cryptography"]["version"] == "48.0.1"
        assert by_name["fastfeedparser"]["version"] == "0.5.10"
        assert by_name["pillow"]["version"] == "12.3.0"
        assert by_name["starlette"]["version"] == "1.3.1"
        assert by_name["urllib3"]["version"] == "2.7.0"
        assert by_name["nv-ingest-api"]["version"] == "26.3.0"
        assert by_name["nv-ingest-client"]["version"] == "26.3.0"
        assert "moviepy" not in by_name

        locked_local_paths = {
            package["directory"]["path"]
            for package in packages
            if "directory" in package
        }
        assert locked_local_paths == local_paths
        assert all(
            package["directory"].get("editable") is True
            for package in packages
            if "directory" in package
        )

        vcs_packages = [package for package in packages if "vcs" in package]
        assert vcs_packages
        assert all(package["name"].startswith("nvidia-nat") for package in vcs_packages)
        assert all(
            package["vcs"]["requested-revision"] == NAT_COMMIT
            and package["vcs"]["commit-id"] == NAT_COMMIT
            for package in vcs_packages
        )

        registry_packages = [
            package
            for package in packages
            if "directory" not in package and "vcs" not in package
        ]
        assert registry_packages
        for package in registry_packages:
            artifacts = []
            if "sdist" in package:
                artifacts.append(package["sdist"])
            artifacts.extend(package.get("wheels", []))
            if "archive" in package:
                artifacts.append(package["archive"])
            assert artifacts, package["name"]
            assert all(
                artifact.get("hashes", {}).get("sha256") for artifact in artifacts
            )


def test_backend_image_installs_only_from_frozen_runtime_locks():
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    final_stage = dockerfile.split("FROM runtime_base AS backend", 1)[1]

    assert "COPY pylock.runtime-linux-amd64.toml" in dockerfile
    assert "COPY pylock.runtime-linux-arm64.toml" in dockerfile
    assert "--require-hashes" in dockerfile
    assert "${TARGETARCH}" in dockerfile
    assert "Unsupported TARGETARCH" in dockerfile
    assert "git+https://github.com/NVIDIA/NeMo-Agent-Toolkit" not in dockerfile
    assert "nat workflow reinstall" not in dockerfile
    assert "FROM build AS base" in dockerfile

    assert "FROM runtime_base AS backend" in dockerfile
    assert "build-essential" not in final_stage
    assert "clang" not in final_stage
    assert " git" not in final_stage
    assert "COPY --from=uv_base" not in final_stage


def test_backend_config_env_placeholders_are_declared_in_template():
    config_text = CONFIG.read_text(encoding="utf-8")

    assert _env_placeholders(config_text) - _template_env_names() == set()


def test_backend_uses_owned_nat_front_end_runner():
    front_end = _config()["general"]["front_end"]

    assert (
        front_end["runner_class"]
        == "nat_helpers.front_end.DaedalusFastApiFrontEndPluginWorker"
    )


def test_backend_uses_registered_redis_acl_tls_memory_provider():
    memory = _config()["memory"]["redis_memory"]

    assert memory["_type"] == "daedalus_redis_memory"
    assert memory["username"] == "${REDIS_USERNAME}"
    assert memory["password"] == "${REDIS_PASSWORD}"
    assert memory["ssl"] == "${REDIS_TLS_ENABLED}"
    assert memory["ssl_ca_certs"] == "${REDIS_TLS_CA_FILE}"


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


def test_compose_frontend_forces_local_service_discovery():
    compose = yaml.safe_load(DOCKER_COMPOSE.read_text(encoding="utf-8"))
    environment = compose["services"]["frontend"]["environment"]

    assert "DEPLOYMENT_MODE=local" in environment


def test_production_skill_scripts_are_disabled():
    functions = _config()["functions"]
    assert functions["agent_skills_tool"]["allow_script_execution"] is False


def test_user_document_tool_contract_uses_trusted_identity_and_private_writes():
    desc = _config()["functions"]["user_document_tool"]["description"]
    assert "never pass username" in desc
    assert "rejects shared targets" in desc
    assert "Search may read" in desc


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
        assert workflow["_type"] == "daedalus_per_user_tool_calling_agent", path
        assert "tool_names" in workflow, path
        assert "nat_tools" not in workflow, path
        # max_history bounds how many recent messages stay in the prompt each
        # turn (trim_messages strategy="last"); it must keep enough that in-chat
        # history survives well beyond the latest turn.
        assert workflow.get("max_history", 0) >= 50, path
        assert not set(removed_agent_names) & set(config["functions"]), path


def test_openai_llms_use_tool_calling_compatible_parameters():
    expected = {"tool_calling_llm", "default_llm"}
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert set(config["llms"]) == expected, path
        for llm_name in expected:
            llm = config["llms"][llm_name]
            assert llm["_type"] == "openai", (path, llm_name)
            assert llm.get("api_type", "chat_completions") != "responses", (
                path,
                llm_name,
            )
            assert "temperature" not in llm, (path, llm_name)
            assert "top_p" not in llm, (path, llm_name)
            assert "extra_args" not in llm, (path, llm_name)
            assert "extra_body" not in llm, (path, llm_name)


def test_backend_config_omits_unsupported_sampling_parameters():
    unsupported = {"temperature", "top_p"}
    for path in DEPLOYED_CONFIGS:
        keys = set(_walk_mapping_keys(_config(path)))
        assert keys.isdisjoint(unsupported), path


def test_workflow_exposes_one_routed_nvidia_docs_capability():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        tools = set(config["workflow"]["tool_names"])
        source_registry = config["functions"]["source_verifier_tool"]["source_registry"]
        nvidia_docs = next(
            source for source in source_registry if source["id"] == "nvidia_docs"
        )

        legacy_groups = {
            "dynamo_mcp_server",
            "openshell_mcp_server",
            "aistore_mcp_server",
            "aiperf_mcp_server",
            "nvcf_mcp_server",
            "dsx_mcp_server",
        }
        assert not legacy_groups & set(config["function_groups"]), path
        assert not legacy_groups & tools, path
        assert config["functions"]["nvidia_docs_tool"]["_type"] == "nvidia_docs"
        assert "nvidia_docs_tool" in tools, path
        assert "AIStore" in nvidia_docs["description"], path
        assert nvidia_docs["tools"] == ["nvidia_docs_tool"], path


def test_responses_api_workflow_exposes_required_leaf_tools():
    expected = [
        "user_interaction_tool",
        "visual_media_tool",
        "current_datetime_tool",
        "source_verifier_tool",
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

            token_store_name = provider["token_storage_object_store"]
            expected_store_name = name.replace("_server", "_oauth_tokens")
            assert token_store_name == expected_store_name, path
            token_store = config["object_stores"][token_store_name]
            assert token_store == {
                "_type": "daedalus_redis_object_store",
                "redis_url": "${REDIS_URL}",
                "bucket_name": name.replace("_mcp_server", "-mcp-oauth"),
            }, path

            group = function_groups[name]
            assert group["_type"] == "per_user_mcp_client", path
            assert group["include"] == values["include"], path
            assert group["server"]["auth_provider"] == name, path
            assert group["server"]["url"] == values["server_url"], path
            assert group["auth_flow_timeout"] >= 600, path

        general = config["general"]
        assert general["per_user_workflow_timeout"] <= 600, path
        assert general["per_user_workflow_cleanup_interval"] <= 60, path
        assert general["enable_per_user_monitoring"] is False, path

        gmail_bucket = config["object_stores"]["gmail_mcp_oauth_tokens"]["bucket_name"]
        calendar_bucket = config["object_stores"]["calendar_mcp_oauth_tokens"][
            "bucket_name"
        ]
        assert gmail_bucket != calendar_bucket, path


def test_shared_api_key_mcp_auth_is_operator_managed():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        for name, env_name in (
            ("k8s_mcp_server", "KUBERNETES_MCP_TOKEN"),
            ("unifi_mcp_server", "UNIFI_MCP_TOKEN"),
        ):
            provider = config["authentication"][name]
            group = config["function_groups"][name]

            assert provider["_type"] == "api_key", path
            assert provider["auth_scheme"] == "Custom", path
            assert provider["custom_header_name"] == "Authorization", path
            assert provider["custom_header_prefix"] == "Bearer", path
            assert provider["raw_key"] == f"${{{env_name}}}", path
            assert group["_type"] == "mcp_client", path
            assert group["server"]["auth_provider"] == name, path


def test_interactive_extensions_are_enabled_for_mcp_oauth():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert config["general"]["front_end"]["enable_interactive_extensions"] is True


def test_restricted_nginx_allows_oauth_redirect_callback():
    template = NGINX_TEMPLATE.read_text(encoding="utf-8")
    callback_location = "location = /auth/redirect"
    direct_api_block = (
        "location ~ ^/(v1|generate|chat|evaluate|upload|tools|health|auth)(/|$)"
    )

    assert callback_location in template
    assert direct_api_block in template
    assert template.index(callback_location) < template.index(direct_api_block)
    callback_start = template.index(callback_location)
    callback_end = template.index("\n    }", callback_start)
    callback_block = template[callback_start:callback_end]
    assert "rewrite ^ /api/auth/redirect break;" in callback_block
    assert "proxy_pass {{ ._frontendHTTPUpstream }};" in callback_block


def test_restricted_nginx_cilium_policy_allows_oauth_callback_upstream():
    template = CILIUM_NGINX_TEMPLATE.read_text(encoding="utf-8")

    assert "Frontend (HTTP + WebSocket sidecar)" in template
    assert "app.kubernetes.io/component: frontend" in template
    assert "exact\n    # /auth/redirect OAuth callback proxy" not in template


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


def test_document_object_policies_share_in_cluster_and_external_settings():
    standard = (
        NETWORK_POLICY_BACKEND_TEMPLATE.read_text(encoding="utf-8"),
        NETWORK_POLICY_FRONTEND_TEMPLATE.read_text(encoding="utf-8"),
    )
    cilium = (
        CILIUM_BACKEND_TEMPLATE.read_text(encoding="utf-8"),
        CILIUM_FRONTEND_TEMPLATE.read_text(encoding="utf-8"),
    )

    for template in (*standard, *cilium):
        assert "daedalus.documentObjectNetworkMode" in template
        assert ".Values.documentObjectStorage.networkPolicy.namespace" in template
        assert ".Values.documentObjectStorage.networkPolicy.port" in template
        assert "documentObjectExternal" in template

    for template in standard:
        assert "$documentObjectExternal.cidrs" in template
        assert "ipBlock:" in template

    for template in cilium:
        assert "$documentObjectExternal.fqdnNames" in template
        assert "toFQDNs:" in template
        assert "document-objects-cidr" in template


def test_document_object_timeout_is_shared_by_upload_and_ingest_paths():
    backend = BACKEND_DEPLOYMENT_TEMPLATE.read_text(encoding="utf-8")
    frontend = FRONTEND_DEPLOYMENT_TEMPLATE.read_text(encoding="utf-8")
    compose = DOCKER_COMPOSE.read_text(encoding="utf-8")

    for template in (backend, frontend):
        assert "DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS" in template
        assert "daedalus.documentObjectRequestTimeoutMs" in template
    assert compose.count("- DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS=") == 2


def test_standard_and_cilium_web_egress_have_matching_ports_and_exclusions():
    standard = NETWORK_POLICY_BACKEND_TEMPLATE.read_text(encoding="utf-8")
    cilium = CILIUM_BACKEND_TEMPLATE.read_text(encoding="utf-8")
    exclusions = {
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
        "0.0.0.0/8",
        "100.64.0.0/10",
    }

    for cidr in exclusions:
        assert f"- {cidr}" in standard
        assert f"- {cidr}" in cilium

    assert "          port: 80" in standard
    assert "          port: 443" in standard
    assert '            - port: "80"' in cilium
    assert '            - port: "443"' in cilium


def test_backend_pod_resolves_external_mcp_hosts_before_search_suffixes():
    template = BACKEND_DEPLOYMENT_TEMPLATE.read_text(encoding="utf-8")

    assert "dnsPolicy: ClusterFirst" in template
    assert '- name: ndots\n            value: "1"' in template
    assert "- name: single-request-reopen" in template


def test_cilium_policy_allows_every_literal_external_mcp_hostname():
    config = _config()
    template = CILIUM_BACKEND_TEMPLATE.read_text(encoding="utf-8")
    external_hosts = set()

    for group in config["function_groups"].values():
        if group.get("_type") not in {"mcp_client", "per_user_mcp_client"}:
            continue
        url = str(group.get("server", {}).get("url", ""))
        if not url.startswith("https://"):
            continue
        host = urlparse(url).hostname
        if host:
            external_hosts.add(host)

    assert external_hosts
    for host in external_hosts:
        assert f'matchName: "{host}"' in template, host


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
        "source_verifier_tool": [
            "verify_claim",
            "plan_sources",
            "audit_citations",
        ],
        "user_interaction_tool": [
            "clarify",
            "confirm_action",
            "confirm_research_plan",
            "delete_memory_guarded",
        ],
    }
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        for tool_name, operations in expected.items():
            assert _effective_operations(config, tool_name) == operations, path


def test_perplexity_search_documented_filters_are_configured():
    desc = _config()["functions"]["perplexity_search_tool"]["description"]
    assert "PERPLEXITY_SEARCH_API_KEY" in desc
    assert "search_recency_filter (hour, day, week, month, year)" in desc


def test_llm_sandbox_tool_is_optional_top_level_tool():
    config = _config()
    functions = config["functions"]
    workflow_tools = config["workflow"]["tool_names"]
    template_text = ENV_TEMPLATE.read_text(encoding="utf-8")
    custom_values = yaml.safe_load(CUSTOM_VALUES.read_text(encoding="utf-8"))
    egress_namespaces = custom_values["backend"]["networkPolicy"][
        "extraEgressNamespaces"
    ]

    assert functions["llm_sandbox_tool"]["_type"] == "llm_sandbox"
    assert "llm_sandbox_tool" in workflow_tools
    assert "LLM_SANDBOX_API_KEY=" in template_text
    assert "LLM_SANDBOX_BASE_URL=" in template_text
    assert {"name": "llm-sandbox", "ports": [{"port": 8080, "protocol": "TCP"}]} in (
        egress_namespaces
    )


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
        source_registry = functions["source_verifier_tool"]["source_registry"]
        assert {source["id"] for source in source_registry}.isdisjoint(
            {"semantic_web", "google_search"}
        ), path
        assert all(
            "exa_internet_search_tool" not in source.get("tools", [])
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
        normalized_prompt = " ".join(prompt.split())
        assert "live data" in normalized_prompt, path
        assert "current, external" in normalized_prompt, path


def test_source_verifier_fast_llm_has_no_unsupported_extra_args():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        fast_llm_name = config["functions"]["source_verifier_tool"]["fast_llm_name"]
        fast_llm = config["llms"][fast_llm_name]
        assert "extra_args" not in fast_llm, path


def test_frontend_has_no_legacy_async_job_settings():
    for path in DEPLOYED_CONFIGS:
        front_end = _config(path)["general"]["front_end"]
        assert "workers" not in front_end
        assert "max_running_async_jobs" not in front_end
        assert not any(key.startswith("dask_") for key in front_end)


def test_runtime_omits_legacy_async_job_dependencies():
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    runtime_requirements = RUNTIME_REQUIREMENTS.read_text(encoding="utf-8")
    assert "aiosqlite" not in dockerfile
    assert "sqlalchemy[asyncio]" not in dockerfile
    # NAT's supported FastAPI runner imports SQLAlchemy's asyncio module even
    # when async job endpoints are disabled, so its missing transitive runtime
    # requirement must remain explicit.
    assert "greenlet>=3,<4" in runtime_requirements
    assert "cryptography>=48.0.1,<49" in runtime_requirements
    assert "fastfeedparser>=0.5.10,<0.6" in runtime_requirements
    assert "pillow>=12.2,<13" in runtime_requirements
    assert "starlette>=1.3.1,<2" in runtime_requirements
    assert "urllib3>=2.7,<3" in runtime_requirements
    assert "async_endpoints" not in dockerfile
    assert "dask" not in dockerfile.lower()
    assert "distributed" not in dockerfile.lower()

    overrides = {
        line.strip()
        for line in RUNTIME_OVERRIDES.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert overrides == {"cryptography>=48.0.1,<49", "urllib3>=2.7,<3"}

    for manifest in DOCKERFILE.parent.glob("*/pyproject.toml"):
        project = manifest.read_text(encoding="utf-8")
        if "nvidia-nat[" in project:
            assert "async_endpoints" not in project, manifest


def test_nv_ingest_sample_config_has_no_fallback_credentials_or_bind_addresses():
    raw = NAT_NV_INGEST_SAMPLE_CONFIG.read_text(encoding="utf-8")
    config = yaml.safe_load(raw)

    assert "minioadmin" not in raw
    assert "0.0.0.0" not in raw
    assert set(config["functions"]) == {"user_document_tool"}
    assert config["workflow"]["tool_names"] == ["user_document_tool"]


def test_webscrape_sample_config_has_no_scaffold_placeholder():
    config = yaml.safe_load(WEBSCRAPE_SAMPLE_CONFIG.read_text(encoding="utf-8"))

    assert config["workflow"] == {"_type": "webscrape"}


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
        assert "smallest sufficient set of tools" in normalized_prompt, path
        assert "Do not call multiple search or retrieval tools" in normalized_prompt
        assert (
            "Do not use the full research workflow for simple lookups"
            in normalized_prompt
        )


def test_daily_briefing_routes_to_structured_response_without_visual_media():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        visual_media_desc = config["functions"]["visual_media_tool"]["description"]

        assert "daily briefing" in normalized_prompt, path
        assert "retrieve relevant memory once" in normalized_prompt, path
        assert "get the current date and time" in normalized_prompt, path
        assert "load the nv-html skill" in normalized_prompt, path
        assert "follow its output contract" in normalized_prompt, path
        assert (
            "daily summary or daily briefing unless the user explicitly asks"
            in " ".join(visual_media_desc.split())
        ), path


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

        assert "daily briefing" in prompt, path
        assert "authenticated user" in prompt, path
        assert "current date and time" in normalized_prompt, path
        assert "load the nv-html skill" in normalized_prompt, path
        assert "follow its output contract" in normalized_prompt, path


def test_source_policy_metadata_is_handled_by_workflow():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        workflow_prompt = config["workflow"]["system_prompt"]

        assert "[SOURCE_POLICY]" in workflow_prompt, path
        assert "apply [SOURCE_POLICY] when present" in workflow_prompt, path
        assert "source_verifier_tool" in config["workflow"]["tool_names"], path


def test_workflow_retrieves_memory_only_when_it_can_help():
    for path in DEPLOYED_CONFIGS:
        prompt = _config(path)["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        assert (
            "Retrieve memory only when prior preferences, commitments, projects"
            in normalized_prompt
        ), path
        assert "could materially improve the answer" in normalized_prompt, path
        assert (
            "Do not call memory merely to resolve identity" in normalized_prompt
        ), path


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
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]
        normalized_prompt = " ".join(prompt.split())
        assert (
            "Load a skill when the user names it or when a specialized procedure"
            in normalized_prompt
        ), path
        assert "agent_skills_tool" in config["workflow"]["tool_names"], path


def test_pr_monitor_skill_is_available_for_pr_routing():
    skill_path = SKILLS_DIR / "pr-monitor" / "SKILL.md"
    assert skill_path.is_file()
    text = skill_path.read_text(encoding="utf-8")
    assert "name: pr-monitor" in text
    assert "read-only GitHub pull request status summaries" in text
    assert (
        "Do not create, merge, close, label, approve, comment on, or edit PRs" in text
    )


def test_repo_skill_manifests_are_discoverable():
    from agent_skills.skill_parser import SkillParser

    manifest_count = len(list(SKILLS_DIR.glob("*/SKILL.md")))
    parser = SkillParser(skills_directory=str(SKILLS_DIR))

    assert len(parser.discover_skills()) == manifest_count


def test_nat_coding_agent_skills_are_available_and_routed():
    guide = NAT_ENTRY_SKILL.read_text(encoding="utf-8")
    assert "name: nat-user-rules" in guide
    assert "## Task Routing" in guide

    for skill_name in NAT_CODING_AGENT_SKILLS:
        assert (SKILLS_DIR / skill_name / "SKILL.md").is_file(), skill_name

    # The entry skill, rather than the general workflow prompt, owns detailed
    # toolkit task routing. This keeps the per-request prompt compact.
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        assert "agent_skills_tool" in config["workflow"]["tool_names"], path


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
        assert "make one targeted retry" in prompt, path
        assert "Do not loop" in prompt, path


def test_explicit_memory_writes_do_not_require_confirmation():
    for path in DEPLOYED_CONFIGS:
        config = _config(path)
        prompt = config["workflow"]["system_prompt"]
        add_memory_desc = config["functions"]["add_memory"]["description"]
        interaction_desc = config["functions"]["user_interaction_tool"]["description"]

        assert "Store explicit memory requests without confirmation" in prompt, path
        assert "Require confirmation for deletion" in prompt, path
        assert "explicit user requests" in add_memory_desc, path
        assert "pending approval request" in interaction_desc, path


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
