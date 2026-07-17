---
name: dynamo-docs
description: >-
  Maintain the Dynamo Fern documentation site: add, update, move, or remove
  pages (guides, tutorials, how-tos, references), including navigation
  (index.yml) updates, callout conversion, and `fern check` validation. Use
  whenever the user wants to "write Dynamo docs", "update the Dynamo docs
  site", "add a page/guide to the Dynamo Fern site", "move a Dynamo doc to
  <section>", "fix a broken link in Dynamo docs", "remove a doc page", or
  otherwise asks for documentation changes scoped to ai-dynamo/dynamo's
  Fern-based docs site (paths under `docs/`, configured by `fern/docs.yml`).
  Use dynamo-bug to file an upstream code bug instead of a docs change.
---

# Dynamo Docs Maintenance

> **Related skills:** `dynamo-bug` (file an upstream bug against ai-dynamo/dynamo), `dynamo-troubleshoot` (diagnose a deployment; investigation often surfaces gaps the docs should fill).

Unified skill for adding, updating, moving, and removing pages on the Dynamo Fern documentation site.

## Branch Rule

**ALL edits happen on `main` (or a feature branch based on `main`).**
The `docs-website` branch is CI-managed and must **never** be edited by hand.

## Operations

### Add a Page

1. Gather: page title, target section, filename (kebab-case `.md`). Infer the subdirectory from the section using the **Section → Subdirectory map** below; if the section isn't in the map, grep `docs/index.yml` for the section banner and use the `path:` of an existing page in that section as your guide.
2. Create `docs/<subdirectory>/<filename>.md`:

```markdown
---
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
title: <Page Title>
---

# <Page Title>
```

3. Add a nav entry in `docs/index.yml` under the correct section. Real nav entries are **nested inside `- section: ... contents:`** and require 6-space indent (not the 2-space top-level form). Find the right `# ==================== <Section> ====================` banner first; insertion is append-at-end of the section's `contents:` unless that section is alphabetically ordered (`Backends` and `Integrations` are; others are topical).

```yaml
# inside docs/index.yml, under the matching section banner
- section: User Guides
  contents:
    - page: Existing Page
      path: guides/existing-page.md
    - page: <Page Title> # <- your new entry, 6-space indent
      path: <subdirectory>/<filename>.md
```

### Section → Subdirectory map

These are the canonical homes for each section in `docs/index.yml`:

| Section banner        | Canonical subdirectory under `docs/` |
| --------------------- | ------------------------------------ |
| Getting Started       | `getting-started/`                   |
| Kubernetes Deployment | `kubernetes/`                        |
| User Guides           | `guides/`                            |
| Backends              | `backends/`                          |
| Components            | `components/`                        |
| Integrations          | `integrations/`                      |
| Documentation         | `documentation/`                     |
| Design Docs           | `design-docs/`                       |
| Blog                  | `blog/`                              |
| Hidden Pages          | `hidden/`                            |

If the section banner is present but the subdirectory above doesn't exist yet (rare — usually only for a brand-new section), inspect an existing page's `path:` field for that section in `index.yml` to find the truth; the map can drift from real layout.

### Update a Page

1. Locate by file path, page title, or keyword search (`grep -rn` in `docs/`).
2. **Content only** -- edit the markdown file directly.
3. **Title change** -- update both the frontmatter `title:` and the `- page:` name in `docs/index.yml`.
4. **Section move** -- `git mv` the file, remove old nav entry, add new one, update all incoming links.

### Remove a Page

1. Find incoming links: `grep -r "<filename>" docs/ --include="*.md"`.
2. `git rm docs/<subdirectory>/<filename>.md`.
3. Remove the `- page:` block from `docs/index.yml`. If it was the last page in a section, remove the entire `- section:` block.
4. Fix or remove all incoming links found in step 1.

---

## Content Guidelines

Use GitHub-flavored markdown. CI auto-converts callouts to Fern format:

| GitHub Syntax    | Fern Component |
| ---------------- | -------------- |
| `> [!NOTE]`      | `<Note>`       |
| `> [!TIP]`       | `<Tip>`        |
| `> [!IMPORTANT]` | `<Info>`       |
| `> [!WARNING]`   | `<Warning>`    |
| `> [!CAUTION]`   | `<Error>`      |

Reference images from `docs/assets/`.

## Section Banners in `index.yml`

Search for:

- `# ==================== Getting Started ====================`
- `# ==================== Kubernetes Deployment ====================`
- `# ==================== User Guides ====================`
- `# ==================== Backends ====================`
- `# ==================== Components ====================`
- `# ==================== Integrations ====================`
- `# ==================== Documentation ====================`
- `# ==================== Design Docs ====================`
- `# ==================== Blog ====================`
- `# ==================== Hidden Pages ====================`

## Validate

```bash
fern check
fern docs broken-links
```

Optional local preview: `fern docs dev` (localhost:3000, hot reload, no token).

## Commit

```bash
git add docs/
git commit -s -m "docs: <add|update|remove> <page-title>"
```

## Debugging

| Symptom                 | Fix                                                                  |
| ----------------------- | -------------------------------------------------------------------- |
| `fern check` YAML error | Check 2-space indent; `- page:` must be inside `contents:`           |
| Missing/orphaned file   | `path:` in `index.yml` must match actual file location               |
| Broken links in CI      | `grep -r "<filename>" docs/` and fix stale references                |
| MDX parse error         | Replace `<https://...>` with `[text](https://...)`                   |
| Page missing from site  | Ensure nav entry exists in `index.yml`; allow a few minutes for sync |

## Key References

| File                       | Purpose                             |
| -------------------------- | ----------------------------------- |
| `docs/index.yml`           | Navigation tree                     |
| `docs/`                    | Content directory                   |
| `docs/assets/`             | Images, SVGs, fonts                 |
| `fern/docs.yml`            | Fern site configuration             |
| `fern/convert_callouts.py` | Callout conversion (GitHub -> Fern) |
| `docs/README.md`           | Full architecture guide             |
