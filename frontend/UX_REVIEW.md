# Frontend experience review — September 9, 2026

This review applies the apple-design skill to the existing Next.js PWA. Its
primary tasks are chatting, creating and revisiting images, managing autonomous
work, reviewing memory, and connecting Google services. The web framework,
Daedalus identity, system font stacks, and five destinations are retained.

## Evidence and design basis

The review combined source inspection with a running frontend, deterministic
populated API fixtures, screenshots, keyboard interaction, failure injection,
and automated accessibility checks. Fixtures avoid personal data and live model
requests. The production browser suite separately exercises the authenticated
session, streaming, uploads, approvals, and recovery against isolated services.

Current Apple guidance was retrieved on September 9, including the public DocC
content behind the JavaScript documentation pages:

- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility): readable enlarged text, named controls, multiple input methods, and contrast.
- [Modality](https://developer.apple.com/design/human-interface-guidelines/modality): focused tasks, clear dismissal, and preservation of context.
- [Searching](https://developer.apple.com/design/human-interface-guidelines/searching): clear scope and useful results and recovery.
- [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data): persistent labels and validation near the task.
- [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback): timely, understandable outcomes and failures.
- [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars): stable peer destinations.

Native dialog semantics, CSS pixels, browser preference queries, and DOM focus
handling are web adaptations. They do not establish native Apple behavior or
HIG certification.

## Findings and implemented corrections

| Priority | Finding and user impact                                                                                                                                                                        | Correction                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | Run and goal forms erased drafts before the request succeeded.                                                                                                                                 | Await acceptance, retain failed drafts and details, prevent concurrent submissions, and show errors and success feedback inside the workspace.                                                                                 |
| High     | Conversation deletion and clearing removed local history even when server requests failed. Renames also appeared saved without acknowledgment.                                                 | Persist before applying destructive changes or a rename. Keep failed entries in partial clears, preserve rename drafts, and provide explicit Save and Cancel actions.                                                          |
| High     | Image history optimistically disappeared; its recovery fetch could also fail while claiming restoration. Deletion confirmation expired after three seconds.                                    | Retain saved creations and gallery assets until the server accepts the action. Provide an explicit, untimed confirmation for individual deletion and truthful failure feedback.                                                |
| High     | A service-worker update unconditionally reloaded the page, discarding unsent work.                                                                                                             | Present an update notice with Later and Reload. Reload requires an explicit action and explains its effect on unsent edits.                                                                                                    |
| Medium   | Overlapping Memory requests could display an older query's result after the newest search. Search had little progress or no-results guidance.                                                  | Ignore superseded responses, announce loading and result scope, allow same-query retries, and provide Clear search and useful empty states.                                                                                    |
| Medium   | Knowledge Page and source details replaced the focused list item and used nested scrolling; page Markdown appeared as raw source. Delayed detail requests could interrupt another destination. | Keep the list mounted, open a labeled native modal only in the current destination, render sanitized Markdown with wrapping headings for Knowledge Pages, use one detail scroll area, and restore focus on dismissal.          |
| Medium   | The workspace had placeholder-only fields, unnamed hidden file inputs, fixed-size text, a clipped close action at 320px/200% text, and crowded state controls.                                 | Add persistent labels, hide proxy file inputs from navigation, use relative text sizes, reflow controls, and simplify the compact sheet header.                                                                                |
| Medium   | Goals after the first twelve, and other returned queue/history/diagnostic entries, had no navigation path.                                                                                     | Display all entries returned by the API in the scrollable sections. Reflow long diagnostic types and section labels, and expose complete queue prompts and run summaries. The API still owns any server-side retention limits. |
| Medium   | Failed Autonomy cancellation treated HTTP errors as success; later dashboard refresh failures left apparently current data. Schedule values could silently fall back to a different number.    | Check cancellation responses, show stale-data and retry guidance, validate the schedule with a labeled native number field, and confirm goal deletion or goal-replacing imports.                                               |
| Medium   | Selecting a conversation from another desktop destination did not reveal Chat. Mobile selection changes during a partial deletion closed the drawer and hid the error.                         | Navigate to Chat for explicit conversation selection/New Chat; close the mobile drawer only for the navigation action. Keep it open for history management and restore cancellation focus.                                     |
| Medium   | Populated Connections badges crowded service names at enlarged text, and an unconfigured service offered only a reset action.                                                                  | Constrain card widths, wrap service headers, status labels, and actions, add Connect in Chat, preserve reconnect/reset controls, and explain a successfully loaded empty service list.                                         |
| Low      | A desktop image popover stayed open after keyboard focus left it. Offline transitions produced duplicate notices. Document errors told people to inspect backend logs.                         | Dismiss the popover when focus leaves, retain a single offline indicator, and provide actionable document retry guidance.                                                                                                      |

## Coverage

| Area                    | Reviewed states and interactions                                                                                          | Verification                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Sign-in and PWA         | Named inputs, validation, appearance, offline recovery, branding, update deferral                                         | Existing HIG and branding cases; update simulation verifies draft retention, Later, and explicit Reload.          |
| Shell and conversations | Five destinations, resizable desktop sidebar, compact navigation, keyboard viewport, draft retention, rename/delete/clear | HIG and layout suites; failure tests cover single deletion, rename retry, partial clear, and navigation.          |
| Chat and outputs        | Empty/populated chat, streaming and cancellation, files/photos, approvals, agent activity, search, details, Markdown/HTML | HIG, layout, and authenticated agentic suites. Existing reading and streaming behavior retained.                  |
| Create                  | Prompt and mode controls, presets, settings/custom dimensions, saved image actions, history restore/delete/clear          | HIG/layout cases plus popover traversal and failure tests for saved history.                                      |
| Autonomy                | Empty/populated feed, loading/error/stale states, workspace, run/goal drafts, schedules, all returned entries             | HIG populated-feed cases and new workspace/failure cases, including the thirteenth goal and cancellation failure. |
| Memory                  | Pages/facts/sources, search/filter/reset, loading and request races, editor retry, detail focus, destructive controls     | Existing editor/clear cases and new out-of-order search, no-results, Markdown/detail, and source cases.           |
| Connections             | Populated/empty/error states, reconnect meaning, chat entry, enlarged text                                                | HIG and connection unit cases plus populated appearance and refresh recovery checks.                              |

The review matrix includes desktop Chromium, 402px Chromium and WebKit, 834px
WebKit, and 320px Chromium. Representative flows cover light/dark appearance,
200% text, reduced motion, increased contrast, safe areas, focus containment and
return, and WCAG A/AA rules supported by axe. Screenshots are produced in the
Playwright results, including `workspace-large-text.png`,
`knowledge-page-large-text.png`, and `connections-large-text.png`.

## Validation and limits

Verified on September 9 with Node 22.17.0:

- ESLint and TypeScript checks passed.
- The production frontend and both background workers built successfully.
- Unit coverage: 775 tests passed, 4 skipped; 94 test files passed, 3 skipped.
  All existing coverage gates passed.
- The complete production browser suite passed: 150 tests, with 14
  platform-specific skips across the five browser configurations.
- Scoped pre-commit checks passed for the changed files.

Run the same checks from `frontend/` with Node 22:

```sh
npm run lint
npx tsc --noEmit --incremental false
npm run coverage
npm run e2e
```

The E2E runner builds the production app and both workers, starts isolated test
services, and removes those services when finished. Review screenshots and
failure traces are local test artifacts rather than shipped product assets.

This is browser and source evidence. Physical iPhone keyboard behavior, Safari
installation, VoiceOver listening, and actual SF glyph rendering on Apple
hardware were not tested. These limitations do not represent unresolved source
recommendations; they remain device validation work for a production release.
