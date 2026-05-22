---
name: code-review
description: Perform a structured code review against a checklist covering correctness, security, performance, style, error handling, and testing. Each finding gets a severity rating (critical / warning / info) and a rationale. Use whenever the user asks to "review this code", "audit this PR", "look over this change", "check this for bugs", "review changes for production-readiness", "do a code review of <file/PR/branch>", or otherwise wants a structured pass over a diff or file with severity-tagged findings — as opposed to a quick scan or open-ended feedback.
---

# Code Review

Perform a structured code review by working through each category below. For every item, note whether it passes, fails, or is not applicable, and include a brief rationale. The condensed must-pass version of the checklist lives in `CHECKLIST.md` — consult it for fast triage.

## Quick Start

0. **Acquire the diff.** Don't review from memory or summary.
   - PR review: `gh pr view <N> --json files,title,body` and `gh pr diff <N>` (or `gh pr diff <N> --name-only` first to scope).
   - Branch review: `git diff <base>...HEAD` and read every changed file in full, not just hunks.
   - Local file: read the file end-to-end.
1. Read the code under review in full before making any judgments.
2. Walk through each checklist category below.
3. Summarise findings at the end with a severity rating (critical / warning / info).

Tag each finding `[verified]` when based on the diff you actually loaded, or `[assumed]` when you could not confirm (e.g. dependency behaviour, external API contracts).

## Checklist

### Correctness
- Does the code do what it claims to do?
- Are edge cases handled (empty inputs, nulls, overflow)?
- Are error paths tested and recoverable?

### Security
- Is user input validated and sanitised?
- Are secrets kept out of source control?
- Are dependencies up to date and free of known CVEs?

**Domain-specific lenses** — expand the security pass when the diff touches one of these areas:
- **Auth / crypto / JWT**: `alg` allowlist (no `none`, no asymmetric→symmetric confusion); `aud`, `iss`, `exp`, `nbf` validated; JWKS key rotation handled; tokens never logged; clock-skew leeway bounded; refresh-token rotation invalidates old.
- **SQL / ORM**: parameterized queries only; no string-concat with user input; no `raw()` on untrusted input.
- **Deserialization**: no `pickle`/`yaml.load`/`Marshal` on untrusted bytes; size limits; type allowlists.
- **File I/O / shell-out**: path traversal checks; no `shell=True` with user input; resolved paths confined under expected root.

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

| Category | Item | Status | Severity | Notes |
|----------|------|--------|----------|-------|
| Correctness | Edge cases | PASS / FAIL / N/A | critical / warning / info / — | `[verified]` or `[assumed]` + 1-line rationale |

Severity mapping:
- **critical** — exploitable, data-loss, breaks production correctness, or fails security domain-lens (auth/SQL/deserialization/shell).
- **warning** — production risk but not exploitable (perf regression, missing edge case behind a flag, brittle test).
- **info** — style, nit, or improvement opportunity that doesn't block merge.

End with a **Summary** section that lists total counts per severity AND a **Top fixes before merge** subsection listing critical + the highest-impact warnings (typically 3-5 items, sorted by severity then risk).
