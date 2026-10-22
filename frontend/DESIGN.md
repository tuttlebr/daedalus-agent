# Apple HIG adaptation for the Daedalus PWA

Daedalus remains a Next.js progressive web app. This implementation adapts
Apple's interaction and visual guidance for touch on iPhone, resizable iPad
windows, and pointer/keyboard use on Mac and other desktop browsers. It does
not use SwiftUI, distribute SF Symbols, or claim native Liquid Glass rendering.

## Design decisions

- Content comes first: quiet solid backgrounds and cards, a readable chat
  column, a gallery of actual images, concise empty states, and a single
  accent color for interactive emphasis. Messages and the composer share one
  column capped at 52rem, so prose stays near 70-90 characters per line;
  tables and code scroll inside it rather than breaking words. The welcome
  suggestions, Autonomy, Memory and Connections use the same rail, so their
  edges stay in place when switching tabs. Phones omit message avatars, as in
  a one-to-one thread. Responses collapse only when they would hide a
  substantial part of a long answer.
- Liquid Glass layering: content scrolls beneath the toolbar and, on wider
  windows with the keyboard closed, beneath the composer, which float over it.
  Scroll containers reserve both heights, measured as they change, so first
  and last items rest clear of the controls; a reader at the newest message
  stays there when the composer grows. A scroll edge fades content into the
  canvas under each bar. The canvas washes fade out near the top and bottom
  edges, so Safari's title bar, the toolbar edge and the composer edge meet
  one flat canvas color. Phones and keyboard layouts keep the composer below
  the messages.
- Window geometry: floating panels (the sidebar, the Create inspector and a
  fullscreen document's page) keep one 8px inset from the window. On pointer devices their corners are
  concentric with the window's (Safari web-app windows on macOS 26 round at
  about 16px, so panels use 8px); touch layouts keep the sheet radius. The
  resize divider covers the gap beside the sidebar instead of adding width.
  The sidebar's header shares the toolbar's center line, and its fills and
  its icons and labels each share one leading edge.
- Pointer and touch sizes: with a pointer, rows are 32px and form controls,
  segmented controls and composer buttons 36px; toolbar controls and groups
  are 44px. Coarse pointers keep 44px targets, including iPad at desktop
  widths. Hover-only controls take no space: a message's actions appear over
  its outer top corner, and a conversation's More button over the end of its
  row. Touch shows both at all times.
- Text uses title-style capitalization for headers, tabs and section labels;
  nothing is set in all capitals. Code and diagrams use the monospace face,
  while a code block's language label and buttons are interface text.
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
  settings sheets use solid surfaces. Increased contrast removes backdrop
  filters and makes the scroll edges opaque. WebKit does not report the
  system's Reduce Transparency setting to pages, so a Reduce transparency
  switch beside Appearance does the same; it persists and applies before
  hydration. Reduced motion removes transitions and smooth scrolling.
  Forced-colors selection retains a visible outline. Scroll indicators are
  the platform's own, so macOS and iOS overlay scrollers follow system
  settings and appearance.
- Five peer destinations remain visible in the mobile tab bar, whose items
  share its width while every label fits on one line. Commands are placed in
  toolbars. Wider windows, including phones in landscape, use one toolbar
  with the sidebar toggle, labeled tabs with arrow/Home/End navigation and
  the shown destination's own controls: in Chat, the conversation title and
  New chat; in Create, the mode and panel controls; elsewhere, Refresh and
  workspace commands. Without the toolbar, those controls stay in the page.
  Single toolbar commands are glass circles and related ones share a glass
  group, all one height. Tab labels give way to icons before a title or a
  destination's controls are squeezed. The toolbar's New chat appears while
  the sidebar is hidden, since the open sidebar offers New Chat; wide windows
  close the sidebar from the toolbar, and the phone drawer keeps its Close
  button. The sidebar has an adjustable divider and lists conversations
  only; destinations are not repeated there. Visited tabs retain drafts,
  selections, and scroll position.
- Destinations other than Chat share one page header: a title with an
  optional status, a description, and commands that move into the toolbar on
  wide windows. View switches and filters share one segmented control: a
  raised thumb on a tinted track, or a glass group inside the toolbar.
- An HTML response names itself and holds all its commands, including View
  fullscreen, in one header inside its message, and its page's corners are
  concentric with the bubble's. In a narrow message the command labels give
  way to icons before the title is squeezed. The fullscreen viewer has one
  toolbar placed like the window toolbar: the title, the document's commands
  in a glass group and a Close circle. Its HTML page floats below at the
  window inset; Markdown scrolls beneath a scroll edge instead of a divider.
- Each conversation has one More button whose menu offers Rename, Download
  Activity and Delete. The menu is a top-layer popover with arrow-key
  navigation; Escape and canceled actions return focus to the More button.
  Deleting or clearing conversations asks for confirmation with labeled
  Cancel and destructive buttons.
- Safe-area padding and the existing visual viewport keyboard compensation
  remain part of the PWA shell. Zoom remains enabled.
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

## Alaska palette

Design credit: _Alaska, by Alicia Curley_. The seven source swatches are
`#161D27`, `#253D56`, `#4C6D8B`, `#9DB5B5`, `#B69BA6`, `#F5A35F`, and `#FFC04A`.
The supplied specification also allows white, `#F5F7F8`, the light surface
`#EFF3F3`, and the raised dark surface `#2C4A68`. One role sits outside the
swatches: destructive actions use red, as the platform does, because mauve
read as a disabled control.

`styles/appearance.css` is the color authority. Public CSS color tokens use the
names below; RGB channel aliases support Tailwind opacity utilities and legacy
`nvidia-*` names. Components consume semantic tokens. Theme selection sets
`data-theme` and the existing Tailwind `dark` class together, including before
hydration. System follows the OS; manual Light/Dark choices persist.

| Token                 | Light     | Dark      |
| --------------------- | --------- | --------- |
| `--bg-canvas`         | `#FFFFFF` | `#161D27` |
| `--bg-surface`        | `#EFF3F3` | `#253D56` |
| `--bg-surface-raised` | `#FFFFFF` | `#2C4A68` |
| `--bg-user-bubble`    | `#4C6D8B` | `#4C6D8B` |
| `--bg-bot-bubble`     | `#9DB5B5` | `#253D56` |
| `--text-primary`      | `#161D27` | `#F5F7F8` |
| `--text-secondary`    | `#4C6D8B` | `#9DB5B5` |
| `--text-on-accent`    | `#161D27` | `#161D27` |
| `--text-on-user`      | `#F5F7F8` | `#F5F7F8` |
| `--accent-primary`    | `#F5A35F` | `#F5A35F` |
| `--accent-secondary`  | `#FFC04A` | `#FFC04A` |
| `--accent-neutral`    | `#B69BA6` | `#B69BA6` |
| `--border-subtle`     | `#9DB5B5` | `#4C6D8B` |
| `--destructive`       | `#C62828` | `#FFA198` |

User bubbles use the component rule's light text (5.05:1), resolving the conflicting
mention of user bubbles under `--text-on-accent`. Bot text measures 7.84:1 in light
mode and 10.39:1 in dark mode. Filled primary actions use apricot with navy text
(8.30:1), switching to gold on hover (10.40:1). Links remain readable blue or inherit
message text with an underline. Gold is used as a fill, never as bot message text.
Minor errors use mauve borders/tints, normal primary text, and existing labels/icons.
Destructive actions (Delete, Clear, Clear all memory, Remove from workspace) use the
destructive role: filled buttons carry white text in light mode (5.62:1) and navy text
in dark mode (8.72:1); as text it measures 5.62:1 on white and 4.72:1 on raised blue.
`--destructive` holds RGB channels, like the other roles used with opacity.

Two local text adjustments satisfy AA without adding colors: secondary text on
a light bot bubble uses deep slate (5.16:1), and secondary text/placeholders on
raised dark surfaces use the allowed light neutral (8.55:1). The unadjusted
pairings are 2.51:1 and 4.25:1 respectively. Input boundaries use steel in light
mode and blue-green in dark mode, separate from decorative subtle dividers.
Focus has a 2px apricot outer outline and a contrasting inner edge, since apricot
against white alone is only 2.04:1. Increased-contrast and forced-colors modes
retain their accessibility overrides.

Browser chrome, including Safari's web-app title bar, reads the canvas token. The
first response carries a theme-color tag for each system appearance, the
pre-hydration script applies an explicit Light or Dark choice to both, and the app
keeps them current. The install manifest uses white, and
`npm run branding` refreshes its content-hashed references. `npm run appearance`
embeds the shared theme definitions into `public/offline.html`; the production
build also runs this generator so offline recovery needs no stylesheet request.
The existing icon artwork and generated/user document content retain their own
artwork. Code highlighting and built-in chart styling consume palette tokens.

Palette regression coverage lives in `e2e/tests/hig-design.spec.ts`: both themes,
populated messages and errors, Markdown, primary-action hover, focus, placeholders,
input boundaries, appearance persistence, the first response's theme-color tags,
reduced transparency, and WCAG AA scans. Browser emulation does
not replace physical-device or assistive-technology checks.

## Source guidance

Apple's documentation overview includes native framework choices; its linked
HIG informs this web implementation.

- [App design and UI](https://developer.apple.com/documentation/technologyoverviews/app-design-and-ui)
- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)

## Verification

`e2e/tests/hig-design.spec.ts` uses deterministic API fixtures to inspect all
five destinations in light/dark appearance, enlarged text, reduced motion,
increased contrast, navigation state, and modal keyboard behavior. Axe checks
WCAG A/AA rules in each destination. Screenshots are saved with test results.
The existing `ui-layout.spec.ts` checks the mobile keyboard and fullscreen
HTML/Markdown, including the viewer's single toolbar and window inset. The agentic suite covers authenticated streaming, cancellation,
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
the conversation menu's keyboard navigation and rename cancellation, and
populated Autonomy articles with text scaling and keyboard navigation. Layout
cases check that wide windows use a single toolbar with even margins while
phones keep the Chat header, that the new-chat welcome centers between the
floating toolbar and composer, that tab bar items share its width, that inline
code shows no Markdown backticks, that scroll indicators are native, and that
table cells keep words whole while wide tables scroll inside the response.

On macOS, WebKit moves Tab focus to buttons only when the system's keyboard
navigation setting is on, as in Safari. Checks that Tab to a button therefore
fail in local macOS WebKit runs with the default setting; CI runs Linux WebKit.

With Node 22, Docker, and Playwright browser dependencies available, run:

```sh
npm test -- --run
npm run lint
npm run e2e -- hig-design.spec.ts ui-layout.spec.ts agentic-app.spec.ts
```

The e2e runner builds the production application and its workers and starts
isolated Redis/object-store services. It removes its test services afterward.

Browser emulation can verify the web implementation; it does not substitute
for VoiceOver listening, physical iPhone keyboard behavior, or installation
from Safari. Those device checks should accompany a production release.

## iPhone web app compatibility

The frontend targets iPhone 16 and newer in Safari and as a Home Screen web app,
using the iOS 18 web platform as its baseline. Layout follows viewport geometry,
safe-area insets, and pointer capabilities rather than a phone-model allowlist.
The existing visual-viewport hook retains keyboard, rotation, body-pan recovery,
and pinch-zoom behavior. Landscape Chat reserves the home-indicator inset when
bottom navigation is hidden; keyboard-open layout does not add it again.

Safari receives Share → Add to Home Screen instructions, including the optional
Open as Web App setting on newer iOS releases. Installed apps suppress those
instructions. The prompt respects dismissal and stays out of typing and modal
flows. Launch branding uses the manifest and Apple touch icon; square app icons
are not declared as full-screen startup images.

Downloads prepared asynchronously use `useFileSave`: iOS receives an in-app
Save action after the bytes are ready, and that new tap opens the native share
sheet. Cancellation keeps the user in the app; share failures retain the file
for retry. This covers Chat images, sandbox files, converted Markdown, code,
charts, diagrams, and activity exports. Create retains its prefetched original
image save action. Other platforms keep ordinary file downloads. The bytes are
not re-encoded by the save flow.

Touch actions remain visible in landscape, and Return inserts a newline on
coarse-pointer devices regardless of width. Chat accepts HEIC/HEIF camera photos,
including Files selections without a MIME type, and retains the normalized MIME
type returned by the existing image service. Sign-in disables username spelling
corrections and capitalization without disabling password-manager autofill.

`e2e/tests/iphone-webapp.spec.ts` covers six representative screen sizes from
390 to 440 CSS pixels wide, browser and standalone modes, and both orientations.
It checks all five destinations, safe-area geometry, landscape Return behavior,
installation guidance, and file saving. The share API and standalone flags are
simulated; browser tests cannot exercise the native iOS share sheet, installation,
or a physical software keyboard. Before a device release, check those flows on
an installed iPhone app, along with VoiceOver and returning after device lock.
Use the existing HIG and viewport suites for enlarged text, light/dark appearance,
dialog focus, pinch zoom, and keyboard restoration.

Platform references:

- [Apple's Home Screen web app guidance](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios)
- [WebKit safe-area layout](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)
- [WebKit user activation and asynchronous file sharing](https://webkit.org/blog/13862/the-user-activation-api/)
