# Claude 4.x Prompting Best Practices

Prompt engineering techniques for Claude 4.x models (Sonnet 4.5, Haiku 4.5, Opus 4.5). These models are trained for more precise instruction following than previous generations.

---

## General Principles

### Be Explicit
Claude 4.x responds well to clear, specific instructions. The "above and beyond" behavior of older models may need to be explicitly requested.

```
# Less effective
Create an analytics dashboard

# More effective
Create an analytics dashboard. Include as many relevant features and interactions as possible. Go beyond the basics to create a fully-featured implementation.
```

### Add Context and Motivation
Explaining *why* helps Claude generalize better:

```
# Less effective
NEVER use ellipses

# More effective
Your response will be read aloud by a text-to-speech engine, so never use ellipses since the engine will not know how to pronounce them.
```

### Watch Your Examples
Claude 4.x pays close attention to examples as part of precise instruction following. Ensure examples reflect the behavior you want to encourage.

---

## Long-Horizon Reasoning and State Tracking

Claude 4.5 excels at long-horizon tasks with exceptional state tracking. For agentic workflows:

### Context Window Management

```
Your context window will be automatically compacted as it approaches its limit, allowing you to continue working indefinitely. Do not stop tasks early due to token budget concerns. As you approach your token budget limit, save your current progress to memory before the context window refreshes. Always be as persistent and autonomous as possible.
```

### Multi-Context Window Workflows

1. **First context window**: set up framework (write tests, create setup scripts)
2. **Subsequent windows**: iterate on a todo-list using saved state

Best practices:
- Write tests in a structured format (`tests.json`) before starting work
- Create setup scripts (`init.sh`) to restart servers and run test suites
- Use git to track state across sessions
- Use structured JSON for task status; freeform text for progress notes

```json
{
  "tests": [
    {"id": 1, "name": "authentication_flow", "status": "passing"},
    {"id": 2, "name": "user_management", "status": "failing"}
  ]
}
```

```
Session 3 progress:
- Fixed authentication token validation
- Next: investigate user_management test failures (test #2)
```

---

## Guidance for Specific Situations

### Balance Verbosity

Claude 4.5 may skip verbal summaries after tool calls. To get updates:

```
After completing a task that involves tool use, provide a quick summary of the work you've done.
```

### Tool Usage Patterns

Be explicit when you want Claude to take action rather than suggest:

```
# Less effective (Claude will suggest)
Can you suggest some changes to improve this function?

# More effective (Claude will make changes)
Change this function to improve its performance.
```

To make Claude proactively take action by default:
```xml
<default_to_action>
By default, implement changes rather than only suggesting them. If the user's intent is unclear, infer the most useful likely action and proceed, using tools to discover any missing details instead of guessing.
</default_to_action>
```

To make Claude more conservative:
```xml
<do_not_act_before_instructions>
Do not jump into implementation or change files unless clearly instructed. When the user's intent is ambiguous, default to providing information and recommendations rather than taking action.
</do_not_act_before_instructions>
```

### Tool Triggering (Opus 4.5)

Opus 4.5 is more responsive to system prompts than previous models. If your prompts were designed to reduce under-triggering, Opus 4.5 may over-trigger. Dial back aggressive language:
- Instead of: "CRITICAL: You MUST use this tool when..."
- Use: "Use this tool when..."

### Controlling Response Format

1. Tell Claude what to do instead of what not to do:
   - Instead of: "Do not use markdown"
   - Try: "Your response should be composed of smoothly flowing prose paragraphs."

2. Use XML format indicators:
   ```
   Write the prose sections in <smoothly_flowing_prose_paragraphs> tags.
   ```

3. Match your prompt style to your desired output style.

4. For minimizing markdown:
```xml
<avoid_excessive_markdown_and_bullet_points>
When writing reports, documents, or technical explanations, write in clear flowing prose. Use paragraph breaks for organization. Reserve markdown for `inline code`, code blocks, and simple headings. Avoid **bold** and *italics*.

DO NOT use ordered or unordered lists unless presenting truly discrete items or the user explicitly requests a list. Instead, incorporate items naturally into sentences.
</avoid_excessive_markdown_and_bullet_points>
```

### Research and Information Gathering

For complex research tasks:
```
Search for this information in a structured way. Develop several competing hypotheses as you gather data. Track your confidence levels in your progress notes. Regularly self-critique your approach. Update a hypothesis tree or research notes file to persist information.
```

### Subagent Orchestration

Claude 4.5 can proactively delegate to subagents when beneficial. To control conservativeness:
```
Only delegate to subagents when the task clearly benefits from a separate agent with a new context window.
```

### Parallel Tool Calling

Claude 4.x excels at parallel execution. To maximize it:
```xml
<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between them, make all the independent calls in parallel. Maximize use of parallel tool calls where possible to increase speed and efficiency. Never use placeholders or guess missing parameters.
</use_parallel_tool_calls>
```

To reduce parallelism:
```
Execute operations sequentially with brief pauses between each step to ensure stability.
```

### Reducing File Creation

```
If you create any temporary new files, scripts, or helper files for iteration, clean them up by removing them at the end of the task.
```

### Avoiding Over-Engineering (Opus 4.5)

```
Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.

Don't add features, refactor code, or make "improvements" beyond what was asked. Don't add error handling for scenarios that can't happen. Don't create helpers or abstractions for one-time operations. Don't design for hypothetical future requirements.
```

### Frontend Design

```xml
<frontend_aesthetics>
Avoid the "AI slop" aesthetic. Make creative, distinctive frontends that surprise and delight.

Focus on:
- Typography: Choose beautiful, unique fonts. Avoid Arial and Inter.
- Color: Commit to a cohesive aesthetic. Use CSS variables. Dominant colors with sharp accents.
- Motion: Use CSS animations for micro-interactions. One well-orchestrated page load beats scattered effects.
- Backgrounds: Create atmosphere with gradients, geometric patterns, contextual effects.

Avoid: purple gradients on white backgrounds, Space Grotesk, predictable layouts.
</frontend_aesthetics>
```

### Code Exploration

```
ALWAYS read and understand relevant files before proposing code edits. Do not speculate about code you have not inspected. If the user references a specific file/path, you MUST open and inspect it first.
```

### Minimizing Hallucinations

```xml
<investigate_before_answering>
Never speculate about code you have not opened. If the user references a specific file, you MUST read it before answering. Make sure to investigate and read relevant files BEFORE answering questions. Never make claims about code before investigating — give grounded, hallucination-free answers.
</investigate_before_answering>
```

---

## Extended Thinking

For tasks requiring reflection after tool use or complex multi-step reasoning:
```
After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information.
```

**Thinking sensitivity (Opus 4.5 without extended thinking)**: Replace "think" with "consider," "believe," or "evaluate" to avoid unintended triggering.

---

## Model Self-Knowledge

```
The assistant is Claude, created by Anthropic. The current model is Claude Sonnet 4.5.
```

For apps needing specific model strings:
```
When an LLM is needed, default to Claude Sonnet 4.5. The exact model string is claude-sonnet-4-5-20250929.
```

---

## Migration from Previous Models

1. Be specific about desired behavior — describe exactly what you want in the output
2. Add modifiers to encourage quality: "Include as many relevant features as possible. Go beyond the basics."
3. Request specific features explicitly (animations, interactive elements)
