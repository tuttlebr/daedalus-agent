"""Contract checks between backend YAML and custom tool signatures."""

from pathlib import Path

import yaml

CONFIG = Path(__file__).resolve().parents[2] / "backend" / "tool-calling-config.yaml"


def _config():
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))


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
