# Task-start retrieval and governance

Start a governed task with:

```sh
python3 tools/skill-memory/memory.py task-start 'review Kubernetes network health'
```

The command indexes trigger descriptions, chooses at most five matches, and emits
one explicit DATA block. It loads selected bodies only when they fit the exact
UTF-8 byte budget (default 24,000 bytes); otherwise it returns the skill's path,
trigger and provenance for on-demand loading. Diagnostics report actual bytes,
selected/loaded counts, and `token_count: not run`. The byte budget is a deterministic
context bound, not an estimated token measurement. Ranking uses trigger-word overlap,
with half weight after 60 unused days. No task fitness score is inferred from retrieval.

This is the repository maintenance entrypoint; it does not replace the application's
Rust runtime skill loader or modify live service configuration. Existing application
skill paths remain stable. Automatic insertion into a coding agent's standing context
still requires explicit owner approval of that integration.

Every runtime and repository-maintenance skill must appear in `catalog.json` with
`owner`, `agent`, `imported`, or `derived` provenance and a source. Existing adapted
skills are conservatively `derived`, never assumed owner-approved. Adding a skill
without provenance makes `check` fail. All retrieved content stays wrapped as data,
including owner content. Retrieval is not promotion or permission to execute instructions.

Usage persists locally under `.learnings/state/`; it is excluded from Git because
last use is installation-specific. Initialization begins tracking inactivity today;
no historical use is fabricated. `sweep` archives after 120 unused days (twice the
60-day decay window, allowing a full interval of reduced rank before archival).
Archival excludes a skill from this index, retaining all files and links at their
original paths. `restore NAME` restores it in one command and starts a fresh grace
period without recording a fabricated use. `pin NAME` restores and
exempts rare critical skills from decay; `unpin NAME` explicitly removes exemption.
The initial infrastructure and shell safety skills are pinned. No operation deletes
a skill or changes the separate application's library.

Promotion is deliberately separate:

1. `propose LEARNING_ID --scope 'frontend mobile layout'` prepares an exact change
   to `AGENTS.md` (or `--target TOOLS.md`). It keeps the learning and original source
   links and writes only a proposal; the learning remains `open`.
2. The owner runs `review PROPOSAL_HASH --approval-source URL` in an interactive
   terminal, reviews the complete DATA-wrapped proposal and approval-source link,
   and types its exact hash. The approval source must be a single safe URL;
   percent-encode special characters.
   There is no `--yes`, optimizer approval flag, or automatic promotion. Even owner
   provenance uses this explicit approval step; other provenance always needs review.
3. `promote PROPOSAL_HASH` checks the bound approval, unchanged observation, and
   unchanged destination. It snapshots the prior text, writes the scoped rule with
   observation and approval links, and marks the learning `promoted`. Commit the
   reviewed change and ledger together; use `git revert` for rollback. Before commit,
   the saved `.learnings/promotion-backups/` snapshot supplies the prior bytes.

An approval receipt is an owner-controlled local artifact, not cryptographic proof
against a hostile process with unrestricted access to the owner's account. The
optimizer cannot write the registry, approval receipts, standing instructions, or
this tool. Keep these paths outside an external model editor's mounted workspace.
Concurrent capture/promotion uses the capture lock. Do not run another editor against
the standing-context file between review and promotion.

Run `python3 tools/skill-memory/memory.py check` and
`python3 -m unittest discover -s tools/skill-memory/tests -v` for local verification.
