# NVIDIA Website Branding & Design Guide

Use these guidelines when building NVIDIA-themed web pages. The design language is clean, high-contrast, typographically driven, and uses NVIDIA Green sparingly as the hero accent on a dark/light alternating layout.

---

## Primary and Brand Colors

NVIDIA is primarily a mono-color company with a hero color.
Allow green to stand out as our unifying brand color.

| Color        | Hex     | RGB               | Pantone | Role          |
| ------------ | ------- | ----------------- | ------- | ------------- |
| NVIDIA Green | #76B900 | RGB(118, 185, 0)  | 376 C   | Primary       |
| Purple       | #952FC6 | RGB(149, 47, 198) | 2084    | Complimentary |
| Orange       | #EF9100 | RGB(239, 145, 0)  | 1235    | Complimentary |
| Yellow       | #9C5000 | RGB(249, 197, 0)  | 115 C   | Functional    |
| Blue         | #0074DF | RGB(0, 116, 223)  | 2193 C  | Functional    |
| Red          | #E52020 | RGB(229, 32, 32)  | 1788 C  | Functional    |
| Magenta      | #D2308E | RGB(210, 48, 142) | 2039 C  | Supporting    |
| Teal         | #1D8BA4 | RGB(29, 187, 164) | 3262 C  | Supporting    |

---

## Background & Surface Hierarchy

Create visual rhythm by alternating dark and light sections. Depth comes from background color changes, not heavy shadows or gradients.

| Surface             | Hex     | Usage                                     |
| ------------------- | ------- | ----------------------------------------- |
| Primary Dark        | #000000 | Hero, keynote, featured sections          |
| Secondary Dark      | #333333 | Carousels, testimonial areas              |
| NVIDIA Green Accent | #76B900 | Full-width CTA banners (use sparingly)    |
| Medium Light Gray   | #EEEEEE | Sponsor sections, subtle separation       |
| Light Gray          | #F7F7F7 | Content sections (topics, resources)      |
| White               | #FFFFFF | Card surfaces, general content, dropdowns |

**Text on dark backgrounds:** `#FFFFFF`
**Text on light backgrounds:** `#000000`
**Secondary text:** `#666666`
**Separators/borders:** `#CCCCCC`

---

## Typography

**Font Family:** `"NVIDIA Sans"` — a custom variable font. Load as a variable font with weight axis:

```
https://images.nvidia.com/etc/designs/nvidiaGDC/clientlibs_base/fonts/nvidia-sans/NALA/var/NVIDIASansVF_NALA_W_Wght.woff2
```

**Icon Font:** Font Awesome (chevrons, arrows, social icons)

### Font Sizes

| Size  | Usage                                 |
| ----- | ------------------------------------- |
| 10px  | Pretitle/category labels on cards     |
| 11px  | Image credit overlays                 |
| 12px  | Badges, pills, small labels           |
| 14px  | Dropdown items, nav labels, body text |
| 16px+ | Body paragraphs, descriptions         |

### Font Weights

| Weight | Usage                   |
| ------ | ----------------------- |
| 300    | Light variants (icons)  |
| 400    | Body text, dropdowns    |
| 500    | Pills, badges, labels   |
| 700    | Nav CTAs, bold callouts |

### Heading Scale (CSS classes)

Use a consistent heading hierarchy:

- **H1 (hero):** Large, centered, white on dark background
- **H2 (section):** Medium, section titles
- **H3 (subsection):** Small, panel/subsection titles
- **H4 (card):** Smaller, carousel/card titles
- **H5 (compact):** Smallest, topic card titles

---

## Layout

### Grid System

12-column grid with responsive breakpoints:

| Breakpoint | Name    | Range           |
| ---------- | ------- | --------------- |
| Phone      | mobile  | < 640px         |
| Tablet     | tablet  | 640px – 1023px  |
| Laptop     | laptop  | 1024px – 1349px |
| Desktop    | desktop | >= 1350px       |

### Common Column Patterns

- **Full width:** 12 columns
- **Centered content:** 10 columns with 1-column offset each side
- **Two-column feature:** 2 cols desktop, 1 col mobile
- **Card grids:** 4 cols desktop, 2 cols tablet, 1 col phone

### Spacing Scale

Use consistent padding values (in px): `0, 8, 15, 30, 45, 60, 75, 90, 120`

Typical section spacing:

- **Desktop:** `padding-top: 75px; padding-bottom: 75px`
- **Tablet:** `padding-top: 45px; padding-bottom: 45px`
- **Mobile:** `padding-top: 45px; padding-bottom: 45px`
- **Content padding:** `padding-left: 15px; padding-right: 15px`

---

## Components

### Buttons

**Primary CTA:**

- Background: `#000000` (or NVIDIA Green for accent CTAs)
- Text: `#FFFFFF`
- Font weight: 700
- Hover: slight opacity or color shift

**Ghost / Transparent:**

- Background: transparent
- Border: matches button color
- Hover: 10% opacity fill of border color

**Alignment:** Center-align buttons on all breakpoints by default.

### Cards / Teasers

- White background (`#FFFFFF`) with card elevation
- Structure: Image (top) + Text container (title, description, action link)
- Box shadow: `0 0 5px 0 rgba(0, 0, 0, 0.3)`
- Action links use a right-chevron icon (Font Awesome `fa-angle-right`)
- Responsive images with lazy loading
- Clamp title rows per breakpoint (2–3 lines)

### Badges / Pills

- `display: inline-flex; align-items: center; gap: 6px`
- `padding: 4px 8px; border-radius: 18px`
- `font-size: 12px; font-weight: 500`
- Border variant: `border: 1.5px solid #898989; background: #FFF`
- Color-coded variants:
  - **Orange** (`#EF9100`): Talks, panels — dark text
  - **Blue** (`#0046A4`): Tutorials — white text
  - **Red dot** (`#E52020`, 8px circle): Live indicator

### Hero Section

- Full-width, black background (`#000000`)
- Video or image as background (centered, cover-fit)
- Content overlay: centered text, white headings
- Entry animation: scale from 0 to 1 + opacity fade over 2 seconds
  ```css
  transition: transform 2s ease-out, opacity 2s ease-out;
  transform-origin: center center;
  ```

### Navigation

- Dark themed nav bar
- Brand logo + event info in top bar
- Dropdown menus with `box-shadow: 0 6px 9px rgba(0, 0, 0, 0.175)`
- Sticky in-page navigation for long pages
- Mobile: full-screen black menu overlay with `transition: all 0.1s`

### Separators

- Thin rule: 2px height, `background-color: #CCC`
- Spacers: variable heights (7px, 10px, 20px, 45px) for vertical rhythm

### Carousels

- Horizontal scroll with previous/next arrows (Font Awesome chevrons)
- Optional dot indicators
- Fixed-width slides or flexible
- Auto-advance with configurable delay (~5 seconds)

---

## Visual Effects

### Shadows

- Cards: `box-shadow: 0 0 5px 0 rgba(0, 0, 0, 0.3)`
- Dropdowns: `box-shadow: 0 6px 9px rgba(0, 0, 0, 0.175)`

### Transitions

- Standard: `transition: 0.2s ease-out`
- Dropdowns: `transition: transform 0.3s ease`
- Mobile menus: `transition: all 0.1s`
- Hero animations: `transition: transform 2s ease-out, opacity 2s ease-out`

### Approach

- Depth is created through **background color alternation** between sections, not heavy gradients
- Minimal shadow usage — mostly on interactive elements (cards, dropdowns)
- Green accent used sparingly for maximum impact (logo, one CTA banner, active states)

---

## Images

- **Lazy loading** with IntersectionObserver (300px root margin)
- **Responsive** via `<picture>` + `<source>` per breakpoint
- **Background images:** cover-fit, centered
- **SVG preferred** for logos and icons
- **Image credits:** positioned absolutely in corners, small text (11px), semi-transparent

---

## Key Design Principles

1. **Dark/light alternation** — Alternate `#000`, `#F7F7F7`, `#FFF`, and `#EEE` sections for visual rhythm
2. **Green is the hero** — Use NVIDIA Green (#76B900) sparingly so it commands attention when it appears
3. **Typography-driven** — Let the NVIDIA Sans font do the heavy lifting; avoid decorative elements
4. **High contrast** — White text on black, black text on white — no muddy middle ground
5. **Clean, minimal** — Minimal shadows, no heavy borders, no gradients on surfaces
6. **Responsive-first** — Four breakpoints, section spacing and column counts adapt at each

---

## Writing Voice & Tone

Use straightforward language and a natural, conversational voice. Speak directly and clearly, with respect for the audience's intelligence. Use active, present-tense language and contractions ("it's" rather than "it is").

### The PACE Framework

All copy should follow PACE:

| Letter | Attribute      | Description                                                                            |
| ------ | -------------- | -------------------------------------------------------------------------------------- |
| P      | Professional   | NVIDIA is experienced, credible, and proven experts in everything we do.               |
| A      | Active         | Use verbs in your copy (discover, game, create), not passive phrases.                  |
| C      | Conversational | Write to your audience like you would talk to them — clearly and naturally.            |
| E      | Engaging       | Make it exciting and personal (e.g., "you" vs. "gamers") and provide clear next steps. |

### Voice vs. Tone

- **Voice** is our steady personality across all communications — consistent everywhere.
- **Tone** varies by subject, product, channel, and audience — adjust accordingly.

| Be This        | Not This      |
| -------------- | ------------- |
| Conversational | Complicated   |
| Aspirational   | Grandiose     |
| Confident      | Arrogant      |
| Clever         | Silly         |
| Intelligent    | Condescending |

### Active vs. Passive Voice

Use active voice whenever possible, stressing who or what performs the action. Passive is acceptable only when the subject is unknown or when the action needs emphasis over the doer.

- Correct: "If you discover any issues with packaging, please report them."
- Incorrect: "If any issues with packaging are discovered, please report them."

### General Writing Rules

- Keep words and sentences simple. Aim for under 30 words per sentence.
- Be bold, brief, and clear. If you can leave a word out, leave it out.
- Use more periods. Avoid semicolons where a period works.
- Consider word choice and tone — "leverage" as a synonym for "use" sounds pretentious.
- Try saying it out loud. If it's not how you'd speak in real life, rewrite it.
- No swearing, blasphemy, profanity, threats, or insults — ever.
- No exclamation marks in body copy or headings.

---

## Writing Style Reference

### NVIDIA Name Usage

- Always spell **NVIDIA** in all caps. Never lowercase or abbreviate to "NV."
- Use "an NVIDIA" (not "a NVIDIA") because it has the "en" sound.
- Precede product names with "NVIDIA" on first mention (e.g., "NVIDIA GeForce").
- Architectures always require "NVIDIA" (e.g., always "NVIDIA Blackwell," never just "Blackwell").
- Avoid overbranding on NVIDIA-owned pages. When listing products, include "NVIDIA" once at the start (e.g., "NVIDIA NeMo, NIM microservices, and Cosmos").
- Do not use the register mark after "NVIDIA" when referring to the company — only in product references.

### Capitalization

- **Headings (marketing/creative):** Title case for all headings, page titles, section headings, tab headings, and document titles.
- **Subheadings:** Sentence case with ending punctuation.
- **CTA buttons:** Title case (Learn More, Register Now, Read Blog). No punctuation.
- **Labels:** Title case (Features, Benefits, Resources).
- **Footers:** Title case.
- **Tables:** Title case for copy in tables.
- **Industries:** Lowercase unless abbreviated (e.g., "media and entertainment" but "M&E").
- **In title case:** Do not capitalize conjunctions (and, as, but) or prepositions of three letters or less.
- **Compound words in titles:** Always capitalize the second word (e.g., "NVIDIA Multi-Display Technology").
- Avoid quotes, inverted commas, ampersands, colons, and exclamation marks in headings.

### Contractions

Use contractions for a conversational tone:

- Correct: "It's important to understand how generative AI works."
- Incorrect: "It is important to understand how generative AI works."

### Punctuation Quick Reference

- **Oxford comma:** Always use in lists of three or more items.
- **Em dash (—):** Set off parenthetical phrases. No spaces around it.
- **En dash (–):** Indicate ranges (numbers, dates, times). No spaces.
- **Ampersand (&):** Do not use in place of "and" except in company names that contain one.
- **Exclamation marks:** Avoid.
- **Semicolons:** Simplify sentences to eliminate them. Use periods instead.
- **Periods:** End all sentences. One space after. No terminal periods in headlines, headings, simple list items (three or fewer words), or table items.
- **Quotation marks:** Double quotes in most content. Closing quotes outside commas and periods.

### Numbers

- Spell out zero through nine in body text; use numerals for 10+.
- Use numerals for time and before million/billion/trillion.
- Use the thousands-separator comma (e.g., 1,397).
- Don't start a sentence with a numeral.
- Always spell out ordinals (e.g., "tenth" not "10th").

### Dates & Time

- Format: Month DD, YYYY (e.g., March 16, 2026). Always spell out the month.
- Abbreviate months only when space-constrained: Jan., Feb., Aug., Sept., Oct., Nov., Dec. (March, April, May, June, July always spelled out).
- No ordinals on dates ("August 12" not "August 12th").
- Omit the year if the event occurs in the current year.
- Time: 12-hour format, e.g., "10 a.m." (not "10:00 a.m."), "2:15 p.m."
- Time ranges with en dash, no spaces: "12:30–1 p.m." Never "from 12:30–1 p.m."
- Use PT for Pacific Time, ET for Eastern Time.

### Common Terms

Use these standard spellings: AI (no need to spell out), data center, dataset, datasheet, deep learning, ebook, ecommerce, email, generative AI (first mention; "gen AI" after), GPU (no need to spell out), high-performance computing (HPC), internet, laptop (not "notebook"), lidar, livestream, machine learning, multimodal, multi-node, on-premises (adjective) / on premises (adverb), open source (never hyphenated), pretrained, ray tracing (noun) / ray-tracing (adjective), startup, transformer, webpage, website, whitepaper, Wi-Fi, zero-trust (adjective).

### Abbreviations & Acronyms

- Spell out on first use with the abbreviation in parentheses: "high-resolution anti-aliasing (HRAA)."
- Common acronyms (PC, GPU, AI, CPU, SDK) don't need to be spelled out.
- Plural: add "s" with no apostrophe (GPUs).
- In headings: use the common acronym; spell out in the first body sentence.

### Plain English

Optimize for non-native speakers and translators. Avoid culture-specific idioms, colloquialisms, puns, and unnecessary abbreviations.

### Latinisms

Avoid Latin phrases — use plain equivalents:

- e.g. → "for example" or "such as"
- i.e. → "that is"
- etc. → "and so on"
- vs. → "compared to"
- via → "by" or "through"

**Exception:** _in silico_, _in vitro_, _in vivo_ are industry-standard (italicize in running text).

### Links

- Never use bare URLs in running text — hyperlink the destination title instead.
- Avoid generic link text like "here" or "read more."
- Limit inline links per paragraph for readability and SEO.
- GitHub links: use forward slash + repo name (e.g., "the /NVIDIA/NeMo GitHub repo").

### Lists

- Introduce with a complete lead-in sentence ending in a colon.
- Must have more than one item. Max two levels.
- Capitalize the first letter of every item.
- Use end punctuation if items are complete sentences.
- Use parallel sentence construction.

### Accessibility

Follow WCAG standards:

- Descriptive alt text for images and buttons.
- Descriptive anchor text for links.
- Minimum 4.5:1 color contrast ratio.
- Shorter sentences and paragraphs.
- Proper HTML heading structure.
- Even spacing between text.

### Inclusivity

Write inclusively for a broad readership. Avoid expressions that could alienate readers from different backgrounds, languages, cultures, beliefs, or lifestyles. Avoid gender-specific pronouns when possible.

### SEO

- Use customers' language and think about how users would search.
- Write at an 8th-grade reading level. Avoid jargon.
- Use clear CTAs and actionable next steps.
- Structure content with nested heading tags.
- Avoid thin content (pages with minimal substance).
- Build crosslinks from other NVIDIA-owned content.

### Social Media

- Hook first — lead with the action you want the audience to take.
- Refer to NVIDIA as "us" or "our" (not third person).
- No exclamation points — use emojis instead.
- Sentence case (not Title Case or ALL CAPS).
- Active, present-tense language with contractions.
- No trademark symbols.
- One to three hashtags per post.

### Formatting Reference

| Element            | Format            | Example                                              |
| ------------------ | ----------------- | ---------------------------------------------------- |
| Code elements      | Monospace         | `apt-get install`                                    |
| File names/paths   | Monospace         | `fields.conf`                                        |
| Error messages     | Quotation marks   | "Invalid input value"                                |
| Games              | Italic            | _Call of Duty_                                       |
| New terms          | Italic            | _system-allocated memory_                            |
| Publication titles | Italic            | _Audio Effects SDK Programming Guide_                |
| Menu items/UI      | Bold              | **Name** field                                       |
| User input/actions | Bold              | Enter **ca_counties**                                |
| Keyboard shortcuts | No formatting     | Press Ctrl+Alt+Delete                                |
| Links              | Blue + underlined | No other formatting even if it fits another category |
| Strings            | Quotation marks   | "hello"                                              |
| Variables in paths | Angle brackets    | `/home/<username>/.login`                            |

### Units of Measurement

- Include a space between number and unit: 40 GB, 30 mm.
- Be consistent — don't mix abbreviated and spelled-out units.
- Networking speeds have no space: 100G, 400GbE.

### Symbols

| Symbol | Usage                                     | Example                  |
| ------ | ----------------------------------------- | ------------------------ |
| x      | In place of "times"                       | 2x the speed             |
| +      | Spell out as "plus" in text; OK in tables | width-pruned + distilled |
| degree | In place of "degrees"                     | 1.1 Celsius warmer       |
| ~      | Approximation                             | ~5x faster               |
| %      | Percent in text and tables                | An 80% increase          |

### Trademarks

- Use trademark symbols on first mention in marketing/PR/sales content (webpages, blog posts, press releases).
- Do not use trademark symbols in learning content (Technical Blog, GTC sessions).
- Pop-up modals and in-page tabs count as new pages — re-apply trademarks.
- Include legal copy at the end of relevant assets with year, trademarked products in alphabetical order, and creation date.
