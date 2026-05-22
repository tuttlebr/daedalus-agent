---
name: dep-status
description: List and filter Dynamo Enhancement Proposals (DEPs) on ai-dynamo/dynamo by status, area, PIC, or topic. Use whenever the user asks to "check DEP status", "list DEPs", "show open DEPs", "what DEPs are under review", "find DEPs about X", "DEP triage", "DEP backlog", "what's pending review", "DEPs assigned to <person>", "DEPs touching <component>", or wants a DEP status summary across one or more areas. Also use for cross-referencing DEPs by area label or finding related DEPs by keyword.
---

# Skill: Check DEP Status

> **Related skills:** `dep-create` (file a new DEP), `dep-update` (move DEPs through their lifecycle).

## Purpose

List DEP issues with their current status, area, PIC, and approval
state. Find related DEPs for a given topic or component.

## When to Use

When the user wants to see the status of one or more DEPs, check what's
pending review, find DEPs related to a component, or get a triage
summary.

## Workflow

1. **List open DEP issues**:

```bash
gh issue list --repo ai-dynamo/dynamo \
  --search 'label:"dep:draft","dep:under-review","dep:approved","dep:implementing"' \
  --json number,title,labels,assignees,createdAt,updatedAt
```

2. **Filter by area** (if requested). `gh` `--label` is AND when
   passed multiple times:

```bash
# Single area
gh issue list --repo ai-dynamo/dynamo \
  --label "<area>" \
  --json number,title,labels,assignees,createdAt,updatedAt

# Multiple areas in EITHER (OR semantics): run once per area and
# dedupe in jq. Note: a DEP can carry multiple area labels — a single
# issue may legitimately appear in two area filters; dedupe by number.
```

3. **Filter by status** (if requested). Combine with area via repeated
   `--label`:

```bash
# Status only
gh issue list --repo ai-dynamo/dynamo \
  --label "dep:<status>" \
  --json number,title,labels,assignees

# Status + area combined (AND): for "open DEPs under-review touching
# router"
gh issue list --repo ai-dynamo/dynamo \
  --label "dep:under-review" --label "router" \
  --json number,title,labels,assignees,createdAt,updatedAt
```

4. **Compute age and flag stale DEPs.** When the user asks about
   triage / backlog / "what's pending", compute days since
   `updatedAt` and flag entries older than a threshold (default
   14 days, but honor any value the user supplies):

```bash
THRESHOLD_DAYS=14
gh issue list --repo ai-dynamo/dynamo \
  --label "dep:under-review" \
  --json number,title,labels,assignees,updatedAt \
  --jq --arg t "$THRESHOLD_DAYS" '
    map(. + {age_days: (((now - (.updatedAt | fromdate)) / 86400) | floor)})
    | map(. + {stale: (.age_days | tonumber) > ($t | tonumber)})
  '
```

5. **Format as a summary table.** Include Age and a stale marker when
   a threshold was applied or the user asked about backlog:

```text
| # | Title | Status | Area | PIC | Updated | Age (d) | Stale? |
|---|-------|--------|------|-----|---------|---------|--------|
| 42 | DEP: KV router scheduling | dep:under-review | router | @alice | 2026-03-28 | 18 | ⚠ |
| 47 | DEP: Scheduler async streams | dep:under-review | scheduler | @bob | 2026-05-04 | 4 |  |
```

PIC comes from `.assignees[0].login`; if multiple assignees, render
them comma-separated and treat the first as the lead PIC. If
`assignees` is empty, show `unassigned`.

6. **Find related DEPs** by searching issue titles and bodies:

```bash
gh issue list --repo ai-dynamo/dynamo \
  --search 'DEP <keyword> label:"dep:draft","dep:under-review","dep:approved","dep:implementing","dep:done"' \
  --json number,title,labels,state
```

7. **Include closed DEPs** if requested:

```bash
gh issue list --repo ai-dynamo/dynamo \
  --state closed \
  --search 'label:"dep:done","dep:deferred","dep:rejected","dep:replaced"' \
  --json number,title,labels,assignees,closedAt
```

## Notes

- For a full triage view, include both open and recently closed DEPs.
- Cross-reference with `dep:lightweight` label to distinguish full vs.
  lightweight DEPs.
- Area labels are bare names (e.g., `frontend`, `router`) — no prefix.
