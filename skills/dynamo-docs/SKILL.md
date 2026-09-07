---
name: dynamo-docs
description: Maintain NVIDIA Dynamo Fern docs, navigation, recipes, examples, translations, and links. Use for docs changes, not code bugs.
license: Apache-2.0
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 1.0.0
  tags:
    - dynamo
    - docs
    - fern
    - style-guide
---

# Dynamo documentation maintenance

Maintain NVIDIA Dynamo documentation at the target repository revision. Use
this skill for authoring/navigation/catalog changes; use
`nvidia_docs_tool(product=dynamo)` directly for ordinary documentation lookup.
Deploying a recipe belongs to
[dynamo-recipe-runner](../dynamo-recipe-runner/SKILL.md).

## Establish the authoring contract

Inspect the requested revision through `github_mcp_server` or an available
operator checkout. Daedalus's configured GitHub tools are read-only and the
sandbox has no implicit repository. Without write access, prepare an exact
reviewable patch/artifact and identify unexecuted validation.

Read the repository's current documentation style guide, docs-system README,
Fern navigation/site configuration, and nearby source pages before editing.
Locate guides in the actual tree rather than assuming `docs/` versus
`docs/fern/` placement. For recipe/feature benchmark pages, read the applicable
catalog README, schema, validator and sibling entries.

Author on `main` or a branch based on it, preserving unrelated work. Do not
hand-edit CI-managed website branches or immutable release snapshots.

## Change the complete document contract

- Match current frontmatter/SPDX conventions and avoid duplicate body H1s when
  the renderer supplies the title. Preserve license and source attribution.
- Choose one page purpose: tutorial, how-to, reference or explanation. Keep
  technical names/flags exact and examples compatible with the target revision.
- Use meaningful links with extensions according to the current guide. Resolve
  repository paths, rendered URLs and anchors separately. A move/heading rename
  requires an incoming-link search.
- Add/move/remove the page, navigation entry, incoming links and applicable
  redirects together. For a main-only move, scope redirects to the development
  site; verify the version model before changing latest/pinned URLs.
- For recipe or benchmark pages, keep catalog ID, schema, filename, index,
  nav path, landing card and target-picker CSS axes consistent. Do not copy
  recipe fields into a different benchmark schema.
- For examples/code recipes outside the docs tree, update the relevant
  README/index and use the current guide's repository-link convention.
- Update affected maintained translation mirrors, or explicitly report their
  remaining work. Preserve code, flags, technical names and correct link/image
  resolution. Do not edit generated version snapshots.

Use present-tense, concrete explanations and bounded commands. Separate
measured results from hypothetical examples. Do not invent benchmark numbers,
API behavior, sources, internal issue references or publication state.

## Validate and deliver

Discover the repository's current scripts and CI checks; run the applicable
frontmatter, navigation, link/anchor, MDX and catalog checks in an available
environment. Typical Fern commands include `fern check` and
`fern docs broken-links`; confirm their availability/version before execution.
A text grep does not prove a rendered page or redirect works.

Review the final diff for the entire operation, including translations and
catalog references. If commit/publication is requested, stage only the changed
files through a supported write capability and honor runtime gates. Do not
broadly stage `docs/` or report a published site from local validation.

Return the changed page/behavior, navigation/catalog/redirect effects,
validation evidence and any unavailable checks. Preserve the user's requested
scope; documentation work does not authorize a model deployment or release.
