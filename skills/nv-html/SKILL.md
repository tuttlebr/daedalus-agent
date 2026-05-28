---
name: nv-html
description: Generate NVIDIA-branded HTML pages that follow the official brand system — NVIDIA Sans typography, sparing NVIDIA Green (#76B900) accent, alternating dark/light sections, the PACE writing framework, and the component vocabulary defined in DESIGN.md. Use this skill whenever the user asks to create an HTML page, landing page, mini-site, dashboard, status page, event recap, internal portal, or any standalone web deliverable — even when "NVIDIA" is not explicitly named, since the default brand context for this user is NVIDIA. Trigger on requests like "build a page for…", "spin up a landing for…", "make a dashboard showing…", "give me a one-pager on…", "draft an HTML version of…". Replaces generic HTML defaults with NVIDIA standards.
---

# NVIDIA-Branded HTML

Produce HTML pages that read as NVIDIA at a glance: confident typography, alternating dark/light sections, a single hero accent of NVIDIA Green, and copy that follows the PACE framework. The defaults in this skill exist because they encode the brand — deviate only when a request genuinely requires it.

The authoritative brand guide lives in this skill at `references/DESIGN.md`. This skill condenses what you need on-page; read `references/DESIGN.md` directly when a request goes deeper than the lookups here (full color palette, accessibility notes, trademark policy, etc.).

## The non-negotiables

These are the rules that make a page recognizably NVIDIA. If you find yourself skipping one, stop and reconsider.

1. **NVIDIA Sans is the font.** Load it from the variable-font URL below. Do not substitute Inter, system-ui, or "sans-serif" alone — those fall back to the wrong feel.
2. **Green is the hero, not the wallpaper.** Use `#76B900` for at most one or two moments per page: a logo, an active state, a single CTA banner. A page where green appears five times is wrong.
3. **Alternate dark and light sections.** Depth comes from the section background changing, not from gradients or shadows.
4. **High contrast.** White text on black. Black text on white. `#666` for secondary text. No muddy mid-grays for body copy.
5. **Title case for headings, no terminal punctuation in headings.** No exclamation marks anywhere in body or headings.
6. **"NVIDIA" in all caps.** Never "Nvidia" or "nvidia" or "NV." Use "an NVIDIA" (the "en" sound, not "a").
7. **Pair every `background:` with a `color:`.** Any component with a hardcoded background must declare its own text color — never rely on inheritance. A `.card` or `<code>` dropped inside a dark wrapper will otherwise inherit white text onto its own white surface and vanish. This also applies to `<pre>` and `<code>`: they ship with explicit light/dark variants in `starter.html` — don't strip them.

## Quick-reference lookups

### Colors

```css
:root {
  /* Brand */
  --nv-green: #76b900; /* Primary accent — use sparingly */
  --nv-green-dark: #5a8f00; /* Hover/active state for green */

  /* Surfaces */
  --nv-black: #000000; /* Hero, keynote, featured dark sections */
  --nv-dark: #1a1a1a; /* Card backgrounds on dark sections */
  --nv-gray-dark: #333333; /* Secondary dark surfaces, carousels */
  --nv-gray-med: #666666; /* Secondary text */
  --nv-gray-border: #cccccc; /* Separators, borders */
  --nv-gray-light: #eeeeee; /* Sponsor / subtle separation */
  --nv-bg-light: #f7f7f7; /* Light section backgrounds */
  --nv-white: #ffffff; /* Card surfaces, light backgrounds */

  /* Complementary (use sparingly, for variety/categorization) */
  --nv-purple: #952fc6;
  --nv-orange: #ef9100;

  /* Functional (status, callouts) */
  --nv-yellow: #9c5000;
  --nv-blue: #0074df;
  --nv-red: #e52020;

  /* Supporting */
  --nv-magenta: #d2308e;
  --nv-teal: #1d8ba4;
}
```

### Font

Load NVIDIA Sans as a variable font:

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

A shorter alternative is the hosted CSS bundle: `https://images.nvidia.com/etc/designs/nvidiaGDC/clientlibs_base/fonts/nvidia-sans/nvidia-sans.css`. Either works.

### Typography scale

| Element              | Size pattern                                | Weight | Case          |
| -------------------- | ------------------------------------------- | ------ | ------------- |
| H1 (hero)            | `clamp(2.5rem, 6vw, 5rem)`                  | 700    | Title Case    |
| H2 (section)         | `clamp(2rem, 4vw, 3rem)`                    | 700    | Title Case    |
| H3 (subsection)      | `clamp(1.5rem, 3vw, 2rem)`                  | 700    | Title Case    |
| H4 (card)            | `1.25rem`                                   | 700    | Title Case    |
| Body                 | `1rem` (16px)                               | 400    | Sentence case |
| Small / pill / label | `0.75rem` (12px)                            | 500    | Title Case    |
| Pretitle / category  | `0.625rem` (10px), uppercase, letter-spaced | 500    | UPPERCASE     |

Line height `1.6` for body, `1.2` for headings.

### Section rhythm

- Wrap section contents in a `max-width: 1200px` centered container.
- Section padding: `75px 24px` on desktop, `45px 24px` on tablet/mobile.
- Alternate the section `background-color` between `--nv-black`, `--nv-bg-light`, `--nv-white`, and (occasionally) `--nv-gray-light`.
- For exactly one CTA per page, you may use a `--nv-green` full-width banner. Not more than one.

## How to start

For most requests, the fastest correct path is:

1. Copy `assets/starter.html` as the base. It has the font loaded, color tokens defined, and a working dark hero + light section example.
2. Pull components from `assets/components.html` and drop them into the body. Snippets are self-contained and use the CSS variables from the starter.
3. Write copy following `references/voice.md` — the PACE framework and the writing rules that matter most.
4. Before declaring done, run through `references/checklist.md`.

If the request is for something the starter doesn't anticipate (a complex dashboard, a multi-page site, an interactive form), still start from the starter's CSS variables and typography. Those are the brand DNA — don't redefine them.

## Component vocabulary

Pull these from `assets/components.html`. The most common patterns are:

- **Hero** — Full-width black, white H1, optional kicker pretitle, single CTA.
- **Mission/feature cards** — White cards on light section, or dark cards on black section. Subtle shadow `0 0 5px 0 rgba(0,0,0,0.3)`.
- **Pill / badge** — `padding: 4px 8px; border-radius: 18px; font-size: 12px`. Used for tags, categories, status.
- **Stat block** — Large number in NVIDIA Green, small uppercase label below.
- **CTA banner** — Full-width `--nv-green` background, black text, single button. Use once per page maximum.
- **Table** — Title case headers, light header row (`--nv-gray-light`), `--nv-gray-border` row separators.
- **Footer** — Black background, small white text, copyright with current year.

## Writing voice (summary)

Full guide in `references/voice.md`. The summary:

- **PACE**: Professional, Active, Conversational, Engaging.
- Active voice; contractions ("it's", "we'll").
- Sentences under 30 words. Periods, not semicolons.
- No exclamation marks. No "leverage" as a synonym for "use." No "etc.", "i.e.", "e.g." — write them out.
- Oxford commas always.
- Em dashes — no spaces around them.
- En dashes for ranges (12:30–1 p.m.). No spaces.
- Title case in headings; sentence case in subheadings and body.

## What this skill does not do

- **Marketing approval.** Brand-adjacent pages destined for nvidia.com or customer-facing campaigns need Brand Studio review — flag this to the user if the request sounds external/public.
- **Trademark legal copy.** For pages with product trademarks, point the user to `references/DESIGN.md` § Trademark and naming for the legal copy block; don't invent one.
- **Accessibility validation.** Defaults aim for WCAG AA, but a real audit (contrast, keyboard, screen reader) is the user's job before shipping anything external.

## When in doubt

Read `references/DESIGN.md`. It is the source of truth — if this skill and DESIGN.md disagree, DESIGN.md wins, and please update this skill to match.
