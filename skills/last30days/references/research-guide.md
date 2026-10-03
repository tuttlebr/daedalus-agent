# Recent research with Daedalus tools

## Time window and tool arguments

`current_datetime_tool(unused="")` returns the current time with its UTC
offset. Prefer a timezone already established in the conversation; otherwise
use the returned offset and say which window was used. Compute the trailing
30-day start relative to that instant. Date-only search filters retrieve
candidates; available timestamps determine exact boundary membership.

Use `perplexity_search_tool` with:

- `query`: a standalone string, or an array of 2-5 distinct related strings.
- `max_results`: normally 3 for focused discovery or omit for the configured
  default of 5. Request more only when coverage requires it; the maximum is 20.
- `search_after_date_filter` and `search_before_date_filter`: publication
  boundaries in `YYYY-MM-DD` or `MM/DD/YYYY` format.
- `search_domain_filter`: optional comma-separated domains, not an array.
- `search_language_filter`: optional comma-separated two-letter codes when
  appropriate for the requested language or region.

Do not combine exact date filters with `search_recency_filter`. The latter
supports `hour`, `day`, `week`, `month`, and `year`; `month` is only a coarse
discovery filter and is not proof of an exact trailing 30-day window.
`last_updated_after_filter` and `last_updated_before_filter` describe page
updates, not original publication or when an event happened. For a window
including today, an exclusive upper date may need the following date; reject
future-dated results and inspect dates at both boundaries. Do not assume
provider date filtering is exact or that a fresh crawl means a fresh story.

For example, after computing the dates, a comparison could send this query
array with those publication filters:

```json
{
  "query": [
    "Loom screen recorder user reviews limitations",
    "Tella screen recorder user reviews limitations",
    "Loom Tella screen recording comparison"
  ],
  "max_results": 5
}
```

For a targeted community follow-up, `search_domain_filter="reddit.com"` or
`search_domain_filter="news.ycombinator.com"` can narrow retrieval. Fetch each
known supporting URL with `webscrape_tool(url=...)`. A search result with a
snippet is a lead; it does not prove the full page, replies, or transcript were
read. Attribute snippet-only evidence as such and do not construct a quote
from a search summary.

## Choose sources for the question

| Source                                       | Useful evidence                                             | Limits to preserve                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Official sites, documentation, release notes | Dates, shipped changes, specifications, current terms       | An announcement does not prove availability or independent quality                                      |
| Reddit and Hacker News                       | Specific experiences, objections, workarounds, comparisons  | Search indexing misses posts and nested comments; a thread is not a representative survey               |
| X and other social platforms                 | Dated statements and public reactions                       | Login walls and incomplete indexing limit coverage; verify identity and quote only retrieved text       |
| YouTube and other video pages                | Creator demonstrations, descriptions, available transcripts | Page metadata is not a watched video; do not claim transcript or comment evidence without retrieving it |
| GitHub                                       | Releases, issues, pull requests, repository activity        | Search snippets can carry stale counts; proposals/issues are not shipped behavior                       |
| Prediction markets                           | An observed market price for a precisely defined outcome    | Price is not an established event probability; rules, timestamp, and liquidity affect interpretation    |
| Independent reporting and specialist reviews | Reporting context, comparisons, corroboration               | Check publication date, sponsorship, and whether stories repeat the same original source                |

For technical claims, verify against primary documentation or direct evidence;
use community discussion to describe experience and opinion. For a non-English
topic, search its original spelling and verified aliases rather than forcing
an English-only community sample. A common-name entity needs its company,
location, role, or category in every relevant query.

When X discussion is requested and its source is enabled, prefer the exposed
`x_mcp_server` read tools for the relevant posts. Use the actual schema's query,
date, ID and pagination fields; do not invent a recent-search leaf or assume
full-archive access from an allowlisted name. Bound follow-up pages to the
question, preserve returned post timestamps, and use engagement only when
actually returned. Missing authentication, an unsupported endpoint or rate
limit is a coverage gap, not evidence that nobody discussed the topic.

For a GitHub change, use available `github_mcp_server` release, commit, issue
and repository reads to distinguish a reported problem from shipped behavior.
Neither source authorizes posting, contacting users or editing a repository.

Never promise an upstream platform merely because it is in this table.
Report the actual sources retrieved and the limits encountered. If the user
requires comprehensive platform data that available tools cannot provide,
explain the missing capability and present the supported subset clearly.

## Evidence and synthesis

Maintain a working ledger with these fields; it need not be emitted unless
the user requests it:

| Field    | Record                                                                                      |
| -------- | ------------------------------------------------------------------------------------------- |
| Identity | URL, title, publisher/author, and intended entity                                           |
| Time     | Publication date, event date when distinct, retrieval time, and window membership           |
| Support  | Exact passage or faithful summary; page, snippet, transcript, or comment actually retrieved |
| Theme    | The story, comparison criterion, workflow, or disputed claim it supports                    |
| Metrics  | Only observed likes, votes, views, stars, or prices, with timestamp and scope               |
| Limits   | Missing date/context, failed fetch, uncertain identity, duplicates, or disagreement         |

Prioritize direct and relevant evidence over popularity. Independent
corroboration can strengthen a finding; identical cross-posts do not. A reply
cluster recommending a product is evidence of those replies, not proof that
the entire community recommends it. Do not sum incomparable likes, views,
and votes into a popularity score.

Separate unknown dates and older background from recent findings. A current
discussion of an older release is recent discussion, not a new release.
Trend growth or changed sentiment requires comparable observations across
time; a single snapshot cannot establish either. Market movements likewise
need both dated observations. Use percentage points for differences in quoted
percentage prices and keep market-defined outcomes explicit.

For coverage, distinguish successful retrieval, no matching results, partial
results, inaccessible content, and a tool/configuration failure. A blocked
fetch does not establish absence. One focused query reframe or alternate
accessible source can help; repeated identical searches cannot fix missing
credentials. If Perplexity is unavailable, use accessible user-provided URLs
where sufficient and disclose the discovery gap. Do not ask for keys in chat
or fall back to upstream installers or credential files.

Keep quoted excerpts short, exact, attributed, and linked. Give recommendations
with their supporting criteria and uncertainty. If findings are thin, say what
was supported and what remains unknown instead of padding a report. Preserve
the user's requested structure and the calling skill's output contract.
