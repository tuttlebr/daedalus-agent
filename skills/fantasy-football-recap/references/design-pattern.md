# Fowling Dispatch design pattern

Apply this visual system to every edition. The user's finished Fowling Dispatch
page is the design reference; its prose, scores, dates, sources, standings,
location and league rules are not reusable evidence. Keep an established
publication name when known, or create one for the selected league. Do not
assign another league the Fowling identity or invent a volume number or location.

## Palette and type

Use [the HTML template](../assets/newspaper-template.html) as the starting point.
It embeds the canonical styles so the delivered file is self-contained.

| Role               | Value     | Treatment                                              |
| ------------------ | --------- | ------------------------------------------------------ |
| Page and newspaper | `#FFFFFF` | Explicit on `html`, `body`, `.newspaper`, and in print |
| Ink                | `#1a1a1a` | Headlines, body text, strong rules                     |
| Accent             | `#8b1a1a` | Links, kickers, score bars, matchup left rules         |
| Rule               | `#c9c9c9` | Fine dividers, table rows, sidebar separator           |
| Muted text         | `#5a5a5a` | Metadata, status labels, notes, sources                |
| Deck               | `#333333` | Italic lead summary                                    |
| Bye marker         | `#b9b9b9` | Neutral bar and matchup rule; pair with explicit text  |
| Bye row            | `#fafafa` | Local table shading only; never the page canvas        |

Use `Georgia, "Times New Roman", Times, serif` throughout. Body text is 17px
with 1.55 line height. Desktop masthead is 54px, lead headline 40px, italic deck
19px, section headings 26px, and story headings 20px. Supporting text uses the
template's smaller sizes and uppercase letterspaced labels. Preserve this
hierarchy instead of introducing a different font family or accent for each issue.
Avoid cream paper, textures, gradients, dark themes, rounded cards, shadows,
dashboard tiles, decorative icons, and oversized empty hero areas.

## Page and components

The newspaper is centered at a maximum 1060px width with 28px/24px/40px padding.
Use these components in reading order, omitting reporting modules only when they
do not apply or lack evidence:

- **Masthead and issue line:** centered name and italic tagline above a double
  charcoal rule; three small metadata fields below a thin gray divider. Edition
  and publication date belong here; the third field is optional confirmed context.
- **Lead:** burgundy uppercase kicker, centered headline, italic deck, and honest
  publication-staff byline. A 2:1 grid with a 28px gutter pairs the lead story with
  a ruled By the Numbers sidebar. Put the data-as-of note below the lead.
- **Section headings:** strong top rule, fine bottom rule, 26px serif heading,
  and generous space above. Reuse across scoreboard, standings, NFL, roster,
  back page and preview coverage.
- **Tables:** compact collapsed rows, uppercase headers, fine horizontal rules,
  right-aligned tabular numbers. Bold confirmed winners only. Write final, live,
  scheduled, unconfirmed, tie or bye status explicitly; styling never establishes
  a result. A bye's scoring treatment must come from league evidence, not its tint.
- **Scores chart, when useful:** horizontal burgundy bars with visible team names
  and exact values, neutral gray for identified byes, and a caption stating score
  scope. For comparable nonnegative totals with a positive maximum, compute each
  width as `100 * score / max_score` percent from checked values; zero has zero
  width. Generate each numeric `--bar-width` value, never sample `.b91` classes.
  For negative, unknown or incomparable totals, omit this simple chart or use an
  explicitly labeled scale that represents them correctly. Do not plot unknowns
  as zero or mix weekly points with aggregate totals.
- **Game by game:** 3px burgundy left rule, serif matchup heading, small uppercase
  score/status line and short recap. Byes use a neutral rule and explicit label.
- **Supporting desks:** reuse the story/sidebar grid for NFL and roster coverage;
  subtitles and short paragraphs carry the reporting without extra card shells.
- **Awards and watch box:** two columns of awards separated by top rules; a square
  charcoal-bordered white What to Watch box with up to three numbered items.
- **Sources:** compact gray footer after a strong rule, with public article links
  and ESPN season/week/retrieval context. Keep reporting caveats beside their claims.

## Populate, adapt and inspect

The template's `{{UPPERCASE}}` tokens mark editorial fields, not an executable
templating language. Replace text tokens with HTML-escaped reporting. Duplicate
the sample rows, stories, stats, chart rows and awards as needed for complete
coverage; remove unused components. The two scoreboard rows form one matchup.
Provide its status on both rows so neither team is ambiguous. Add `.win` only
after verification and use `.bye-row`, `.bye-matchup` and `.row.bye` for byes.
Optional location/volume metadata and all other unfilled tokens must be removed
before publication. Never keep template text, empty modules or sample URLs in
an edition. Keep the embedded CSS in the final artifact.

At 760px and below, use a 36px masthead, 28px lead, stacked issue fields, one
story column, a top rule on sidebars, and one award column. Let long names wrap.
Wide tables may scroll inside their labeled focusable wrapper on screen; the
page itself must not overflow. In print, retain the desktop column arrangement
with a 40px masthead and 32px lead, restore visible table overflow, repeat headers,
and keep individual rows, short matchups, awards and the watch box together when
they fit. Avoid stranded headings. Never make a whole long desk unbreakable.

Before release, inspect the populated edition at desktop and narrow mobile
widths and in print/PDF when tools permit. Check the palette, headline hierarchy,
long names, all table columns, chart labels/widths, and page breaks. Confirm that
the HTML is standalone, no tokens remain, statuses and numbers agree across
modules, and the final PDF comes from the same HTML. Design inspection does not
replace the reporting contract or certify the underlying league facts.
