# NeMo Agent Toolkit Documentation Style Guide

Complete style reference for writing and reviewing NAT documentation. Covers voice, formatting, punctuation, capitalization, lists, tables, numbers, dates, and Latin phrase avoidance.

---

## Terminology and Naming

- **First use**: "NVIDIA NeMo Agent toolkit"
- **Subsequent references**: "NeMo Agent toolkit"
- **In headings**: "NeMo Agent Toolkit" (capitalize "Toolkit")
- **Abbreviations**: "NAT" in env vars and comments; "nat" for CLI/API namespace; "nvidia-nat" for package name
- **Never use** deprecated names: Agent Intelligence toolkit, AgentIQ, AIQ, aiqtoolkit
- If you find deprecated names in docs, update them

---

## Writing Process (8 Steps)

1. **Understand your audience** — identify technical level and goals
2. **Determine your purpose** — define the specific outcome you want
3. **Brainstorm ideas** — list all relevant info without filtering
4. **Choose and sort ideas** — eliminate anything that doesn't serve your purpose
5. **Organize into a writing plan** — structure, headings, formatting elements
6. **Write the first draft** — don't worry about perfection
7. **Revise, correct, and rewrite** — check content, clarity, structure, grammar
8. **Send a clean draft to reviewers** — have SMEs verify accuracy before publishing

---

## Voice and Tone

### Be Authoritative
- Write with confidence without being condescending
- Use active voice: "Marti logged into the account" not "The account was logged into by Marti"
- Use passive voice only when the actor is unknown or changing to active would alter meaning
- Avoid redundancy and flowery language

### Be Instructive
- Use declarative and imperative sentences
- Include all necessary articles (a, an, the)
- Use action verbs and concise headings

### Use Second Person
- Address the reader with "you"
- "With the product you can create..." not "The product allows you to create..."

### Avoid These Phrases
- "Simply" or "just" (implies ease when it may not be)
- "Obviously" or "clearly" (condescending)
- "Please note that" (filler)
- "In order to" → use "to"
- "Due to the fact that" → use "because"
- "At this point in time" → use "now"

---

## Formatting

### Code and Technical Elements

| Element | Format |
|---|---|
| Code samples and commands | Code block or inline `backticks` |
| Config parameters | Inline `backticks` |
| File names | Inline `backticks` |
| File paths (with variables) | Inline `backticks`; variables in `<angle brackets>` |
| REST API requests | Code block |

**Path variables**: Use `<username>` not `[username]` or `{username}`.

### UI Elements

| Element | Format |
|---|---|
| Menu items, UI elements | *Italic* |
| User input, button text | **Bold** |
| Keyboard shortcuts | No special formatting: `Press Ctrl+Alt+Delete` |

### Text Emphasis

| Use case | Format |
|---|---|
| Guide titles, document references | *Italic* |
| Domain-specific terms (first use) | *Italic* |
| Error messages | "Quotation marks" |
| Speech and dialogue | "Quotation marks" |

**Don't use ALL CAPS for emphasis.** Don't use bold for code elements — use monospace.

---

## Capitalization

### Always Capitalize
- First word of every sentence
- Proper nouns: companies (NVIDIA), products (CUDA, TensorRT), places, people
- Days, months, holidays — not seasons
- Time zones (full names and abbreviations): Eastern Time, EST

### Title Case for Headings
Capitalize: first word, all nouns, all verbs, all adjectives, all proper nouns
Don't capitalize: articles (a, an, the), short conjunctions (and, but, or), short prepositions (of, in, to, for) — unless they are the first word

Examples:
- "Requirements for Configuring NVIDIA vGPU in a DRS Cluster"
- "Deploying and Testing Your Text-based Bot"

### Don't Capitalize
- Common nouns: "the database", "the server"
- Job titles: software engineer, project manager
- Seasons: spring, summer
- Directions: north, south (unless part of a proper name)
- Compound words (unless proper names): long-term solution, up-to-date guides

---

## Punctuation

### Serial (Oxford) Comma
Always use a comma before the conjunction in lists of three or more: "Mail, Calendar, People, and Tasks"

### Apostrophes
- Singular possessive (including nouns ending in s): `CSS's flexibility`, `box's contents`
- Plural possessive ending in s: `users' passwords`
- Don't use for possessive "it" → use `its`

### Brackets
- `< >` for placeholder variables: `https://<user-specified-domain>.nvidia.com`
- `{ }` only in code samples
- `[ ]` for config file stanza names: `[clevertap]`

### Dashes
- **Em dash** (—) for parenthetical phrases; no spaces around it
- **En dash** (–) for number/date ranges and negative numbers; no spaces

### Colons
Use to introduce lists; lowercase after a colon unless it is a proper noun or starts a complete sentence.

### Semicolons
Use between independent clauses not joined by a conjunction, or to separate complex list items that contain commas. Prefer rewriting as multiple sentences when possible.

### Avoid in Technical Docs
- Ellipses (...)
- Exclamation points (!)
- Rhetorical question marks (?)

---

## Lists and Tables

### Lists — General
- Always introduce with a complete lead-in sentence ending in a colon
- Lists must have more than one item; sub-lists must too
- Maximum two levels
- Capitalize the first letter of every item
- Use parallel construction throughout
- Consistent punctuation: periods if items are complete sentences; none for short phrases

### Bulleted Lists — Use when order does not matter
```
The toolkit provides:
- Easy installation and setup
- Comprehensive documentation
- Active community support
```

### Numbered Lists — Use when order matters
```
To install the toolkit:
1. Download the installation package
2. Extract the files
3. Run the setup command
4. Verify the installation
```

### Tables — Use for reference data, options, comparisons
- Full introductory sentence ending with a colon before the table
- No single-row tables
- Title case for column headers
- Every table needs a descriptive title
- Avoid empty cells, merged cells, and excessive code in cells

---

## Numbers and Dates

### Numbers in Text
- Spell out zero through nine; use numerals for 10 and above
- If one item in a group requires a numeral, use numerals for all
- Never start a sentence with a numeral: "Eleven apps" not "11 apps"
- Commas for 4+ digit numbers: `$1,024`, `1,093 MB` (exceptions: years, pixels, baud — use commas only at 5+ digits)
- Negative numbers: en dash, not hyphen: `–79` not `-79`
- Ordinals: always spell out — "the first row", "the twenty-first anniversary"
- Don't use ordinals in dates: "June 21" not "June 21st"

### Dates and Times
- Format: `Month DD, YYYY` — "July 31, 2016"
- Always spell out month names to avoid regional ambiguity
- Time: `10:45 AM`, `6:30 PM` (space before, both letters capitalized)
- Don't use "24/7" — use "always" or "around the clock"

---

## Latin Phrases to Avoid

Replace Latin abbreviations with plain English for global accessibility:

| Avoid | Use instead |
|---|---|
| e.g. | for example, such as |
| etc. | and so on |
| i.e. | that is |
| vs./versus | compared to |
| via | by, through |
| vice versa | conversely |

**Exceptions** (keep as-is, italicize in running text): *in silico*, *in vitro*, *in vivo*

---

## Quality Standards

- **Audience-focused**: Consider who will read this
- **SME review**: Have subject matter experts verify technical accuracy
- **Consistency**: Apply the same style rules throughout all docs
- **Accessibility**: Ensure content works for users with different abilities
- **No TODOs or placeholders**: Never publish incomplete content
- **No deprecated names**: Immediately update any AgentIQ/AIQ/aiqtoolkit references
