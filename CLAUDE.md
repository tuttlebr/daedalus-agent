# NeMo Agent Toolkit Agents Integration & Selection Rules

These rules standardise how the four built-in NeMo Agent Toolkit agents are configured inside YAML‐based workflows/functions and provide guidance for choosing the most suitable agent for a task.

## Referenced Documentation

- **ReAct Agent Docs**: [react-agent.md](mdc:docs/source/workflows/about/react-agent.md) – Configuration, prompt format and limitations.
- **Tool-Calling Agent Docs**: [tool-calling-agent.md](mdc:docs/source/workflows/about/tool-calling-agent.md) – Configuration, tool schema routing and limitations.
- **Reasoning Agent Docs**: [reasoning-agent.md](mdc:docs/source/workflows/about/reasoning-agent.md) – Configuration, wrapper semantics and limitations.
- **ReWOO Agent Docs**: [rewoo-agent.md](mdc:docs/source/workflows/about/rewoo-agent.md) – Configuration, planning/solver architecture and limitations.

## Integration Guidelines

1. **ReAct Agent**
   - Use `_type: react_agent` in either the top-level `workflow:` or inside `functions:`.
   - Always provide `tool_names` (list of YAML-defined functions or function groups) and `llm_name`.
   - Optional but recommended parameters: `verbose`, `max_tool_calls`, `parse_agent_response_max_retries`, `pass_tool_call_errors_to_agent`.
   - When overriding the prompt, keep `{tools}` and `{tool_names}` placeholders and ensure the LLM outputs in ReAct format.

2. **Tool-Calling Agent**
   - Use `_type: tool_calling_agent`.
   - Requires an LLM that supports function/tool calling (e.g. OpenAI, Nim chat-completion).
   - Mandatory fields: `tool_names`, `llm_name`.
   - Recommended fields: `verbose`, `handle_tool_errors`, `max_tool_calls`.
   - Tool input parameters must be well-named; the agent relies on them for routing.

3. **ReWOO Agent**
   - Use `_type: rewoo_agent`.
   - Provide `tool_names` and `llm_name`.
   - The agent executes a *planning* and then *solver* phase; advanced users may override `planner_prompt` or `solver_prompt` but must preserve required placeholders.
   - Use `include_tool_input_schema_in_tool_description: true` to improve tool disambiguation.

4. **Reasoning Agent**
   - Use `_type: reasoning_agent`.
   - Requires a *reasoning-capable* LLM (e.g. DeepSeek-R1) that supports `<think></think>` tags.
   - Mandatory fields: `llm_name`, `augmented_fn` (the underlying function/agent to wrap).
   - Optional fields: `verbose`, `reasoning_prompt_template`, `instruction_prompt_template`.
   - The `augmented_fn` must itself be defined in the YAML (commonly a ReAct or Tool-Calling agent).

## Selection Guidelines

Use this quick heuristic when deciding which agent best fits a workflow:

| Scenario | Recommended Agent | Rationale |
| --- | --- | --- |
| Simple, schema-driven tasks (single or few tool calls) | **Tool-Calling** | Lowest latency; leverages function-calling; no iterative reasoning needed |
| Multi-step tasks requiring dynamic reasoning between tool calls | **ReAct** | Iterative Think → Act → Observe loop excels at adaptive decision-making |
| Complex tasks where token/latency cost of ReAct is high but advance planning is beneficial | **ReWOO** | Plans once, then executes; reduces token usage vs. ReAct |
| Need to bolt an upfront reasoning/planning layer onto an existing agent or function | **Reasoning Agent** | Produces a plan that guides the wrapped function; separates planning from execution |

### Additional Tips

- If the LLM **does not** support function/tool calling, prefer **ReAct** or **ReWOO**.
- If up-front planning suffices and adaptability during execution is less critical, prefer **ReWOO** over **ReAct** for better token efficiency.
- When using **Reasoning Agent**, ensure the underlying `augmented_fn` itself can handle the planned steps (e.g., is a ReAct or Tool-Calling agent with relevant tools).
- For workflows that need parallel execution of independent tool calls, none of these agents currently offer built-in parallelism; consider splitting tasks or using custom orchestration.
```

## Architecture

### Service Stack
- **Frontend**: Next.js 14 with React 18, TypeScript, Tailwind CSS. Runs on port 5000. Uses edge runtime for API routes with 15-minute timeout for research tasks.
- **Backend Default**: NeMo Agent toolkit with tool-calling agent (GPT-OSS 120B via NVIDIA NIM)
- **Backend Deep Thinker**: NeMo Agent toolkit with ReAct agent (Claude Opus 4.5 via OpenRouter)
- **NGINX**: Reverse proxy with optional restricted mode blocking direct API access
- **Redis Stack**: Persistence for chat history, sessions, memory, and usage tracking (RedisJSON + RedisSearch)

### Directory Structure
- `backend/`: NAT YAML configurations (`tool-calling-config.yaml`, `react-agent-config.yaml`)
- `builder/`: 9 custom NAT function packages (image_generation, smart_milvus, webscrape, etc.)
- `frontend/`: Next.js app with `pages/api/` for API routes, `components/`, `services/`, `hooks/`
- `helm/`: Kubernetes Helm chart with dual backend support
- `nginx/`: Reverse proxy configuration

### Key Frontend Patterns
- API routes in `frontend/pages/api/` (main chat endpoint: `chat.ts`)
- State management via React Context (`home.context.tsx`, `home.state.tsx`)
- SSE streaming for real-time responses (`services/sse.ts`)
- Async job processing for PWA background execution

### Data Flow
1. User message → Frontend API (`/api/chat.ts`)
2. SSE streaming or async job processing
3. Routes to default or deep thinker backend based on mode
4. Agent orchestrates tools, retrieves context, generates response
5. Streams back with intermediate steps

## Configuration

- `.env`: Centralized secrets (NVIDIA_API_KEY, OpenRouter, SerpAPI keys). Never commit.
- `backend/*.yaml`: Agent configurations with tools, LLMs, retrievers, MCP servers
- `helm/daedalus/values.yaml`: Kubernetes deployment settings

## Terminology (from Cursor rules)

When writing documentation:
- First use: "NVIDIA NeMo Agent toolkit"
- Subsequent: "NeMo Agent toolkit"
- Abbreviations: "NAT" (comments, env vars), "nat" (CLI/API namespace), "nvidia-nat" (package)
- Never use deprecated names: Agent Intelligence toolkit, AgentIQ, AIQ, aiqtoolkit

## Code Standards

- Python: Type hints required for public APIs, use `snake_case` for functions/variables, `PascalCase` for classes
- Frontend: TypeScript with path alias `@/*` for imports
- Testing: Vitest for frontend, pytest for Python. Target ≥80% coverage.
- Formatting: Prettier (frontend), yapf with 120 column limit (Python)
- Pre-commit hooks configured for both frontend and builder code
