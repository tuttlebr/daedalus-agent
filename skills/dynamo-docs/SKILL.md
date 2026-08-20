---
name: dynamo-docs
description: Maintain NVIDIA Dynamo Fern docs, navigation, recipes, examples, translations, and links. Use for docs changes, not code bugs.
license: Apache-2.0
metadata:
  author: NVIDIA Corporation and Affiliates <noreply@nvidia.com>
  version: 1.0.0
  tags:
    - dynamo
    - docs
    - fern
    - style-guide
---

# Dynamo Docs Maintenance

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

## Purpose

Unified skill for adding, updating, moving, and removing content on the Dynamo Fern documentation
site, in line with the project's authoring guides.

## Prerequisites

- A Dynamo repository checkout based on `main`.
- The relevant style guide, live navigation, and catalog schema for the requested change.
- Fern tooling for nav and link validation when the affected surface requires it.

Two authoring guides govern this work; read whichever applies before writing:

- [`docs/fern/documentation-style-guide.md`](https://github.com/ai-dynamo/dynamo/blob/main/docs/fern/documentation-style-guide.md) — the standard for **every** page: frontmatter, headings, prose, terminology, links, callouts. The must-fix subset is distilled in [Style Guide Is the Standard](#style-guide-is-the-standard) and [Content Rules](#content-rules) below.
- [`docs/fern/recipes/_catalog/README.md`](https://github.com/ai-dynamo/dynamo/blob/main/docs/fern/recipes/_catalog/README.md) — the standard for **recipe and feature-benchmark pages** (the catalog contract, the `.mdx` page blueprint, and the pure-CSS target picker). See [Recipe and feature-benchmark pages](#recipe-and-feature-benchmark-pages).

## Branch Rule

**ALL edits happen on `main` (or a feature branch based on `main`).**
The `docs-website` branch is CI-managed and must **never** be edited by hand.

## Style Guide Is the Standard

Every page under `docs/` (and the READMEs under `examples/` and `recipes/`) follows the
[Documentation Style Guide](https://github.com/ai-dynamo/dynamo/blob/main/docs/fern/documentation-style-guide.md)
(`docs/documentation-style-guide.md`). Read it before writing content. The docs bot enforces a
**must-fix** subset on every PR — get these right or the checks fail:

- **SPDX header** on every file, copyright range `2025-2026`. Fern pages put the two `#` lines
  _inside_ the `---` frontmatter; plain READMEs use an HTML-comment block.
- **Frontmatter with at least one metadata key** (`title`/`subtitle`/`sidebar-title`) and **no body
  `# H1`**. Fern renders the page H1 from the nav `page:` value, so a body `# H1` produces a
  duplicate title — and a bare `#` SPDX line left in the body also renders as an H1. Start the body
  at `##`.
- **A nav entry** in `docs/fern/index.yml` for every new page — a page not in the nav is unreachable.
- **Links**: relative path _with extension_ within `docs/` (`[Routing](router-concepts.md)`);
  absolute `https://github.com/ai-dynamo/dynamo/blob/main/<path>` URL for targets outside `docs/`
  (examples, recipes, source; `/tree/main/` for a directory). No `../` path that escapes `docs/`, and
  never a hardcoded `https://docs.nvidia.com/...` link to a page in this repo. Link text names the
  destination, never "click here".
- **No internal or sensitive references**: NVBug/JIRA/Linear IDs, internal hostnames, secrets,
  `TODO`/`FIXME`.

Everything else in the style guide (page types, heading case, terminology, list and code-fence
formatting, the pre-merge checklist) is guidance — the high-value rules are distilled in
[Content Rules](#content-rules) below; apply them and deviate only with a reason.

## Content Rules

Apply these on every page so the result reads like a person wrote it and passes review without a
round-trip to the style guide. These are defaults; deviate with a reason.

- **Page type (Diátaxis).** Each page serves one need — _tutorial_ (`getting-started/`), _how-to_
  (`backends/<engine>/`, `kubernetes/`), _reference_ (flags/APIs/config), or _explanation_
  (`design-docs/`). Don't blend a how-to into a flag reference; split and cross-link.
- **Headings.** Title Case for short label / noun-phrase headings ("Routing Behavior"); sentence
  case for full-phrase headings ("Choosing a checkpoint flow"). Be consistent within a page. No end
  punctuation. Logical `##` → `###` hierarchy, no skipped levels. Renaming a heading breaks inbound
  `#anchor` links — rename deliberately.
- **Terminology, exact casing.** Backends: **vLLM**, **SGLang**, **TensorRT-LLM** (or **TRT-LLM**) —
  never "vllm", "Sglang", "TensorRT LLM". **NVIDIA Dynamo** on first mention, then **Dynamo**; **KV
  router**, **NIXL**, **GPU**; **Kubernetes**, not "k8s", in prose. Expand acronyms on first use
  ("Time To First Token (TTFT)"). Use one word per concept.
- **Inclusive terms.** "denylist"/"allowlist", not "blacklist"/"whitelist"; "primary"/"replica", not
  "master"/"slave".
- **Cut marketing and bombast.** Remove vague claims and inflated adjectives;
  name the concrete behavior, constraint, flag, or result instead.
  Cut filler ("it's important to note", "simply", "just", "in order to") and difficulty words
  ("easy", "easily"). Start sentences with a verb; active voice; present tense; second-person
  imperative. Name the flag/default/command, not "configure the appropriate settings". Avoid the
  em-dash-aside tic.
- **Procedures.** Condition before instruction ("To enable KV-aware routing, set `--router-mode
kv`", not the reverse). One action per numbered step.
- **Links.** Follow the must-fix Links rule in
  [Style Guide Is the Standard](#style-guide-is-the-standard) (relative + extension inside `docs/`,
  absolute GitHub URL outside, no `../` escape, no `docs.nvidia.com` self-link).
- **Code fences** always tag a language (`bash`, not `sh`); no `$`/`#` prompt prefixes; put output in
  its own `text` block. Wrap flags, paths, and `DYN_*` env vars in backticks in prose.
- **Lifecycle.** Mark preview features **Experimental.** and legacy ones **Deprecated.** (with a
  `> [!WARNING]`); note availability for new features ("Available since v0.X").

## Instructions

1. Read `docs/documentation-style-guide.md` before editing any documentation.
2. Inspect `docs/fern/index.yml` for live placement and navigation; do not infer
   sections from a stale snapshot.
3. For recipe or benchmark pages, also read
   `docs/recipes/_catalog/README.md` and the exact sibling `schema.json`.
4. Make the content, navigation, redirect, catalog, landing-page, and translation
   changes required by the chosen operation.
5. Run the focused validation commands in [Validate](#validate).

### Standard page changes

- Add a `.md` page beside the nearest related page. Put SPDX lines inside
  frontmatter, include a metadata key, start the body at `##`, and add its nav
  entry.
- For a title or section move, update the frontmatter, nav label and placement,
  incoming links, and a dev-scoped redirect when the URL changes.
- For removal, find incoming links first, resolve the exact file and nav entry,
  then remove them with patch tooling and repair every reference. Never use a
  broad path, glob, or recursive deletion.

### Recipe and feature-benchmark pages

Treat each rendered page as one contract across the `.mdx` page, catalog entry,
index, Fern navigation, landing card, and target-picker CSS when a new axis value
is introduced. Recipe and benchmark schemas differ; read the relevant schema
instead of copying fields between them. Keep catalog IDs, filenames, `page:`
paths, and index entries identical, then run the catalog validator.

For rename, defer, or removal, update every part of that contract together and
add the appropriate dev-scoped redirect. Preserve a deferred catalog entry only
when the schema and catalog guide call for it.

### Examples and code recipes

Files under `examples/` and `recipes/` live outside `docs/`. Their READMEs use
HTML-comment SPDX headers, and documentation links to them with absolute GitHub
URLs. Update the relevant examples page or recipes table when adding or moving
one.

## Examples

A standard Fern page begins like this:

```markdown
---
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
title: <Page Title>
subtitle: <One-line description>
---

Short introduction.

## First Section
```

Its navigation entry uses a path relative to `docs/`:

```yaml
- page: <Page Title>
  path: <subdirectory>/<filename>.md
```

## Callouts

Match admonition syntax to the extension: use Fern callout components in `.mdx`, and GitHub-style blockquotes in `.md`. Put
images under `docs/assets/img/` with descriptive alt text.

| GitHub Syntax    | Fern Component |
| ---------------- | -------------- |
| `> [!NOTE]`      | `<Note>`       |
| `> [!TIP]`       | `<Tip>`        |
| `> [!IMPORTANT]` | `<Info>`       |
| `> [!WARNING]`   | `<Warning>`    |
| `> [!CAUTION]`   | `<Error>`      |

## Navigation: Tabs and Sections

**`docs/fern/index.yml` is the source of truth — read it for the live structure.** The section names below
are a snapshot, not an authority; sections get added, renamed, and removed. What stays stable is the
_grammar_:

- Two tabs under `navigation:`. **`- tab: docs`** holds the main documentation; **`- tab: recipes`**
  is a flat list of `- page:` entries (`recipes/<slug>.mdx`), order mirroring
  `docs/recipes/_catalog/index.yaml`.
- In the docs tab, each section is marked by a banner comment
  (`# ==================== <Section> ====================`); a `- page:` sits under that section's
  `contents:` at 2-space indent, `path:` relative to `docs/`. In the recipes tab a `- page:` sits
  directly under `layout:`.
- Pages can carry `slug:` (overrides the label-derived slug) and `hidden: true` (reachable by URL but
  off the sidebar — used for per-benchmark pages).

Docs-tab sections **as of this writing** (confirm against `index.yml`): Getting Started, Resources,
Feature Benchmarks, Digest, Kubernetes Deployment, Feature Guides, Backends, Components, Integrations,
Design Docs, Documentation, Hidden Pages. To place a page, match the nearest existing page (see
[Standard page changes](#standard-page-changes)) rather than reasoning from these names.

## Translations and Versioned Navs

- **Chinese translations** live at `fern/translations/zh-CN/pages-dev/<path>`, mirroring the
  English page at `docs/<path>` (same file name and SPDX header, Chinese frontmatter, no body H1 —
  the frontmatter `title` renders the heading, no manual language-switcher links). Fern's native
  localization pairs them and adds the header language picker; untranslated pages fall back to
  English. Links to translated siblings stay shallow-relative; links to untranslated pages are
  deep-relative into `docs/` — count `../` as 4 plus one per directory level of the page under
  `pages-dev/` (`getting-started/x.md` → 5, `components/router/x.md` → 6) — so the repo link
  checker and GitHub browsing stay valid; the sync workflow rewrites them to site URLs at publish
  via `fern/resolve_translation_links.py`. Image refs stay shallow-relative (`../assets/...`) and
  are **not** copied into the mirror — Fern resolves them against the base page. Translate prose, not code, flags, or terminology
  (vLLM / SGLang / TensorRT-LLM stay verbatim). Keep it in sync when the English page changes,
  or don't ship it stale.
- **Versioned navs.** Author only against `docs/` on `main` (the `pages-dev` set). When a release is
  cut, the publish step builds `pages-vX.Y.Z/` from the tagged `docs/` tree and rewrites nav paths —
  **never** edit a `pages-vX.Y.Z/` directory by hand. Write portable paths so the rewrite stays clean.
  Translation mirrors snapshot the same way (`fern/translations/<lang>/pages-vX.Y.Z/` from the tag's
  `pages-dev` mirror, links resolved under the tag's version slug); tags cut from branches without
  `fern/translations` skip the snapshot.

### Redirects and the version model

The site serves the same nav under three prefixes: **`dev`** (slug `dev`, tracks `main`, regenerated on
every push), **Latest** (slug `/` — the unversioned root `/dynamo/...` _and_ `/dynamo/latest/...`, a
frozen snapshot of the newest release), and pinned **`vX.Y.Z`** (immutable snapshots). A
`docs/fern/index.yml` edit on `main` regenerates **only the `dev` nav**.

So a moved or renamed page (changed section or `page:` label) changes only its `/dynamo/dev/<old>` URL.
Add one dev-scoped `docs/fern/docs.yml` redirect:

```yaml
- source: '/dynamo/dev/<old>'
  destination: '/dynamo/dev/<new>'
```

**Do not** add unversioned (`/dynamo/<old>`) or `/dynamo/latest/<old>` redirects for a main-only move:
Latest is frozen, still serves the old path, and a redirect there would break a working URL and point at
a `<new>` that won't exist in Latest until the next release re-snapshots it. Per-version redirects are a
release-time concern, not an authoring one.

## Validate

Self-check, then run the tooling.

**Before you commit**, confirm every must-fix rule in
[Style Guide Is the Standard](#style-guide-is-the-standard) holds for each file you touched — SPDX
header, frontmatter key + no body `# H1`, a nav entry under the right tab, the link rules, and no
internal or sensitive references — and that every internal link and `#anchor` resolves. The docs bot
fails the PR on any of these.

**Tooling:**

```bash
fern check                          # nav + frontmatter structure
fern docs broken-links              # link resolution
python3 docs/recipes/_catalog/validate.py   # recipe/benchmark changes only — validates BOTH catalogs
```

`fern check` and `broken-links` mirror the PR checks. The catalog validator is **not yet wired into
CI**, so run it by hand for any `_catalog/` change. Optional local preview: `fern docs dev`
(localhost:3000, hot reload, no token).

## Commit

```bash
git add docs/ docs/fern/docs.yml          # also recipes/ examples/ docs/fern/main.css when touched
git commit -s -m "docs: <add|update|move|remove> <page-title>"
```

## Limitations

- The live style guide, navigation, and schemas override snapshots in this skill.
- Main-branch authoring changes only the `dev` site; release snapshots are immutable.
- Documentation changes do not authorize code, deployment, or release changes.

## Troubleshooting

- Duplicate H1: remove the body H1; Fern renders it from the nav page label.
- SPDX heading: move SPDX lines inside frontmatter and add a metadata key.
- Fern YAML error: check two-space indentation and the surrounding `contents:` block.
- Broken link: search the old filename or anchor and repair every incoming reference.
- 404 after a move: add only the dev-scoped redirect for a main-branch move.
- MDX parse error: use Markdown links, escape stray angle brackets, and keep
  blank lines around picker `<div>` elements.
- Picker does not filter: verify `className`, exact picker classes, data axes,
  and the corresponding `docs/fern/main.css` rule.
- Catalog validation fails: make the filename, internal ID, index entry, page
  path, and referenced assets agree with the applicable schema.

## Key References

| File                                | Purpose                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `docs/documentation-style-guide.md` | Authoring standard for every page (must-fix + guidance)               |
| `docs/recipes/_catalog/README.md`   | Recipe/benchmark page authoring (catalog contract, blueprint, picker) |
| `docs/recipes/_catalog/validate.py` | Catalog validator (covers both recipe and benchmark catalogs)         |
| `docs/fern/index.yml`               | Navigation tree (two tabs: `docs` + `recipes`)                        |
| `docs/`                             | Content directory (`.md`, plus `.mdx` for recipe/benchmark pages)     |
| `docs/assets/`                      | Images, SVGs, fonts                                                   |
| `docs/fern/docs.yml`                | Fern site configuration + `redirects:`                                |
| `docs/fern/main.css`                | Pure-CSS target-picker axis values (recipe/benchmark pages)           |
| `fern/convert_callouts.py`          | Callout conversion (GitHub -> Fern)                                   |
| `recipes/README.md`                 | Available Recipes tables (code recipes)                               |
| `recipes/CONTRIBUTING.md`           | How to contribute a code recipe                                       |
| `docs/README.md`                    | Docs system guide (build, sync, publish)                              |
