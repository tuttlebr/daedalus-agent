# SerpAPI Search Function for NeMo Agent Toolkit

This NAT function provides Google search capabilities using the SerpAPI service.

## Features

- Perform Google searches with customizable parameters
- Get structured search results including:
  - Organic search results
  - Related questions ("People Also Ask")
  - Related searches
- Support for location-based searches
- Pagination support
- Time-based filtering

## Installation

1. Install the function in your NAT workflow:
```bash
nat workflow install /path/to/serpapi_search
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
  _type: serpapi_search
  api_key: "your-serpapi-key-here"
  # Optional: Enable geolocation_retriever for location resolution
  use_geolocation_retriever: true
  geolocation_retriever_name: geolocation_retriever_tool
```

### Method 3: Per-Request API Key
Pass the API key directly in your search request:
```python
response = await google_search({
    "query": "NeMo toolkit",
    "api_key": "your-serpapi-key-here"
})
```

## Configuration

Edit the `config.yml` file to customize the default settings:

```yaml
workflow:
  _type: serpapi_search
  # api_key: "your-serpapi-key-here"  # Optional: Can also use SERPAPI_KEY env var
  default_location: "United States"
  default_num_results: 10
  # Enable geolocation_retriever for intelligent location resolution
  use_geolocation_retriever: true
  geolocation_retriever_name: geolocation_retriever_tool
```

### Geolocation Integration

When `use_geolocation_retriever` is enabled, the function will use your configured geolocation_retriever to:
- Resolve fuzzy location names to canonical forms (e.g., "SF" → "San Francisco, California, United States")
- Standardize location names for more consistent search results
- Handle location ambiguity using semantic search

## Usage

The function provides multiple interfaces:

### Simple Search (returns formatted text)
```python
# Simple query returns formatted results
response = await search_web("What is the weather today?")
```

### Advanced Search (returns structured data)
```python
# Advanced search with parameters
response = await google_search({
    "query": "NeMo toolkit",
    "location": "San Francisco, California",
    "num": 20,
    "time_period": "last_month"
})

# Search with a specific API key
response = await google_search({
    "query": "AI news",
    "api_key": "different-api-key",
    "num": 10
})
```

## Response Format

The structured response includes:
- `success`: Boolean indicating if the search was successful
- `query`: The search query used
- `total_results`: Total number of results found
- `results`: List of search results with title, link, snippet, etc.
- `related_questions`: List of related questions and answers
- `related_searches`: List of related search queries
- `raw_response`: Complete SerpAPI response for advanced users

## Requirements

- Python 3.11+
- NeMo Agent Toolkit 1.3+
- Valid SerpAPI key

## License

This function is part of the NeMo Agent Toolkit ecosystem.
