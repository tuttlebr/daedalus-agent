# RSS Feed Function for NeMo Agent Toolkit

This NAT function monitors a configured RSS feed and provides AI-powered search with automatic web scraping of the most relevant content based on user queries.

## Features

- **Configured RSS Feed**: Monitor a specific RSS feed configured in your workflow
- **RSS Feed Parsing**: Fetches and parses RSS feeds using `fastfeedparser`
- **Intelligent Caching**: Caches RSS feeds for 4 hours to improve performance
- **AI-Powered Reranking**: Uses NVIDIA reranker models to find the most relevant entry
- **Automatic Web Scraping**: Fetches full content from the top-ranked result using markitdown
- **Token-Aware Truncation**: Intelligently truncates scraped content to fit within token limits
- **Flexible Configuration**: Supports custom reranker endpoints and models
- **Error Handling**: Returns error if reranker not configured, empty results if RSS fails

## Installation

1. Install the function in your NAT workflow:
```bash
cd builder/rss_feed
pip install -e .
```

2. Add to your Dockerfile if using containers:
```dockerfile
COPY rss_feed /workspace/rss_feed
RUN --mount=type=cache,id=uv_cache,target=/root/.cache/uv,sharing=locked \
    NAT_VERSION= nat workflow reinstall rss_feed && \
    uv pip install -e rss_feed --prerelease=allow
```

## Configuration

### Required Configuration

Both the RSS feed URL and reranker configuration are **required** for this function to work:

```yaml
workflow:
  _type: rss_feed

  # RSS Feed URL (required)
  feed_url: "https://feeds.arstechnica.com/arstechnica/technology-lab"

  # Required reranker configuration
  reranker_endpoint: "https://ai.api.nvidia.com/v1/ranking"
  reranker_model: "nvidia/nv-rerankqa-mistral-4b-v3"
  reranker_api_key: null  # Or set via NVIDIA_API_KEY env var
```

### Full Configuration Options

```yaml
workflow:
  _type: rss_feed

  # RSS Feed URL (required)
  feed_url: "https://feeds.arstechnica.com/arstechnica/technology-lab"

  # Reranker configuration (required)
  reranker_endpoint: "https://ai.api.nvidia.com/v1/ranking"
  reranker_model: "nvidia/nv-rerankqa-mistral-4b-v3"
  reranker_api_key: null  # Or set via NVIDIA_API_KEY env var

  # Cache configuration
  cache_ttl_hours: 4.0      # Cache RSS feeds for 4 hours
  cache_backend: "memory"   # Currently only memory is supported

  # Request configuration
  timeout: 30.0                        # Request timeout in seconds
  user_agent: "daedalus-rss-reader/1.0"  # User-Agent header
  max_entries: 20                      # Max RSS entries to process

  # Web scraping configuration
  scrape_max_output_tokens: 64000      # Max tokens in scraped content
  scrape_truncation_message: "\n\n---\n\n_**Note:** Content truncated to fit within token limit._"
```

## Usage

### Using the Structured Function

The main function returns detailed information about the search:

```python
# Structured search with full details
result = await rss_feed_search({
    "query": "latest AI breakthroughs",
    "description": "Search for AI news"  # Optional
})

# Result structure:
{
    "success": true,
    "query": "latest AI breakthroughs",
    "feed_url": "https://feeds.arstechnica.com/arstechnica/technology-lab",
    "top_result": {
        "title": "New AI Model Breaks Records",
        "link": "https://example.com/article/123",
        "published": "2024-01-20T10:00:00Z",
        "author": "John Doe",
        "description": "A breakthrough in AI..."
    },
    "scraped_content": "Full article content...",
    "entries_count": 25,
    "cached": false
}
```

### Using the Simple Wrapper

For convenience, use the simple wrapper that returns just the scraped content:

```python
# Simple search that returns scraped content directly
content = await search_rss(
    query="climate change solutions"
)

# Returns the full scraped article content or an error message
```

## How It Works

1. **RSS Feed Parsing**: Fetches the configured RSS feed URL and extracts entries (title, link, published date, author, description)
2. **Caching**: Stores parsed entries in memory for 4 hours to reduce repeated fetches
3. **Reranking**: Sends all entry titles to the reranker API along with the user's query
4. **Selection**: Identifies the highest-scoring entry based on relevance
5. **Web Scraping**: Uses the webscrape tool to fetch full content from the top result
6. **Response**: Returns the scraped content or structured data

## Error Handling

- **No Reranker Configuration**: Returns error requiring reranker setup
- **RSS Feed Failures**: Returns empty results silently (as requested)
- **Invalid RSS Format**: Handles gracefully and returns empty results
- **Scraping Failures**: Reports error but includes RSS entry details

## Supported RSS Fields

The function extracts the following fields from RSS entries:
- `title` (required): Entry title
- `link` (required): Entry URL
- `published`: Publication date
- `author`: Author information
- `description`: Entry summary/description

Only entries with both title and link are included in the results.

## Example Queries

Once you've configured your RSS feed URL, you can search it with various queries:

```python
# Search for AI-related articles
await search_rss("artificial intelligence")

# Search for climate-related content
await search_rss("climate research")

# Search for economic news
await search_rss("economic policy")
```

### Example RSS Feed URLs for Configuration

Here are some popular RSS feeds you can configure:

- **Technology**: `https://feeds.arstechnica.com/arstechnica/technology-lab`
- **Science**: `https://www.sciencedaily.com/rss/all.xml`
- **General News**: `https://feeds.bbci.co.uk/news/world/rss.xml`
- **Security**: `https://krebsonsecurity.com/feed/`
- **Space**: `https://www.nasa.gov/rss/dyn/breaking_news.rss`

## Reranker Models

Compatible NVIDIA reranker models:
- `nvidia/nv-rerankqa-mistral-4b-v3` (recommended)
- `nvidia/llama-3.2-nv-rerankqa-1b-v2`
- Any other compatible reranking model endpoint

## Performance Considerations

- **Caching**: RSS feeds are cached for 4 hours by default
- **Max Entries**: Limited to 100 entries per feed (configurable)
- **Timeout**: 30-second timeout for HTTP requests
- **Reranking**: All entry titles are sent in a single batch for efficiency

## Troubleshooting

### "RSS feed URL not configured" Error
Ensure you have set `feed_url` in your configuration.

### "Reranker configuration is required" Error
Ensure you have set both `reranker_endpoint` and `reranker_model` in your configuration.

### "No API key provided for reranker" Error
Set either `reranker_api_key` in config or `NVIDIA_API_KEY` environment variable.

### Empty Results
- Check if the configured RSS feed URL is valid and accessible
- Verify the feed contains entries with both title and link
- Check logs for parsing errors

### Scraping Failures
- Some websites may block automated scraping
- Check logs for markitdown conversion errors
- Verify the link from the RSS feed is accessible

## Integration with Other Tools

This function can be combined with other NAT tools in workflows for comprehensive information gathering. The RSS feed function uses its own built-in web scraping capabilities powered by markitdown.

## License

This function is part of the NeMo Agent Toolkit ecosystem.
