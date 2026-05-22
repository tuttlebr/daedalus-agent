# NVIDIA Writing Voice for HTML

Read this file when you're writing copy that will appear on an NVIDIA-branded page — headlines, paragraphs, button labels, error messages, alt text. The rules here are condensed from `DESIGN.md` § Writing Voice & Tone with the bits that bite most often in web work surfaced to the top.

## The PACE framework

Every line of copy should pass PACE:

| Letter | Attribute      | Test                                                                            |
| ------ | -------------- | ------------------------------------------------------------------------------- |
| P      | Professional   | Would a credible NVIDIA expert say this? No hype, no fluff.                     |
| A      | Active         | Is the subject doing the verb? (vs. "is being done by")                         |
| C      | Conversational | Would you say this out loud to a colleague?                                     |
| E      | Engaging       | Does it speak directly to the reader ("you") and offer a clear next step?       |

## Voice (constant) vs. tone (varies)

The voice is steady across all NVIDIA copy. The tone shifts with the context — a product launch page is brighter than a status incident page. Adjust the tone, but never the voice.

**Be this, not this:**

| Be             | Not            |
| -------------- | -------------- |
| Conversational | Complicated    |
| Aspirational   | Grandiose      |
| Confident      | Arrogant       |
| Clever         | Silly          |
| Intelligent    | Condescending  |

## The rules that bite most in HTML

### Active voice
- ✅ "If you discover any issues, report them."
- ❌ "If any issues are discovered, they should be reported."

### Sentences
- Aim for under 30 words.
- Use more periods. If you can replace a semicolon with a period, do.
- If you can cut a word, cut it.
- Read it out loud. If it doesn't sound like speech, rewrite it.

### Contractions
Use them. They're how people talk.
- ✅ "It's important to understand how generative AI works."
- ❌ "It is important to understand how generative AI works."

### No exclamation marks
Not in headings, not in body, not anywhere. Use a period.

### Title case in headings, sentence case in subheadings
- Headings (H1, H2, H3, H4): Title Case With Every Major Word Capitalized.
- Subheadings (small labels under a heading): Sentence case with ending punctuation.
- CTA buttons: Title Case (Learn More, Register Now).
- Don't capitalize conjunctions or short prepositions (and, of, by, to, on).
- Compound words in titles: capitalize the second word (Multi-Display).

### No terminal punctuation in headings, simple list items, or table cells
A heading ending in a period feels off. So does a 3-word list item.

### Quotation marks
- Double quotes (`"`) in most content.
- Closing quotes go outside commas and periods: he said "go." not he said "go".

### Oxford commas
Always.
- ✅ "NeMo, NIM, and Cosmos"
- ❌ "NeMo, NIM and Cosmos"

### Em dash vs. en dash
- Em dash (`—`): set off parenthetical phrases. No spaces around it. ("The result — surprising — held up.")
- En dash (`–`): ranges of numbers, dates, times. No spaces. ("12:30–1 p.m.")
- A hyphen (`-`) is none of the above. Don't use it for either.

### No Latinisms
Write them out:
- e.g. → "for example" or "such as"
- i.e. → "that is"
- etc. → "and so on"
- vs. → "compared to"
- via → "by" or "through"

(Exceptions for industry-standard *in silico*, *in vitro*, *in vivo* — italicized.)

### No "leverage" as a synonym for "use"
"Use" is fine. "Leverage" sounds pretentious.

## NVIDIA name usage

- Always all caps: **NVIDIA**. Never "Nvidia," "nvidia," or "NV."
- "an NVIDIA" (the "en" sound) — never "a NVIDIA."
- Precede product names with "NVIDIA" on first mention: "NVIDIA GeForce," not just "GeForce."
- Architectures always need "NVIDIA" attached: "NVIDIA Blackwell," never just "Blackwell."
- When listing several NVIDIA products, attach NVIDIA once at the front: "NVIDIA NeMo, NIM microservices, and Cosmos."

## Numbers

- Spell out zero through nine in body text. Numerals for 10+.
- Use numerals for time and before million/billion/trillion.
- Use comma thousands separators (1,397).
- Don't start a sentence with a numeral.
- Spell out ordinals: "tenth," not "10th."

## Dates and time

- Format: Month DD, YYYY (e.g., March 16, 2026). Spell out the month.
- No ordinals on dates: "August 12," not "August 12th."
- Omit the year if the event is this year.
- Time: 12-hour, lowercase a.m./p.m. with periods. "10 a.m.," not "10:00 a.m."
- Time ranges: en dash, no spaces. "12:30–1 p.m." Never "from 12:30–1 p.m."
- Timezones: PT, ET.

## Common term spellings

A few that come up constantly:
- AI (no need to spell out)
- data center (two words)
- email (no hyphen)
- generative AI (first mention); "gen AI" after
- on-premises (adjective) / on premises (adverb)
- open source (never hyphenated)
- ray tracing (noun) / ray-tracing (adjective)
- startup (one word)
- whitepaper (one word)
- Wi-Fi (hyphenated, both caps)
- zero-trust (adjective)

Full list in `DESIGN.md` § Common Terms.

## Lists

- Introduce with a complete lead-in sentence ending in a colon.
- More than one item, please.
- Capitalize the first letter of every item.
- End punctuation only if items are complete sentences.
- Parallel sentence construction across items.

## Links

- Never bare URLs in running text. Hyperlink the destination title.
- Avoid "here" and "read more" as link text. Use the actual destination ("Read the deployment guide").
- For GitHub: use forward slash + repo name ("the /NVIDIA/NeMo GitHub repo").

## Accessibility

- Descriptive alt text — what's in the image and why it matters, not "image of."
- Descriptive anchor text — see Links above.
- Aim for 4.5:1 minimum contrast.
- Use proper heading structure (don't skip from h2 to h4).

## SEO

- Use the customer's words, not internal jargon.
- 8th-grade reading level.
- Clear CTAs ending in a verb (Read, Watch, Register, Contact).
- Nested heading structure.
- Avoid thin pages — every page should justify its existence.
