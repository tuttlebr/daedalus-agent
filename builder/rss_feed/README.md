# RSS Feed Function

This package registers a single feed search function that fetches RSS entries,
reranks them against a user query, scrapes the best match with MarkItDown, and
returns the article body as markdown.

## What It Does

- Reads one configured RSS feed via `feed_url`, or a map of named feeds via `feeds`
- Caches parsed entries in memory for `cache_ttl_hours` per feed URL
- Reranks entries with an external reranker service, sized to a token budget
- Scrapes the top-ranked article URL with MarkItDown
- Truncates scraped content to fit a token budget

The function is feed-specific. It does not search the open web by itself; use
`perplexity_search` for web discovery or `webscrape` for a known URL.

## Configuration

Default config lives in [`src/rss_feed/configs/config.yml`](src/rss_feed/configs/config.yml).

```yaml
workflow:
  _type: rss_feed
  feed_url: null
  feeds: {} # optional map of feed_scope name -> RSS URL
  reranker_endpoint: null
  reranker_model: null
  reranker_api_key: null
  reranker_max_passage_tokens: 192
  reranker_max_total_tokens: 7000
  cache_ttl_hours: 4.0
  cache_backend: 'memory'
  timeout: 30.0
  user_agent: 'daedalus-rss-reader/1.0'
  max_entries: 20
  scrape_max_output_tokens: 64000
```

Required inputs:

- `feed_url` or a non-empty `feeds` map
- `reranker_endpoint`
- `reranker_model`
- reranker API key through `reranker_api_key` or `NVIDIA_API_KEY`

## Function Signature

```python
content = await search_rss(
    query="latest AI infrastructure announcements",
    feed_scope="auto",  # or one named feed in `feeds`
)
```

`feed_scope="auto"` searches every configured feed; specifying a named scope
restricts the search to that feed.

## Response Shape

`search_rss` returns the scraped article markdown directly when a relevant
entry is found, or an `"Error: <reason>"` prefixed string when nothing can be
retrieved (missing feed config, empty results, reranker error, or scrape
failure).

## Processing Flow

1. Resolve `feed_scope` to one or more feed URLs from the configuration.
2. Fetch and parse each feed, reusing the cache when warm.
3. Build compact reranker passages sized to the configured token budget.
4. Send candidate entries to the reranker.
5. Select the top-ranked article.
6. Scrape the article content with MarkItDown.
7. Truncate the result if needed and return it.

## Failure Modes

All failure modes surface as `"Error: <reason>"` strings:

- RSS feed not configured or unreachable.
- Reranker configuration or API key missing.
- No entries returned by the feed or reranker.
- Scrape of the chosen URL fails.

## Relationship To Daedalus

This tool is useful when you want a curated feed-specific research source
inside an agent workflow. It complements the broader search and web-scraping
tools rather than replacing them. The autonomous agent uses it to surface
feed updates into the Autonomy dashboard.

## Requirements

- A reachable reranker endpoint and credentials
- Network access to the configured RSS feed URLs and target article hosts
