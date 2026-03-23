---
name: code-review
description: Perform structured code reviews with a checklist covering correctness, security, performance, and style. Use when asked to review code, audit a pull request, or check code quality.
---

# Code Review

Perform a structured code review by working through each category below. For every item, note whether it passes, fails, or is not applicable, and include a brief rationale.

## Quick Start

1. Read the code under review in full before making any judgments.
2. Walk through each checklist category below.
3. Summarise findings at the end with a severity rating (critical / warning / info).

## Checklist

### Correctness
- Does the code do what it claims to do?
- Are edge cases handled (empty inputs, nulls, overflow)?
- Are error paths tested and recoverable?

### Security
- Is user input validated and sanitised?
- Are secrets kept out of source control?
- Are dependencies up to date and free of known CVEs?

### Performance
- Are there unnecessary allocations or copies?
- Could any loops be replaced with vectorised or batch operations?
- Is caching used where appropriate?

### Readability & Style
- Are names descriptive and consistent with the project conventions?
- Is complex logic documented with comments explaining *why*, not *what*?
- Does the code follow the project's linter and formatter settings?

### Testing
- Are there unit tests covering the happy path and key edge cases?
- Do tests run in isolation without external dependencies?
- Is test coverage above the project target (>= 80%)?

## Output Format

Present your findings as a markdown table:

| Category | Item | Status | Notes |
|----------|------|--------|-------|
| Correctness | Edge cases | PASS / FAIL / N/A | ... |

End with a **Summary** section that lists the total counts and highlights any critical issues.
