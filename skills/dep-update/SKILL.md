---
name: dep-update
description: Update Dynamo Enhancement Proposal (DEP) lifecycle state on ai-dynamo/dynamo — triage, assign PIC, move to review, approve, defer, close — including the PIC workflow and the /approve aggregation pattern. Use whenever the user wants to "approve a DEP", "move DEP to under-review", "assign PIC to DEP #N", "close DEP", "defer DEP", "update DEP status", "post /approve", "change DEP labels", "mark DEP as implementing/done/deferred/rejected", or otherwise progress a DEP through its lifecycle.
---

# Skill: Update DEP Lifecycle

> **Related skills:** `dep-create` (file a new DEP), `dep-status` (list and filter DEPs).

## Purpose

Update DEP status through its lifecycle — triage, review, approve,
defer, or close. Covers the PIC workflow from initial assignment
through final approval.

## When to Use

When triaging DEP issues, reviewing a DEP as PIC or reviewer,
approving a DEP that is under review, or updating DEP status.

## Workflow

### Triage (assign PIC)

1. **List unassigned DEPs**:

```bash
gh issue list --repo ai-dynamo/dynamo \
  --label "dep:draft" \
  --json number,title,labels,assignees \
  --jq '.[] | select(.assignees | length == 0)'
```

2. **Assign PIC** based on the area label:

```bash
gh issue edit <number> --repo ai-dynamo/dynamo \
  --add-assignee "<github-username>"
```

3. **Move to review** when the spec is ready:

```bash
gh issue edit <number> --repo ai-dynamo/dynamo \
  --remove-label "dep:draft" \
  --add-label "dep:under-review"
```

### Review

1. **Read the DEP issue and discussion**:

```bash
gh issue view <number> --repo ai-dynamo/dynamo
gh issue view <number> --repo ai-dynamo/dynamo --comments
```

2. **Post review feedback** as comments on the issue.

3. **Request changes** or clarifications from the author.

### Approve

1. **Verify the issue is under review**:

```bash
gh issue view <number> --repo ai-dynamo/dynamo --json labels
```

2. **Post the approval comment**:

```bash
gh issue comment <number> --repo ai-dynamo/dynamo --body "/approve"
```

3. **Transition the label — branch by reviewer count.** This step
   has two different gates depending on the DEP's review model:

   **Single-reviewer / PIC-only DEP** (most lightweight DEPs and area
   DEPs touching one CODEOWNERS team):

   ```bash
   gh issue edit <number> --repo ai-dynamo/dynamo \
     --remove-label "dep:under-review" \
     --add-label "dep:approved"
   ```

   **Multi-reviewer DEP** (touches multiple CODEOWNERS teams, or the
   PIC explicitly listed multiple required reviewers): the PIC
   maintains a pinned approval checklist comment. Transition the
   label only when **every** required reviewer has posted `/approve`
   (or has been aggregate-approved per the escalation rule below).

4. **Verify the transition succeeded**:

```bash
gh issue view <number> --repo ai-dynamo/dynamo --json labels
```

### Multi-reviewer aggregation

For DEPs with multiple required reviewers, the PIC drives convergence
via a **pinned approval checklist** posted as the first comment after
moving to `dep:under-review`. Template:

```markdown
**Required reviewers** (PIC: @<pic>)

- [ ] @reviewer-1 (area: router)
- [ ] @reviewer-2 (area: scheduler)
- [ ] @reviewer-3 (area: frontend)

PIC will aggregate `/approve` comments and transition the label when
all boxes are checked.
```

The PIC edits this comment to tick each box as reviewers post
`/approve`.

**Escalation when a reviewer is non-responsive.** Quiet periods are
common; aggregate-approval needs a documented escalation:

1. After **7 days** of no response from a required reviewer, post a
   ping comment tagging them: `@reviewer-N gentle nudge — this DEP
   has been waiting on your review since <date>.`
2. After **3 additional days** with no response (10 days total), the
   PIC may aggregate-approve on behalf of the non-responsive
   reviewer, documenting the elapsed window in a comment:

   ```
   /approve — aggregating on behalf of @reviewer-N after 10 days
   of no response since ping on <date>. Re-review can be requested
   by reopening.
   ```

   Then transition the label per step 3.

This pattern keeps audit history searchable
(`gh search issues --repo ai-dynamo/dynamo "aggregating on behalf of" in:comments`).

## Notes

- For straightforward DEPs, the PIC's `/approve` is sufficient.
- For multi-reviewer DEPs, follow the **Multi-reviewer aggregation**
  section above — do not transition the label until the pinned
  checklist is fully ticked or the escalation rule fires.
- `/approve` comments are searchable for audit:
  `gh search issues --repo ai-dynamo/dynamo "/approve" in:comments`
- Area labels are bare names (e.g., `frontend`, `router`) — no prefix.
