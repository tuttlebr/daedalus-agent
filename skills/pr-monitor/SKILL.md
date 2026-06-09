---
name: pr-monitor
description: Use for read-only GitHub pull request status summaries, including open PR lists, recent merged PRs, PR history, checks overview, and concise repository PR monitoring.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# PR Monitor

Use this skill when the user asks for a read-only pull request status summary, open PR list, recent merged PRs, PR history, or a repository PR monitoring update.

## Workflow

1. Verify GitHub CLI availability and authentication with `gh auth status`.
2. Resolve the repository from the current working directory unless the user names a repository.
3. For open PR summaries, run:

```bash
gh pr list --state open --limit 20 --json number,title,author,headRefName,baseRefName,isDraft,reviewDecision,mergeStateStatus,updatedAt,url
```

4. For recent merged PRs, run:

```bash
gh pr list --state merged --limit 10 --json number,title,author,mergedAt,url
```

5. For a specific PR, run:

```bash
gh pr view <number-or-url> --json number,title,author,state,isDraft,reviewDecision,mergeStateStatus,headRefName,baseRefName,createdAt,updatedAt,mergedAt,url,comments,reviews,statusCheckRollup
```

6. Summarize the result without mutating repository state.

## Output

- Lead with the requested PR status or history.
- Include PR numbers, titles, authors, URLs, and dates when available.
- Separate blocked, needs-review, failing-checks, draft, and mergeable PRs when summarizing open work.
- If authentication, network, or repository context is missing, report the exact blocker and the command needed to resolve it.

## Constraints

- Do not create, merge, close, label, approve, comment on, or edit PRs.
- Do not fetch full logs unless the user asks about failing checks; use the CI-fix skill for debugging or fixing CI failures.
- Do not address review comments; use the PR-comment skill for review-thread remediation.
