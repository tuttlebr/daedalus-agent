# OpenAI GPT-5 Prompting Best Practices

Prompt engineering techniques for OpenAI GPT-5 models (gpt-5, gpt-5.1, gpt-5.2). These models are trained for precise instruction following.

---

## Basic Text Generation

```python
from openai import OpenAI
client = OpenAI()

response = client.responses.create(
    model="gpt-5.2",
    input="Write a one-sentence bedtime story about a unicorn."
)
print(response.output_text)
```

**Important**: The `output` array can contain tool calls, reasoning tokens, and other items — it is not safe to assume the model's text is at `output[0].content[0].text`. Use the `output_text` property on responses (available in official SDKs) to safely aggregate all text output.

---

## Choosing a Model

- **Reasoning models** (o-series): internal chain of thought, excel at complex multi-step planning — slower and more expensive
- **GPT models** (gpt-5): fast, cost-efficient, highly intelligent — benefit from more explicit instructions
- **Large vs. small (mini/nano)**: large models better at complex tasks; small models faster and cheaper

When in doubt, `gpt-4.1` offers solid intelligence, speed, and cost.

**Pinning for production**: Use specific model snapshots (for example, `gpt-4.1-2025-04-14`) and build evals to monitor prompt performance across model upgrades.

---

## Message Roles and Instruction Following

Use the `instructions` parameter for high-level behavior (tone, goals, examples) — takes priority over `input`:

```python
response = client.responses.create(
    model="gpt-5",
    reasoning={"effort": "low"},
    instructions="Talk like a pirate.",
    input="Are semicolons optional in JavaScript?",
)
```

Or use message roles:

| Role | Purpose |
|---|---|
| `developer` | Application developer instructions, highest priority |
| `user` | End user input |
| `assistant` | Model-generated messages |

Think of `developer` messages as function definitions and `user` messages as arguments.

**Note**: The `instructions` parameter only applies to the current request — it is not preserved across turns when using `previous_response_id`.

---

## Developer Message Structure

A well-formed `developer` message typically contains (in order):

1. **Identity**: purpose, communication style, high-level goals
2. **Instructions**: rules, what to do and not do, function-calling guidance
3. **Examples**: sample inputs with desired outputs
4. **Context**: additional data, proprietary information, relevant background

Use Markdown headers for sections and XML tags to delineate content boundaries:

```
# Identity
You are a coding assistant that enforces snake_case variables in JavaScript.

# Instructions
* When defining variables, use snake_case (e.g. my_variable) instead of camelCase.
* Declare variables using `var` for IE6 compatibility.
* Return code only — no Markdown formatting.

# Examples
<user_query>
How do I declare a string variable for a first name?
</user_query>
<assistant_response>
var first_name = "Anna";
</assistant_response>
```

---

## Reusable Prompts

Create reusable prompts in the OpenAI dashboard with `{{variable}}` placeholders, then reference by ID:

```python
response = client.responses.create(
    model="gpt-5",
    prompt={
        "id": "pmpt_abc123",
        "version": "2",
        "variables": {
            "customer_name": "Jane Doe",
            "product": "40oz juice box"
        }
    }
)
```

Variables can also be files (`input_file`) or images (`input_image`).

**Prompt caching**: Keep stable content (instructions, examples) at the beginning of your prompt and among the first API parameters to maximize cache hits.

---

## Few-Shot Learning

Include input/output examples in the developer message to steer the model toward a new task:

```
# Identity
You label product reviews as Positive, Negative, or Neutral.

# Instructions
* Output only a single word with no additional formatting.

# Examples
<product_review id="example-1">
I love these headphones — sound quality is amazing!
</product_review>
<assistant_response id="example-1">
Positive
</assistant_response>

<product_review id="example-2">
Battery life is okay, but the ear pads feel cheap.
</product_review>
<assistant_response id="example-2">
Neutral
</assistant_response>
```

Use a **diverse range** of examples that reflect real-world inputs.

---

## GPT-5 Specific Best Practices

### Coding

- **Define an explicit role and workflow**: "You are a software engineering agent with well-defined responsibilities for using `functions.run`..."
- **Require testing and validation**: Instruct the model to test changes with unit tests; validate patches carefully since `apply_patch` may return "Done" even on failure
- **Provide tool use examples**: Concrete examples of how to invoke commands improve reliability
- **Markdown standards**: Clean markdown with inline code, code fences, lists, and tables

### Frontend Engineering

Recommended libraries for best results:
- **Styling/UI**: Tailwind CSS, shadcn/ui, Radix Themes
- **Icons**: Lucide, Material Symbols, Heroicons
- **Animation**: Motion

**Zero-to-one web apps** — GPT-5 generates from a single prompt:
```
You are a world class web developer capable of producing stunning, interactive websites in a single prompt.
Step 1: Create an evaluation rubric and refine it until fully confident.
Step 2: Create a <ONE_SHOT_RUBRIC> with 5–7 categories (internal use only).
Step 3: Apply the rubric to iterate on the optimal solution. Refine until it meets the highest standard.
Step 4: Aim for simplicity while fully achieving the goal. Avoid external dependencies like Next.js or React.
```

**Large codebase integration** — add these instruction categories: Principles, UI/UX, File Structure, Components, Pages, Agent Instructions.

### Agentic Tasks

```
Remember, you are an agent — keep going until the user's query is completely resolved before yielding back. Decompose the query into all required sub-requests and confirm each is completed. Only terminate your turn when you are sure the problem is solved.

Plan extensively before making function calls, and reflect on each outcome.
```

For transparency, ask the model to explain tool calls at notable steps:
```
Before you call a tool explain why you are calling it.
```

Use a TODO list tool or rubric to enforce structured planning.

---

## Reasoning Models (o-series)

Reasoning models differ from GPT models:
- **Reasoning model** = senior co-worker: give a goal, trust it to work out details
- **GPT model** = junior co-worker: needs explicit instructions for a specific output

High-level guidance works better for reasoning models. Avoid over-specifying.

---

## RAG and Context

To add proprietary data or constrain responses to specific sources, include it in the prompt as `<context>` sections:

```
<context>
[Your retrieved or proprietary data here]
</context>
```

Or use OpenAI's built-in file search tool for uploaded documents.

**Context window planning**: Models range from ~100k to 1M tokens. Structure prompts to place reusable content first for prompt caching benefits.
