---
name: dep-create
description: Create a new Dynamo Enhancement Proposal (DEP) as a GitHub issue on ai-dynamo/dynamo, add an implementation plan to an existing DEP, or file a retroactive DEP for already-merged work. Use whenever the user wants to "file a DEP", "write a DEP", "propose a DEP", "draft an enhancement proposal", "create a Dynamo proposal", "formalize a design decision", "add an implementation plan to DEP #N", or "file a retroactive DEP" — even if they don't say the word "DEP" but describe writing up a feature/architecture/process proposal targeted at ai-dynamo/dynamo.
---

# Skill: Create a DEP as a GitHub Issue

> **Related skills:** `dep-status` (list and filter DEPs), `dep-update` (move DEPs through their lifecycle).

## Purpose

Create a new Dynamo Enhancement Proposal (DEP) as a GitHub Issue on
`ai-dynamo/dynamo`. The issue number becomes the DEP number. Also
handles adding implementation plans and retroactive DEPs for existing
work.

## When to Use

When the user wants to propose a new feature, architecture change, or
process improvement via the issue-based DEP workflow. Also when adding
an implementation plan to an existing DEP, or filing a retroactive DEP
for work already merged.

## Workflow

### Create a New DEP

1. **Ask for source material**: Prompt the user for a Google Doc,
   Confluence page, or other NVIDIA-internal document that contains
   the background, customer context, or detailed requirements. Read
   it using the appropriate tool (gdocs, Confluence MCP, WebFetch).
   Include the link in the issue's References section — the document
   is only accessible to NVIDIA employees and serves as the record
   for customer-specific context that cannot appear in the public
   issue prose.

   **If the doc is inaccessible** (no MCP access, sharing restricted,
   404), do not abandon the workflow: ask the user to paste the
   relevant sections inline, and still link the URL in the References
   section so a future NVIDIA reader can verify the source.

2. **Gather required fields** from the user and source doc (prompt
   if missing):
   - **Summary**: One-paragraph description of the proposal
   - **Motivation**: Why this change is needed
   - **Proposal**: Detailed description of the proposed change

3. **Determine and verify the area label**. Area labels are bare
   names (e.g., `frontend`, `router`, `backend-vllm`) that correspond
   to CODEOWNERS teams. Before using a label, confirm it exists on the
   repo — typos silently create unlabelled DEPs:

   ```bash
   gh label list --repo ai-dynamo/dynamo --search "<keyword>"
   ```

   If no exact match, list nearby candidates for the user to pick.

4. **Strip customer / partner names from every field** before
   drafting the gh command. Scan summary, motivation, proposal,
   alternates, requirements for proper nouns and replace with
   generic stand-ins: `Acme Corp` → `a customer`, `AWS` → `a cloud
   partner` (unless AWS is the literal subject), `Hopper Health` →
   `an enterprise user`. DEPs are public — this scrub is not
   optional. (The Notes section has more detail.)

5. **Decide template**: full or lightweight. Rubric:
   - **Lightweight** when the scope is a single component, no
     alternates were considered (the design was obvious), and there's
     no measurable success criterion to track.
   - **Full** when alternates were weighed, customer/external impact
     exists, or the proposal touches more than one CODEOWNERS team.

6. **Construct the title**. Keep it ≤ 80 chars; no customer names; no
   area prefix in the title itself (the label carries the area).
   Pattern: `DEP: <what it adds, in plain prose>`. Example:
   `DEP: Add async streaming to the KV router for multi-node disagg`.

7. **Create the issue** (full DEP):

```bash
gh issue create \
  --repo ai-dynamo/dynamo \
  --title "DEP: <short descriptive title>" \
  --label "dep:draft" \
  --label "<area>" \
  --body "$(cat <<'EOF'
## Summary
<summary>

## Motivation
<motivation>

## Proposal
<proposal>

## Alternate Solutions
<alternates>

## Requirements
<requirements>

## References
<references — include internal doc link here>
EOF
)"
```

   **For lightweight DEP**, use:

```bash
gh issue create \
  --repo ai-dynamo/dynamo \
  --title "DEP (light): <short descriptive title>" \
  --label "dep:draft" \
  --label "dep:lightweight" \
  --label "<area>" \
  --body "$(cat <<'EOF'
## Summary
<summary>

## Motivation
<motivation>

## Proposal
<proposal>
EOF
)"
```

8. **Report** the created issue number and URL to the user.

### Add an Implementation Plan

1. **Read the DEP issue** and its discussion:

```bash
gh issue view <number> --repo ai-dynamo/dynamo
gh issue view <number> --repo ai-dynamo/dynamo --comments
```

2. **Draft the plan** with phases, tasks, effort estimates,
   dependencies, risks, and testing strategy.

3. **Post as a comment**:

```bash
gh issue comment <number> --repo ai-dynamo/dynamo --body-file /tmp/plan.md
```

### Retroactive DEP

For work already merged without a DEP, file with `dep:implementing`
or `dep:done` and reference the existing PRs.

## Notes

- The issue body IS the spec — treat it as a living document.
- `dep:draft` is applied automatically. PIC changes to
  `dep:under-review` when ready.
- For lightweight DEPs, use `dep:lightweight` label and omit optional
  sections.
- For plan revisions, post a new comment with a changelog at the top.
  Do not edit the original — preserve the timeline.
- **Customer name stripping**: Before creating or updating a DEP,
  scan the summary, motivation, proposal, and all other fields for
  specific customer names, company names, or partner names. Replace
  them with generic references (e.g., "a customer", "a cloud
  partner", "an enterprise user"). DEPs are public — no customer
  names should appear in issue bodies, comments, or plans.
