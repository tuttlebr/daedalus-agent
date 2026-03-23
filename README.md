<p align="center">
  <img src="frontend/public/favicon.png" alt="Daedalus" width="120">
</p>

# Daedalus

A full-stack reference implementation of the [NVIDIA NeMo Agent toolkit](https://github.com/NVIDIA/NeMo-Agent-Toolkit) combining multi-model reasoning, RAG, and a TypeScript/Next.js chat interface.

## Features

- **Dual Agent Workflows**: Tool-calling agent for quick tasks and reasoning agent for comprehensive research
- **RAG Knowledge Bases**: NVIDIA documentation, Kubernetes, veterinary medicine, mental health, and semiconductor analysis
- **Image Processing**: Generation, comprehension, and augmentation via NVIDIA NIM and OpenRouter
- **Document Ingestion**: Upload and query documents using NVIDIA NV-Ingest with Milvus vector storage
- **Cross-Session Memory**: Persistent user preferences and context via Redis
- **MCP Integrations**: GitHub, Kubernetes cluster management, and SerpAPI web search
- **Real-Time Streaming**: Server-sent events for responsive chat interactions
- **Progressive Web App**: Installable on desktop and mobile with offline support and background processing
- **Cross-Device Sync**: Real-time conversation synchronization across all your devices

## User Guide

Daedalus includes a built-in **Help** section accessible from the sidebar. Click the Help button to learn about all available features. Below is a summary.

### Getting Started

1. Log in with your credentials.
2. Type a message and press Enter to chat.
3. Use **Shift + Enter** to add new lines without sending.

### AI Modes

| Mode | Best For |
|------|----------|
| **Standard** | Fast answers, quick lookups, simple tasks |
| **Deep Thinker** | Complex research, multi-step analysis, thorough investigation |

Toggle between modes with the **Deep Thinker** button below the chat input.

### What You Can Ask

- **Web search** — "Search for the latest NVIDIA earnings report"
- **Image generation** — "Generate an image of a futuristic city at sunset"
- **Image editing** — Upload an image and ask "Change the background to a beach"
- **Image analysis** — Upload or capture a photo and ask "What's in this image?"
- **Document Q&A** — Upload a PDF and ask "Summarize this document"
- **Meeting notes** — Upload a VTT/SRT transcript for structured notes
- **News** — "What's the latest from the NVIDIA blog?"
- **Knowledge bases** — Ask about NVIDIA GPUs, Kubernetes, or other indexed topics

### File Attachments

Click the **paperclip** icon to attach:
- **Images** (PNG, JPG, GIF, WebP) for analysis and OCR
- **Documents** (PDF, DOCX, TXT) for ingestion into a searchable knowledge base
- **Videos** (MP4, WebM, MOV) for frame analysis and transcript processing

Use the **camera** icon to capture photos directly from your device.

### Organizing Conversations

- Create folders via the sidebar folder icon and drag conversations into them
- Search conversations by name or content using the sidebar search bar
- Rename conversations by clicking their name
- Export all conversations as JSON for backup or device transfer

### Settings

Open **Settings** from the sidebar to configure:
- **Theme** — dark or light mode
- **Chat History** — include full conversation context for better follow-up answers
- **Background Processing** — continue AI processing when the screen is locked (PWA)
- **Intermediate Steps** — see the AI's reasoning, tool calls, and retrieval steps

### Install as App

Daedalus works as a Progressive Web App. Install it for a native-like experience with background processing and offline access to your history.

## Architecture

| Service | Description |
|---------|-------------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS (port 5000) |
| Backend Default | NeMo Agent toolkit with tool-calling agent |
| Backend Deep Thinker | NeMo Agent toolkit with reasoning agent |
| NGINX | Reverse proxy with optional restricted mode |
| Redis Stack | Persistence for chat history, sessions, and memory (RedisJSON + RedisSearch) |

## Prerequisites

- Docker and Docker Compose
- API keys:
  - `NVIDIA_API_KEY` (required) — obtain from [build.nvidia.com](https://build.nvidia.com)
  - `OPENROUTER_API_KEY` (required for image generation)
  - `SERPAPI_KEY` (optional, for web search)
  - `GITHUB_PAT` (optional, for GitHub MCP server)
- For Kubernetes deployment: Helm 3, kubectl, and container registry access

## Quick Start

```bash
# Copy environment template and add your API keys
cp frontend/env.example .env

# Start the full stack
docker compose up --build
```

Access the application at `http://localhost` (NGINX) or `http://localhost:3000` (frontend direct).

## Kubernetes Deployment

A Helm chart is provided in `helm/daedalus/` for Kubernetes deployment:

```bash
# Build images, push to registry, and deploy
./helm-build-deploy.sh
```

Configure deployment settings in `helm/daedalus/values.yaml`. The chart supports dual backend deployments, ingress with TLS, and persistent storage for Redis and JupyterLab.

## Configuration

| File | Purpose |
|------|---------|
| `.env` | API keys and secrets (never commit) |
| `backend/tool-calling-config.yaml` | Default agent configuration with tools and retrievers |
| `backend/react-agent-config.yaml` | Deep thinker reasoning agent configuration |
| `helm/daedalus/values.yaml` | Kubernetes deployment settings |

## Testing

### Frontend

The frontend uses [Vitest](https://vitest.dev/) with jsdom for unit tests. Tests live in `frontend/__tests__/`.

```bash
cd frontend
npm install        # install dependencies first
npm run test       # run tests in watch mode
npm run coverage   # run tests once and generate a coverage report
```

Coverage reports are output in text, JSON, and HTML formats.

### Builder Packages

The `builder/` packages use [pytest](https://pytest.org/) for unit tests. Tests live in `builder/tests/` and cover the pure-Python utility functions across all packages without requiring the full NAT container environment.

```bash
cd builder
uv run --with pytest --with pyyaml --with pydantic --with httpx \
  pytest tests/ -v
```

To include a coverage report:

```bash
uv run --with pytest --with pyyaml --with pydantic --with httpx --with pytest-cov \
  pytest tests/ --cov --cov-report=term-missing
```

The test suite mocks NAT framework imports and other container-only dependencies so tests run locally without Docker.

## Custom Function Packages

The `builder/` directory contains custom NeMo Agent toolkit function packages:

| Package | Description |
|---------|-------------|
| `image_generation` | Text-to-image generation via NVIDIA NIM or OpenRouter |
| `image_comprehension` | Image analysis and OCR |
| `image_augmentation` | Image editing and modification |
| `nat_nv_ingest` | Document ingestion pipeline with Milvus |
| `smart_milvus` | Vector retrieval with reranking |
| `rss_feed` | RSS feed fetching with relevance ranking |
| `webscrape` | Web page content extraction |
| `vtt_interpreter` | Meeting transcript to structured notes |
| `nat_helpers` | Geolocation and utility functions |
Install packages in editable mode:

```bash
cd builder
uv pip install -e <package>
```

## License

Apache 2.0
