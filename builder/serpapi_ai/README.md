# SerpAPI AI Mode Function for NeMo Agent Toolkit

This NAT function provides Google AI Mode search capabilities using the SerpAPI service. It returns AI-generated summaries with structured text blocks and source references.

## Features

- AI-generated search summaries with structured content
- Organized text blocks (paragraphs, headings, lists)
- Source references for all information
- No web scraping needed - results are self-contained
- Support for location-based searches

## Installation

1. Install the function in your NAT workflow:
```bash
nat workflow install /path/to/serpapi_ai
```

2. Configure your SerpAPI key (choose one method):

### Method 1: Environment Variable (Recommended)
```bash
export SERPAPI_KEY="your-serpapi-key-here"
```

### Method 2: Configuration File
Add the API key to your `config.yml` file:
```yaml
workflow:
  _type: serpapi_ai
  api_key: "your-serpapi-key-here"
  default_location: "United States"
```

### Method 3: Per-Request API Key
Pass the API key directly in your search request:
```python
response = await ai_search({
    "query": "What is machine learning?",
    "api_key": "your-serpapi-key-here"
})
```

## Configuration

Edit the `config.yml` file to customize the default settings:

```yaml
workflow:
  _type: serpapi_ai
  # api_key: "your-serpapi-key-here"  # Optional: Can also use SERPAPI_KEY env var
  default_location: "United States"
  # Enable geolocation_retriever for intelligent location resolution
  use_geolocation_retriever: true
  geolocation_retriever_name: geolocation_retriever_tool
```

### Geolocation Integration

When `use_geolocation_retriever` is enabled, the function will use your configured geolocation_retriever to:
- Resolve fuzzy location names to canonical forms (e.g., "SF" → "San Francisco, California, United States")
- Standardize location names for more consistent search results
- Handle location ambiguity using semantic search

This improves the quality and relevance of AI-generated summaries by providing more precise location context.

## Usage

The function provides access to Google's AI Mode search:

### Simple Search (returns formatted text)
```python
# Simple query returns formatted AI summary
response = await ai_search("What is quantum computing?")
```

### Advanced Search (returns structured data)
```python
# Advanced search with parameters
response = await ai_search({
    "query": "Climate change effects",
    "location": "United States"
})

# Search with a specific API key
response = await ai_search({
    "query": "AI news",
    "api_key": "different-api-key"
})
```

## Response Format

The structured response includes:
- `success`: Boolean indicating if the search was successful
- `query`: The search query used
- `text_blocks`: Array of structured content blocks (paragraphs, headings, lists)
- `references`: Array of source citations with titles, links, and metadata
- `search_metadata`: Metadata about the search request
- `error`: Error message if the search failed

### Text Block Types

- **paragraph**: Regular text content with optional highlighted keywords
- **heading**: Section headers
- **list**: Bulleted or numbered lists with items
- **nested**: Can contain nested text_blocks for complex structures

Each text block includes:
- `type`: The block type
- `snippet`: The text content
- `snippet_highlighted_words`: Important keywords (optional)
- `reference_indexes`: Links to source references (optional)
- `list`: Array of list items (for list-type blocks)
- `text_blocks`: Nested blocks (for complex structures)

### References

Each reference includes:
- `title`: Source title
- `link`: Source URL
- `snippet`: Brief excerpt
- `source`: Source name (e.g., "Wikipedia", "New York Times")
- `index`: Reference number for cross-referencing

## Requirements

- Python 3.11+
- NeMo Agent Toolkit 1.3+
- Valid SerpAPI key

## Differences from serpapi_search

| Feature | serpapi_search | serpapi_ai |
|---------|---------------|------------|
| Engine | `google` | `google_ai_mode` |
| Results | Raw search results | AI-generated summaries |
| Web scraping | Yes (enrichment) | No (self-contained) |
| Response hierarchy | 4 levels (0-3) | Single level |
| Geolocation | Optional integration | Optional integration |
| Text blocks | Only in ai_overview | Primary response format |
| Location-aware | Yes | Yes |

Key differences:
- Uses `google_ai_mode` engine for AI-generated summaries
- Returns structured text blocks and references (no raw search results)
- No web scraping needed - all content is provided in the response
- Simpler response structure focused on text blocks and references
- No hierarchy levels or multiple result types
- Both support geolocation_retriever for improved location resolution

## License

This function is part of the NeMo Agent Toolkit ecosystem.
