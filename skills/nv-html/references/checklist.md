# NVIDIA HTML Pre-Ship Checklist

Run through this before declaring an HTML page done. Each item links a brand rule from `DESIGN.md` to something you can actually look at in the rendered page.

## Brand identity

- [ ] **NVIDIA Sans loaded.** A `@font-face` rule (or the hosted CSS bundle) points at the official URL. Page does not fall back to system fonts.
- [ ] **"NVIDIA" is always in all caps.** Search the rendered text. No "Nvidia," "nvidia," or "NV."
- [ ] **"an NVIDIA"** wherever the article appears. Never "a NVIDIA."
- [ ] **Product names prefixed with NVIDIA on first mention** (e.g., "NVIDIA Triton" not just "Triton").

## Color

- [ ] **NVIDIA Green (#76B900) appears sparingly.** Aim for one or two hero moments per page (CTA, accent, active state). Not as section backgrounds, not as body text, not on more than one button per fold.
- [ ] **Complementary colors (purple, orange) used only for variety/categorization,** not as primary accents.
- [ ] **Functional colors (red, blue, yellow) used only for status/callouts,** not as decorative accents.

## Layout & rhythm

- [ ] **Sections alternate dark and light.** No three light-on-light or three dark-on-dark sections in a row.
- [ ] **Depth from background changes, not gradients or heavy shadows.**
- [ ] **One CTA banner per page maximum.** Multiple green CTA banners flatten the impact.
- [ ] **Content container is centered with a max-width** (~1200px). No edge-to-edge body text.
- [ ] **Section padding follows the scale** (75px desktop, 45px mobile vertical).

## Typography

- [ ] **Headings in Title Case.** Every major word capitalized. Conjunctions/short prepositions lowercase.
- [ ] **No terminal punctuation in headings.** No periods or exclamation marks.
- [ ] **No exclamation marks in body either.**
- [ ] **Body text is sentence case.**
- [ ] **Heading hierarchy is not skipped** (h2 → h3 → h4, not h2 → h4).
- [ ] **Body line-height around 1.6.** Heading line-height tighter (~1.2).

## Copy

- [ ] **PACE check** — Professional, Active, Conversational, Engaging.
- [ ] **Active voice throughout.** No "is being done by" constructions.
- [ ] **Contractions used.** "It's," "we'll," "you're."
- [ ] **Sentences under 30 words.** Long ones broken with periods.
- [ ] **No Latinisms.** "for example" not "e.g.", "and so on" not "etc.".
- [ ] **No "leverage" as a synonym for "use."**
- [ ] **Oxford commas in lists of three or more.**
- [ ] **Em dashes have no spaces** (— like this, not — like this with weird spacing).
- [ ] **En dashes for ranges** (12:30–1 p.m., 2024–2026).

## CTAs and buttons

- [ ] **CTA labels in Title Case** (Learn More, Register Now, Contact Us).
- [ ] **No "Click Here" or generic labels.** Use the verb + noun the user is acting on.
- [ ] **No punctuation in button labels.**

## Links

- [ ] **No bare URLs in running text.** Hyperlinked destination titles.
- [ ] **Descriptive anchor text.** Not "here" or "read more."

## Accessibility

- [ ] **Descriptive alt text** on every meaningful image. Decorative images get `alt=""`.
- [ ] **Color contrast meets 4.5:1** for body text (white on #000 ✓, black on #FFF ✓, white on #76B900 ✗ — use black on green).
- [ ] **Headings used semantically,** not picked for size.
- [ ] **Focus states visible** for keyboard navigation.
- [ ] **No information conveyed by color alone** (status badges include text, not just a dot).

## Responsive

- [ ] **Renders correctly at 375px** (mobile).
- [ ] **Renders correctly at 768px** (tablet).
- [ ] **Renders correctly at 1200px+** (desktop).
- [ ] **Section padding reduces on mobile.**
- [ ] **Card grids collapse to single column on mobile.**

## Technical

- [ ] **Page is self-contained** (no external stylesheets except the NVIDIA font URL, unless the project requires otherwise).
- [ ] **`<meta name="viewport">` present.**
- [ ] **Page has a `<title>` in title case.**
- [ ] **HTML is semantic** (header, main, section, footer — not divs everywhere).

## Final pass

- [ ] **Read the page out loud.** If a sentence doesn't sound like speech, rewrite it.
- [ ] **Squint test.** Step back from the screen. Does NVIDIA Green pop where you want attention? Or is the page a soup of accent colors?
- [ ] **No placeholder text remaining.** No "Lorem ipsum," no "TODO," no `<!-- placeholder -->`.
