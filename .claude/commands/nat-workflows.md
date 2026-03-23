# NeMo Agent Toolkit Workflow Development

Guides for creating NAT functions and adding tools to workflows.

---

## Creating Functions

Functions (also called tools) are the core building blocks of NAT workflow logic. All functions are async, type-safe, and registered via decorator.

### 1. Define the Configuration Class

Inherit from `nat.data_models.function.FunctionBaseConfig`. The `name` attribute is the unique `_type` identifier in YAML.

```python
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

class MyFunctionConfig(FunctionBaseConfig, name="my_function"):
    """Configuration for My Function."""
    greeting: str = Field("Hello", description="The greeting to use.")
    repeat_count: int = Field(1, description="Number of times to repeat.", gt=0)
```

### 2. Write the Function Logic

**Option A — Callable (recommended for simplicity)**

```python
async def _my_simple_function(message: str) -> str:
    """A simple function that returns a greeting."""
    return f"Hello, {message}"
```

Streaming variant:
```python
from typing import AsyncGenerator

async def _my_streaming_function(message: str) -> AsyncGenerator[str, None]:
    """A simple streaming function."""
    for i in range(3):
        yield f"Stream {i}: {message}"
```

**Option B — `Function` subclass (for complex state)**

```python
from nat.builder.function import Function
from typing import AsyncGenerator, NoneType

class MyComplexFunction(Function[str, str, str]):
    async def _ainvoke(self, value: str) -> str:
        return f"Single output: {value}"

    async def _astream(self, value: str) -> AsyncGenerator[str, None]:
        for i in range(3):
            yield f"Stream {i}: {value}"
```

### 3. Register the Function

Use `@register_function`. The registration function yields the callable or subclass instance. Define/import function logic *inside* the registration function to avoid premature loading.

**Registering a callable:**
```python
from nat.cli.register_workflow import register_function
from nat.builder.builder import Builder

@register_function(config_type=MyFunctionConfig)
async def register_my_function(config: MyFunctionConfig, builder: Builder):
    print("Initializing...")

    async def _my_function(message: str) -> str:
        """My function implementation."""
        return f"{config.greeting}, {message}" * config.repeat_count

    yield _my_function

    print("Cleaning up...")
```

**Registering a subclass:**
```python
@register_function(config_type=MyFunctionConfig)
async def register_my_complex_function(config: MyFunctionConfig, builder: Builder):
    from .my_module import MyComplexFunction
    yield MyComplexFunction(config=config)
```

### 4. Multiple Arguments

When a callable has multiple arguments, an input schema is auto-generated. Invoke with a dict.

```python
async def multi_arg_fn(text: str, count: int) -> str:
    return text * count

# Invoke as:
# await function.ainvoke({"text": "a", "count": 3})
```

### 5. Function Composition

Declare references with `FunctionRef` and retrieve instances via `builder.get_function()`.

```python
from nat.data_models.component_ref import FunctionRef

class MyCompositeConfig(FunctionBaseConfig, name="my_composite_function"):
    """Config for a composite function."""
    first_function: FunctionRef
    second_function: FunctionRef

@register_function(config_type=MyCompositeConfig)
async def register_composite_function(config: MyCompositeConfig, builder: Builder):
    func1 = await builder.get_function(config.first_function)
    func2 = await builder.get_function(config.second_function)

    async def _composite_function(data: str) -> str:
        res1 = await func1.ainvoke(data)
        return await func2.ainvoke(res1)

    yield _composite_function
```

### Advanced: Custom Schemas and Converters

Override input/output schemas via `FunctionInfo.from_fn`, or provide type converter functions via the `converters` argument:

```python
def my_converter(value: int) -> str:
    return f"Converted: {value}"

yield FunctionInfo.from_fn(_my_function, description="...", converters=[my_converter])
```

---

## Adding Tools to Workflows

### Step-by-Step Process

**1. Discover available tools**
```bash
nat info components -t function
nat info components -t function -q webpage_query
```

**2. Add to the `functions:` section of your config**

When adding multiple instances of the same type, use descriptive names:
```yaml
# Before
functions:
  webpage_query:
    _type: webpage_query
    webpage_url: https://docs.smith.langchain.com
    embedder_name: nv-embedqa-e5-v5
    chunk_size: 512

# After (two instances, renamed for clarity)
functions:
  langsmith_query:
    _type: webpage_query
    webpage_url: https://docs.smith.langchain.com
    description: "Search for information about LangSmith. For any questions about LangSmith, you must use this tool!"
    embedder_name: nv-embedqa-e5-v5
    chunk_size: 512
  langgraph_query:
    _type: webpage_query
    webpage_url: https://langchain-ai.github.io/langgraph/tutorials/introduction
    description: "Search for information about LangGraph. For any questions about LangGraph, you must use this tool!"
    embedder_name: nv-embedqa-e5-v5
    chunk_size: 512
```

**3. Update `workflow.tool_names`**
```yaml
# Before
workflow:
  _type: react_agent
  tool_names: [webpage_query, current_datetime]

# After
workflow:
  _type: react_agent
  tool_names: [langsmith_query, langgraph_query, current_datetime]
```

**4. Test**
```bash
nat run --config_file path/to/updated_config.yml --input "Test question"
```

### Common Tool Patterns

```yaml
# Webpage query
tool_name:
  _type: webpage_query
  webpage_url: https://example.com
  description: "When to use this tool"
  embedder_name: nv-embedqa-e5-v5
  chunk_size: 512

# Internet search (requires TAVILY_API_KEY)
internet_search:
  _type: tavily_internet_search

# Utility
current_datetime:
  _type: current_datetime
```

### Best Practices

- **Names**: Use specific names when multiple instances share a type (`langsmith_query` not `webpage_query`)
- **Descriptions**: Be explicit about when to use the tool; use imperative language ("For any questions about X, you must use this tool!")
- **Embedders**: Use consistent `embedder_name` across similar tools
- **Troubleshooting**: Tool not found = name mismatch between `functions:` key and `tool_names` entry

### Complete Example Config

```yaml
functions:
  langsmith_docs:
    _type: webpage_query
    webpage_url: https://docs.smith.langchain.com
    description: "Search for information about LangSmith. For any questions about LangSmith, you must use this tool!"
    embedder_name: nv-embedqa-e5-v5
    chunk_size: 512
  current_datetime:
    _type: current_datetime

llms:
  nim_llm:
    _type: nim
    model_name: meta/llama-3.1-70b-instruct
    temperature: 0.0

embedders:
  nv-embedqa-e5-v5:
    _type: nim
    model_name: nvidia/nv-embedqa-e5-v5

workflow:
  _type: react_agent
  tool_names: [langsmith_docs, current_datetime]
  llm_name: nim_llm
  verbose: true
  parse_agent_response_max_retries: 3
```
