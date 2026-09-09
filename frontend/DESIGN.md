# Apple HIG adaptation for the Daedalus PWA

Daedalus remains a Next.js progressive web app. This implementation adapts
Apple's interaction and visual guidance for touch on iPhone, resizable iPad
windows, and pointer/keyboard use on Mac and other desktop browsers. It does
not use SwiftUI, distribute SF Symbols, or claim native Liquid Glass rendering.

## Design decisions

- Content comes first: quiet solid backgrounds and cards, a readable chat
  column, a gallery of actual images, concise empty states, and a single
  accent color for interactive emphasis.
- Text, including the Autonomy feed, prefers SF Pro for regular, italic, and
  bold styles. Code, inline code, and diagrams prefer SF Mono. Shared CSS font
  variables also drive Tailwind and syntax highlighting. These are device-local
  font stacks: Apple system aliases and generic system fallbacks apply when the
  named fonts are unavailable. The application does not bundle SF font files or
  request fonts from a CDN. Text and captions use relative sizes and browser
  text scaling.
- Semantic color roles in `styles/appearance.css` cover text, backgrounds,
  controls, separators, and filled actions. Light, Dark, and System appearance
  are available in the sidebar and sign-in screen. The System choice follows
  changes while the app is open. Existing explicit saved choices are retained.
- Translucency is reserved for navigation and toolbars. Content cards and
  settings sheets use solid surfaces. Increased contrast and reduced
  transparency remove backdrop filters; reduced motion removes transitions
  and smooth scrolling. Forced-colors selection retains a visible outline.
- Five peer destinations remain visible in the mobile tab bar. Commands are
  placed in toolbars. Desktop navigation uses labeled tabs, a conversation
  sidebar, arrow/Home/End navigation, and an adjustable divider. Visited tabs
  retain drafts, selections, and scroll position.
- Coarse-pointer controls have at least 44 CSS pixels of target height, including
  iPad at desktop widths. Safe-area padding and the existing visual viewport
  keyboard compensation remain part of the PWA shell. Zoom remains enabled.
- Sheets, drawers, and the memory editor share native HTML dialog semantics for
  modal stacking, inert background, focus containment, Escape, and focus return.
  Mobile settings include an explicit Done action. Desktop popovers move focus
  into their content and support Escape.
- Permission and destructive-action confirmation remain explicit. Sign-in has
  persistent labels and associated validation. Connection and memory copy
  explains access and saved data without exposing internal storage details.
- Populated Agent Activity uses the same semantic text colors and solid surfaces
  as the rest of the app. Search is directly available; separate buttons expand
  child steps and open details. Details use a scrollable modal with keyboard
  dismissal and focus return, so they remain readable in a narrow chat column.
- Create headers wrap when text grows. Custom image dimensions retain visible
  labels and associate validation feedback with both inputs. Failed memory saves
  display their error inside the editor and keep the draft available for retry.
- Conversation selection and row actions are separate native buttons. Canceling
  a rename returns focus without dismissing the history drawer. Autonomy dates
  use the current appearance, feed articles have names and valid day grouping,
  and feed shortcuts only handle keys while focus is inside the feed.
- Installability, offline recovery, image creation/editing, chat streaming,
  attachments, approvals, and generated document previews are retained.
  The manifest uses the neutral launch background and current, correctly sized
  Chat and sign-in screenshots.

## Source guidance

Reviewed September 7, 2026. Apple's documentation overview includes native
framework choices; its linked HIG informs this web implementation.

- [App design and UI](https://developer.apple.com/documentation/technologyoverviews/app-design-and-ui)
- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)

## September 9 experience review

[The frontend experience review](UX_REVIEW.md) records the complete flow inventory,
prioritized findings, implemented corrections, and current verification. It
adds recoverable Autonomy forms, server-confirmed history changes, readable
Memory dialogs and search feedback, and an explicit app-update choice.

## Verification

`e2e/tests/hig-design.spec.ts` uses deterministic API fixtures to inspect all
five destinations in light/dark appearance, enlarged text, reduced motion,
increased contrast, navigation state, and modal keyboard behavior. Axe checks
WCAG A/AA rules in each destination. Screenshots are saved with test results.
The existing `ui-layout.spec.ts` checks the mobile keyboard and fullscreen
HTML/Markdown. The agentic suite covers authenticated streaming, cancellation,
uploads, approvals, and recovery against isolated test services.

The browser matrix includes desktop Chromium, 402px Chromium and WebKit,
834px iPad WebKit, and 320px Chromium. Tests cover text at 200%, saved image
actions and editing, chat photo previews, appearance persistence, tab state
across window resizing, and focus return. API fixtures contain no personal
conversation data. Install previews are in `public/screenshots/`.

The populated-activity cases check contrast in light and dark appearances,
keyboard disclosure independently of details, search with no matches, and
details at 200% text. Additional cases exercise invalid custom dimensions and
a failed memory save followed by a successful retry with the same draft,
conversation rename cancellation, and populated Autonomy articles with text
scaling and keyboard navigation.

With Node 22, Docker, and Playwright browser dependencies available, run:

```sh
npm test -- --run
npm run lint
npm run e2e -- hig-design.spec.ts ui-layout.spec.ts agentic-app.spec.ts
```

The e2e runner builds the production application and its workers and starts
isolated Redis/object-store services. It removes its test services afterward.

Validated locally on September 7, 2026: production build (including TypeScript
and lint), 740 unit tests, and 66 distinct browser regression cases passed across
the full runs and focused rechecks. The browser coverage comprises 55 design
cases and 11 authenticated integration/layout cases. Four unit cases and three
browser cases remain intentionally skipped by the existing suite.

After the final popover correction, all ten sheet and custom-dimension checks
passed again across the five browser projects. They cover an open settings
panel at 200% text and a tablet window resized to 780px. WebKit ran in the
matching Playwright 1.61.1 container with Node 22 because the host lacked its
system libraries. Test-generated service-worker precache entries are excluded
from the source commit; the production build regenerates them.

Browser emulation can verify the web implementation; it does not substitute
for VoiceOver listening, physical iPhone keyboard behavior, or installation
from Safari. Those device checks should accompany a production release.
