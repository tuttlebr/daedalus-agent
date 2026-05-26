# RSS Feed Function

This package registers feed-specific search functions that fetch RSS entries,
rerank them against a user query, scrape the best match with MarkItDown, and
return either structured metadata or the scraped article body.

## What It Does

- Reads one configured RSS feed via `feed_url`, or a map of named feeds via `feeds`
- Caches parsed entries in memory for `cache_ttl_hours` per feed URL
- Reranks entries with an external reranker service, sized to a token budget
- Scrapes the top-ranked article URL with MarkItDown
- Truncates scraped content to fit a token budget

The function is feed-specific. It does not search the open web by itself; use
the `webscrape` and `serpapi_search` packages for that.

## Configuration

Default config lives in [`src/rss_feed/configs/config.yml`](src/rss_feed/configs/config.yml).

```yaml
workflow:
  _type: rss_feed
  feed_url: null
  feeds: {}  # optional map of feed_scope name -> RSS URL
  reranker_endpoint: null
  reranker_model: null
  reranker_api_key: null
  reranker_max_passage_tokens: 192
  reranker_max_total_tokens: 7000
  cache_ttl_hours: 4.0
  cache_backend: "memory"
  timeout: 30.0
  user_agent: "daedalus-rss-reader/1.0"
  max_entries: 20
  scrape_max_output_tokens: 64000
  enabled_operations: null  # optional allow-list: rss_feed_search, search_rss
```

Required inputs:

- `feed_url` or a non-empty `feeds` map
- `reranker_endpoint`
- `reranker_model`
- reranker API key through `reranker_api_key` or `NVIDIA_API_KEY`

## Function Signatures

Two functions are registered by default. Pass `enabled_operations` to limit
which ones are registered.

Structured search:

```python
result = await rss_feed_search({
    "query": "latest AI infrastructure announcements",
    "feed_scope": "auto",  # or one named feed in `feeds`
    "description": "Search the configured feed for relevant news",
})
```

Simple wrapper:

```python
content = await search_rss(
    "latest AI infrastructure announcements",
    feed_scope="auto",
)
```

`feed_scope="auto"` searches every configured feed; specifying a named scope
restricts the search to that feed.

## Response Shape

`rss_feed_search` returns a dictionary with fields such as:

- `success`
- `query`
- `feed_url`
- `feed_scope`
- `top_result`
- `scraped_content`
- `entries_count`
- `cached`
- `error`

`search_rss` returns the scraped content directly, or a short error message
when nothing relevant could be retrieved.

## Processing Flow

1. Resolve `feed_scope` to one or more feed URLs from the configuration.
2. Fetch and parse each feed, reusing the cache when warm.
3. Build compact reranker passages sized to the configured token budget.
4. Send candidate entries to the reranker.
5. Select the top-ranked article.
6. Scrape the article content with MarkItDown.
7. Truncate the result if needed and return it.

## Failure Modes

- If the RSS feed fails to load or parse, the function returns empty results.
- If reranker configuration is missing, the function returns a configuration error.
- If scraping fails, the function can still return the selected RSS entry metadata with an error string.

## Relationship To Daedalus

This tool is useful when you want a curated feed-specific research source
inside an agent workflow. It complements the broader search and web-scraping
tools rather than replacing them. The autonomous agent uses it to surface
feed updates into the Autonomy dashboard.

## Requirements

- A reachable reranker endpoint and credentials
- Network access to the configured RSS feed URLs and target article hosts
