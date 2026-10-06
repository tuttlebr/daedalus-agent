"""Exercise real tool schemas, invocation, lifecycle, and configuration."""

import asyncio

import pytest
from daedalus_runtime.config import load_config
from daedalus_runtime.tools import ToolConfig, ToolDefinition, ToolRegistry
from pydantic import BaseModel, Field, ValidationError


class NestedInput(BaseModel):
    count: int = Field(ge=1, le=4)


class TypedInput(BaseModel):
    nested: NestedInput
    label: str = "default"


def test_typed_invocation_preserves_nested_models_and_validates():
    async def run(input_data: TypedInput):
        assert isinstance(input_data.nested, NestedInput)
        return f"{input_data.label}:{input_data.nested.count}"

    tool = ToolDefinition.from_fn(run, input_schema=TypedInput)
    assert asyncio.run(tool.ainvoke({"nested": {"count": 2}})) == "default:2"
    with pytest.raises(ValidationError):
        asyncio.run(tool.ainvoke({"nested": {"count": 0}}))
    assert "$defs" in tool.schema("typed")["parameters"]


def test_keyword_tool_defaults_and_unknown_arguments():
    async def run(query: str, limit: int = 3):
        return query, limit

    tool = ToolDefinition.from_fn(run)
    assert asyncio.run(tool.ainvoke({"query": "hello"})) == ("hello", 3)
    assert tool.schema("query")["parameters"]["required"] == ["query"]
    with pytest.raises(ValidationError):
        asyncio.run(tool.ainvoke({"query": "hello", "secret_override": "bad"}))


def test_registry_initializes_once_and_closes_resources(monkeypatch):
    from daedalus_runtime import tools

    events = []

    class Config(ToolConfig, name="fixture"):
        pass

    async def factory(config, registry):
        events.append("open")

        async def call(value: int):
            return value + 1

        try:
            yield ToolDefinition.from_fn(call)
        finally:
            events.append("close")

    monkeypatch.setitem(tools._FACTORIES, "fixture", (Config, factory))

    async def exercise():
        registry = ToolRegistry({"functions": {"test": {"_type": "fixture"}}})
        first, second = await asyncio.gather(
            registry.get_function("test"), registry.get_function("test")
        )
        assert first is second
        assert await first.ainvoke({"value": 7}) == 8
        await registry.close()

    asyncio.run(exercise())
    assert events == ["open", "close"]


def test_config_inheritance_and_environment_is_data(tmp_path, monkeypatch):
    (tmp_path / "base.yaml").write_text(
        "workflow:\n  max_iterations: 10\n  tools: [a]\n"
    )
    path = tmp_path / "config.yaml"
    path.write_text(
        "base: base.yaml\nworkflow:\n  tools: [b]\nkey: ${TEST_RUNTIME_KEY}\n"
    )
    monkeypatch.setenv("TEST_RUNTIME_KEY", "secret: [not, yaml]\ninjected: true")
    config = load_config(path)
    assert config["workflow"] == {"max_iterations": 10, "tools": ["b"]}
    assert config["key"] == "secret: [not, yaml]\ninjected: true"
    assert "injected" not in config
    (tmp_path / "base.yaml").write_text("base: config.yaml\n")
    with pytest.raises(ValueError, match="Circular"):
        load_config(path)
