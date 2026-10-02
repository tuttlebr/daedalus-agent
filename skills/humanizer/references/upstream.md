# Humanizer provenance

- Source: [blader/humanizer](https://github.com/blader/humanizer).
- Revision: [225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8](https://github.com/blader/humanizer/tree/225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8).
- Upstream skill version: 3.1.0; imported 2026-10-02.
- Author and license: Siqi Chen; [MIT](../LICENSE).
- Upstream background: Wikipedia's
  [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

This is an adapted application skill, not a verbatim upstream installation.
The entrypoint keeps the editing workflow and voice matching; the reference
condenses all 26 patterns. Daedalus loads both through its skill dispatcher.

Local changes preserve required schemas, citations, meaningful qualifications,
and all substantive claims. The default output is the final rewrite instead of
exposing successive drafts. User style instructions and the calling skill's
output contract remain authoritative. File work uses the existing sandbox
workflow, with no assumed host paths. Upstream plugin manifests, development
scripts, and evaluation claims are not imported and do not certify this copy.

## Integration review

The repository catalog, parser, dispatcher, and tool-alignment tests exercise
discovery, loading every bundled text resource, sibling handoffs, and exposed
tool names. Entrypoint validation, local-link checking, and pre-commit cover
metadata and formatting. These checks do not establish model editing quality.
No new runtime dependencies or provider registration are required.

Production packages skills into `/skills` through the existing backend image
build context. Availability there requires the normal backend rebuild and
deployment; this import is a source change only.
