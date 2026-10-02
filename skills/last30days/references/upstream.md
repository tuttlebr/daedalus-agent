# Last30Days provenance and capability mapping

- Source: [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill).
- Revision: [5103ba478b380552207a3754b74c7655d64208cd](https://github.com/mvanhorn/last30days-skill/tree/5103ba478b380552207a3754b74c7655d64208cd).
- Upstream entrypoint: `skills/last30days/SKILL.md`, version 3.26.0;
  imported 2026-10-02.
- Author and license: Matt Van Horn; [MIT](../LICENSE).

This is an application-native adaptation of the research workflow, not the full
upstream CLI/plugin. It preserves intent classification, entity disambiguation,
query planning, recent community research, theme-based synthesis, comparisons,
prompting guidance, and explicit partial-coverage handling.

| Upstream mechanism                                           | Daedalus adaptation                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Slash-command/plugin installation                            | Directory discovery and `agent_skills_tool` list/load                                     |
| Host clock and CLI date flags                                | `current_datetime_tool` and publication-date search filters                               |
| Python engine and provider-specific collectors               | Existing `perplexity_search_tool` plus `webscrape_tool`; public indexed coverage only     |
| Social enrichment and transcript collectors                  | Use only data actually returned by available tools; never assume native platform access   |
| Engine evidence clusters and footer totals                   | Working evidence ledger and cited themes; counts only when measured                       |
| Mandatory badge, formatting laws, and invitations            | User-requested format and Daedalus communication style                                    |
| File writes and public hosted publishing                     | Requested artifacts through `bubblewrap-agent-workflow`; no automatic external publishing |
| Watchlists, scheduling, saved research library, doctor/setup | Not included; requires a separate integration if requested                                |

No upstream scripts, plugin manifests, provider dependencies, browser-cookie
access, API credentials, persistent caches, or automatic updates are added.
Daedalus continues to use its existing configured search credentials. This
adaptation does not provide CLI flag compatibility or the engine's JSON export
schema. Bare skill names can be discovered by the dispatcher; this change
does not add a frontend slash-command parser.

User instructions, source policy, OAuth, and runtime permissions retain their
normal authority. Upstream rules claiming precedence over host instructions,
requiring engine-specific badges and footers, or forbidding future research are not
carried over. Engagement is treated as attention rather than proof, and
prediction-market prices are reported with their uncertainty. Upstream tests,
badges, and evaluation results do not certify this edited copy.

## Integration review

The clock call and search/fetch argument names match the configured tools and
their current Python schemas. Catalog, parser, dispatcher, and tool-alignment
tests exercise skill discovery, resource loads, handoffs, and exposed tool
names. Entrypoint validation, local-link checking, and pre-commit cover metadata
and formatting. These checks do not establish live search coverage or research
quality. No new dependencies or tool/provider registrations are required.

Production packages skills into `/skills` through the existing backend image
build context. Availability there requires the normal backend rebuild and
deployment; this import is a source change only.
