# NVIDIA HTML Brand Guide

This is the authoritative brand reference for the `nv-html` skill. `SKILL.md` is the on-page condensation. When the two diverge, this file wins — and `SKILL.md` should be updated to match.

The audience for this file is the model generating an NVIDIA-branded HTML page. Read it when a request goes deeper than the lookups in `SKILL.md` — full color palette, accessibility rules, trademark policy, or any edge case the starter doesn't anticipate.

## Source of truth

NVIDIA Brand Studio maintains the public brand system. This document mirrors the parts of that system that matter for self-contained HTML deliverables — internal portals, status pages, one-pagers, mini-sites, dashboards, event recaps. For anything destined for nvidia.com or external campaigns, this document is necessary but not sufficient: external work needs Brand Studio review.

## Color palette

### Primary

| Token             | Hex       | Use                                                                                                                                                                                                        |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--nv-green`      | `#76B900` | The NVIDIA accent. One or two hero moments per page — a logo, a single CTA, an active state. Never as section background repeated more than once. Never as body text. Never as the only signal of meaning. |
| `--nv-green-dark` | `#5A8F00` | Hover/active state of green elements.                                                                                                                                                                      |

### Surfaces

| Token              | Hex       | Use                                                                                           |
| ------------------ | --------- | --------------------------------------------------------------------------------------------- |
| `--nv-black`       | `#000000` | Hero, keynote, featured dark sections. Default for high-contrast backgrounds.                 |
| `--nv-dark`        | `#1A1A1A` | Card backgrounds inside dark sections. Code blocks inside dark sections.                      |
| `--nv-gray-dark`   | `#333333` | Secondary dark surfaces, carousels, inline `<code>` inside dark sections.                     |
| `--nv-gray-med`    | `#666666` | Secondary text. Tags, labels, captions. Not for body copy.                                    |
| `--nv-gray-border` | `#CCCCCC` | Separators, borders, hairlines.                                                               |
| `--nv-gray-light`  | `#EEEEEE` | Sponsor row backgrounds, subtle separation, default code-block backgrounds on light sections. |
| `--nv-bg-light`    | `#F7F7F7` | Default light section background. Slightly warmer than pure white.                            |
| `--nv-white`       | `#FFFFFF` | Card surfaces on light sections, alternate light section background.                          |

### Complementary

Use these for variety or categorization (event tracks, pill colors, content tags). Never as a primary accent in place of green.

| Token         | Hex       | Use              |
| ------------- | --------- | ---------------- |
| `--nv-purple` | `#952FC6` | Category accent. |
| `--nv-orange` | `#EF9100` | Category accent. |

### Functional

Use these only for status, callouts, and meaning. Not decorative.

| Token         | Hex       | Use                                                                                                                   |
| ------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `--nv-red`    | `#E52020` | Errors, failure status, destructive actions.                                                                          |
| `--nv-yellow` | `#9C5000` | Warnings, degraded status. (This is the brand-accessible amber — not the canvas yellow `#F9C500` used for live dots.) |
| `--nv-blue`   | `#0074DF` | Information, tutorial pills, links inside dark contexts.                                                              |

### Supporting

| Token          | Hex       | Use                                                |
| -------------- | --------- | -------------------------------------------------- |
| `--nv-magenta` | `#D2308E` | Reserved for event branding and editorial accents. |
| `--nv-teal`    | `#1D8BA4` | Reserved for event branding and editorial accents. |

## Text Contrast And Color Pairing

Treat text color and background color as a pair. Every visible text element must meet WCAG AA contrast against the surface it renders on: 4.5:1 for body and UI text, and 3:1 for large text (24px+ or 18px+ bold). If the foreground color is the same as, or visually close to, the background color, the page fails even when the CSS technically declares both values.

Use these default pairs:

| Background                      | Safe text colors                                                      | Unsafe text colors                                           |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `--nv-black`, `--nv-dark`       | `--nv-white`, `--nv-gray-light`, `--nv-green` for labels/headings     | `--nv-black`, `--nv-gray-med`, dark decorative colors        |
| `--nv-white`, `--nv-bg-light`   | `--nv-black`, `--nv-gray-med`, `--nv-blue`, `--nv-red`, `--nv-yellow` | `--nv-white`, `--nv-green`, `--nv-green-dark`, `--nv-orange` |
| `--nv-gray-light`               | `--nv-black`, `--nv-gray-med`, `--nv-yellow`                          | `--nv-white`, `--nv-green`, `--nv-green-dark`, `--nv-orange` |
| `--nv-green`, `--nv-green-dark` | `--nv-black`                                                          | `--nv-white`, `--nv-gray-light`, `--nv-green`                |
| `--nv-orange`                   | `--nv-black`                                                          | `--nv-white`, `--nv-gray-light`, `--nv-orange`               |
| `--nv-blue`, `--nv-red`         | `--nv-white`                                                          | Same-color text or low-contrast grays                        |

Do not use NVIDIA Green or orange as body text, small labels, metric deltas, or inline links on light surfaces. Put those colors in non-text accents: borders, underline colors, status dots, icons, badge backgrounds, or section accents. Links on light backgrounds should use black text with a green underline or other green accent, not green text.

## Typography

### Font

NVIDIA Sans is the only correct typeface. Load the variable font:

```html
<style>
  @font-face {
    font-family: 'NVIDIA Sans';
    src: url('https://images.nvidia.com/etc/designs/nvidiaGDC/clientlibs_base/fonts/nvidia-sans/NALA/var/NVIDIASansVF_NALA_W_Wght.woff2')
      format('woff2-variations');
    font-weight: 100 900;
    font-display: swap;
  }
  body {
    font-family: 'NVIDIA Sans', system-ui, sans-serif;
  }
</style>
```

The hosted CSS bundle is an acceptable shorthand: `https://images.nvidia.com/etc/designs/nvidiaGDC/clientlibs_base/fonts/nvidia-sans/nvidia-sans.css`.

Do not substitute Inter, system-ui alone, or `"sans-serif"` alone. Those fall back to the wrong feel.

### Scale

| Element              | Size                                        | Weight | Case          |
| -------------------- | ------------------------------------------- | ------ | ------------- |
| H1 (hero)            | `clamp(2.5rem, 6vw, 5rem)`                  | 700    | Title Case    |
| H2 (section)         | `clamp(2rem, 4vw, 3rem)`                    | 700    | Title Case    |
| H3 (subsection)      | `clamp(1.5rem, 3vw, 2rem)`                  | 700    | Title Case    |
| H4 (card)            | `1.25rem`                                   | 700    | Title Case    |
| Body                 | `1rem` (16px)                               | 400    | Sentence case |
| Small / pill / label | `0.75rem` (12px)                            | 500    | Title Case    |
| Pretitle / category  | `0.625rem` (10px), uppercase, letter-spaced | 500    | UPPERCASE     |

Line height `1.6` for body, `1.2` for headings.

### Letter spacing

- H1: `-0.02em` — tighter, larger headings need the negative tracking.
- H2: `-0.01em` — slight tightening.
- H3 and below: default (0).
- Pretitle / category / pill: `0.15em` — wide tracking for uppercase legibility.

## Section rhythm

- Wrap section contents in a `max-width: 1200px` centered container.
- Section padding: `75px 24px` on desktop, `45px 24px` on tablet/mobile.
- Alternate `background-color` between `--nv-black`, `--nv-bg-light`, `--nv-white`, and (occasionally) `--nv-gray-light`. No three light-on-light or three dark-on-dark in a row.
- One CTA banner per page maximum. A green full-width band with black text and a single black-on-white button.
- Depth comes from background changes, not gradients or heavy shadows. The only allowed shadow is the card shadow: `0 0 5px 0 rgba(0, 0, 0, 0.3)`.

## Code and monospace

Code-block defaults ship in `starter.html` and are not optional. They define both background and text color so they survive being placed inside any section, dark or light.

- Inline `<code>`: `--nv-gray-light` background, `--nv-black` text on light sections. `--nv-gray-dark` background, `--nv-white` text on dark sections (`.section.dark` or `.hero`).
- Block `<pre>`: `--nv-gray-light` / black on light, `--nv-dark` / white on dark with a `--nv-gray-dark` border.
- Monospace stack: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`.

If you find yourself wrapping commands in styled `<div>` boxes instead of `<pre>` / `<code>`, stop and use the semantic elements — the styling is already correct.

## Accessibility

- **Contrast ratio: minimum 4.5:1 for body text, 3:1 for large text (24px+ or 18px+ bold).** White on `#000000` passes. Black on `#FFFFFF` passes. `#666666` body text on white passes (5.74:1) — that's the ceiling for "secondary gray." Anything lighter than `#666666` on white is not safe for body copy.
- **NVIDIA Green is not an accessible text color on light surfaces.** `#76B900` on white fails (about 2.4:1). `#5A8F00` on white also fails normal body-text contrast (about 3.9:1). On black, NVIDIA Green passes and can be used for labels or headings, but still avoid long green paragraphs. White text on `#76B900` fails — always use black text on a green background, never white.
- **Orange is not an accessible text color on light surfaces.** `#EF9100` on white fails. Use black text on orange backgrounds, or use orange as a non-text accent.
- **Links must be readable before and after hover.** On light backgrounds, keep link text black and use green for underlines, borders, icons, or adjacent accents. On dark backgrounds, white links with a green underline are safe.
- **Don't convey meaning by color alone.** Status indicators need a text label ("Healthy", "Degraded", "Down") in addition to the dot color. Error states need an icon or copy, not just a red border.
- **Focus states must be visible** for keyboard navigation. Don't `outline: none` without a replacement.
- **Headings used semantically, not picked for size.** `h2 → h3 → h4`, not `h2 → h4`. If you need a section break inside a card, use a `<h4>` or a typography utility — not an out-of-order tag.
- **Descriptive alt text** on every meaningful image. Decorative images get `alt=""`.
- **Reduced motion**: respect `prefers-reduced-motion` for any auto-playing animation. The starter has no animations; keep it that way unless explicitly asked.

The defaults in this skill aim for WCAG 2.1 AA. A real audit (screen reader walk-through, keyboard navigation, contrast spot-checks at every breakpoint) is still required before shipping anything external.

## Trademark and naming

- **"NVIDIA" is always all caps.** Never "Nvidia," "nvidia," or "NV." This includes meta tags, URLs in visible text (the URL itself can be lowercase, but the copy that describes it spells it NVIDIA), and footer copy.
- **Article: "an NVIDIA"** because of the "en" sound. Never "a NVIDIA."
- **Product names get the NVIDIA prefix on first mention** — e.g., "NVIDIA Triton," "NVIDIA TensorRT-LLM," "NVIDIA NIM microservices." Once established on the page, subsequent mentions can drop the prefix.
- **No `™`, `®`, or `©` in body copy** unless the page is a legal notice or the user explicitly requests them. Trademark legal copy belongs in a footer block sourced from NVIDIA legal, not invented by the model. For any page that calls out specific products in customer-facing contexts, flag to the user that they need to add the official trademark attribution block before shipping.
- **No casual nicknames** for products. "Triton Inference Server" stays as is — not "Tritie" or "TIS."
- **Copyright line in footers**: `© <current year> NVIDIA Corporation. All rights reserved.` Use the en-dash `©` glyph, not `(c)`.

## Voice (one-line summary)

Full guide in `voice.md`. The short version: PACE — Professional, Active, Conversational, Engaging. Active voice. Contractions. Sentences under 30 words. No exclamation marks. No "leverage" as a synonym for "use." No "etc.", "i.e.", "e.g." — write them out. Oxford commas. Em dashes without spaces. En dashes for ranges.

## When this guide is silent

If you have a question this file doesn't answer:

1. Check `SKILL.md` — it may have the answer in a shorter form.
2. Check `references/voice.md` for copy questions.
3. Check `references/checklist.md` for pre-ship verification.
4. If none of those resolve it, ask the user. Do not invent brand rules.
