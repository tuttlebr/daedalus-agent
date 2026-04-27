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
DEPLOYED_CONFIGS = (CONFIG, HELM_CONFIG)


def _config(path=CONFIG):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_production_skill_scripts_are_disabled():
    functions = _config()["functions"]
    assert functions["agent_skills_tool"]["allow_script_execution"] is False


def test_user_document_retriever_contract_uses_username_collection_pair():
    desc = _config()["functions"]["user_uploaded_files_retriever_tool"]["description"]
    assert "username" in desc
    assert "collection_name" in desc
    assert "Args: query, user_id" not in desc


def test_top_level_workflow_does_not_expose_unguarded_delete_memory():
    workflow_tools = _config()["workflow"]["tool_names"]
    assert "delete_memory" not in workflow_tools
    assert "user_interaction_tool" in workflow_tools


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
