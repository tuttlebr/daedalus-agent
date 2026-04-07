# RSS Feed Function

This package registers a feed-specific search function that fetches RSS entries, reranks them against a user query, scrapes the best match with MarkItDown, and returns either structured metadata or the scraped article body.

## Current Behavior

- fetches one configured RSS feed
- caches parsed feed entries in memory for `cache_ttl_hours`
- reranks entries with an external reranker service
- scrapes the top-ranked article URL with MarkItDown
- truncates scraped content to fit a token budget

This function is feed-specific. It does not search the open web by itself.

## Configuration

Default config lives in [`src/rss_feed/configs/config.yml`](src/rss_feed/configs/config.yml).

```yaml
workflow:
  _type: rss_feed
  feed_url: null
  reranker_endpoint: null
  reranker_model: null
  reranker_api_key: null
  cache_ttl_hours: 4.0
  cache_backend: "memory"
  timeout: 30.0
  user_agent: "daedalus-rss-reader/1.0"
  max_entries: 20
```

Required inputs:

- `feed_url`
- `reranker_endpoint`
- `reranker_model`
- reranker API key through `reranker_api_key` or `NVIDIA_API_KEY`

## Usage

Structured search:

```python
result = await rss_feed_search({
    "query": "latest AI infrastructure announcements",
    "description": "Search the configured feed for relevant news"
})
```

Simple wrapper:

```python
content = await search_rss("latest AI infrastructure announcements")
```

## Response Shape

The structured function returns fields such as:

- `success`
- `query`
- `feed_url`
- `top_result`
- `scraped_content`
- `entries_count`
- `cached`
- `error`

## Processing Flow

1. Fetch and parse the configured RSS feed.
2. Reuse cached entries if available.
3. Send candidate entries to the reranker.
4. Select the top-ranked article.
5. Scrape the article content with MarkItDown.
6. Truncate the result if needed and return it.

## Failure Modes

- If the RSS feed fails to load or parse, the function returns empty results.
- If reranker configuration is missing, the function returns a configuration error.
- If scraping fails, the function can still return the selected RSS entry metadata with an error.

## Relationship To Daedalus

This tool is useful when you want a curated feed-specific research source inside an agent workflow. It complements the broader search and web-scraping tools rather than replacing them.
