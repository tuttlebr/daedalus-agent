# Daedalus Architecture

This document provides a comprehensive overview of the Daedalus application architecture, including system components, data flow, and integration patterns.

## System Overview

Daedalus is a full-stack AI agent platform built on the NVIDIA NeMo Agent toolkit. It provides an intelligent chat interface with multi-modal capabilities including web search, retrieval-augmented generation, code generation, and image generation.

## Architecture Diagram

```mermaid
graph TB
    subgraph "Client Layer"
        USER[User Browser]
    end

    subgraph "Edge Layer"
        NGINX[NGINX Reverse Proxy<br/>Port 80/443<br/>TLS Termination]
    end

    subgraph "Application Layer"
        subgraph "Frontend (Next.js)"
            UI[React UI Components<br/>Chat Interface<br/>Authentication]
            API[API Routes<br/>/api/chat.ts<br/>/api/auth/*]
        end

        subgraph "Backend (NeMo Agent Toolkit)"
            AGENT[Tool Calling Agent<br/>Multi-tier LLM Strategy]

            subgraph "LLM Tier"
                FAST[Fast LLM<br/>Nemotron Nano 9B<br/>Quick responses]
                BALANCED[Balanced LLM<br/>Llama 3.3 49B<br/>General tasks]
                INTELLIGENT[Intelligent LLM<br/>GPT-OSS 120B<br/>Complex reasoning]
            end

            subgraph "Tools & Functions"
                RETRIEVAL[Retrieval Tools<br/>Geolocation<br/>Kubernetes<br/>NVIDIA<br/>Veterinarian]
                SEARCH[Web Search<br/>SerpAPI Search<br/>SerpAPI AI Mode<br/>SerpAPI News<br/>Wikipedia<br/>RSS Feed]
                UTILITY[Utility Tools<br/>Weather<br/>DateTime<br/>WebScrape]
                GENERATION[Generation Tools<br/>Code Gen<br/>Image Gen<br/>Image Augmentation]
                ANALYSIS[Analysis Tools<br/>Bang-for-Buck<br/>First Principles<br/>Socratic Method]
                USER_DOCS[User Document Processing<br/>PDF Ingest]
            end
        end
    end

    subgraph "Data Layer"
        REDIS[(Redis<br/>Session State<br/>Chat History<br/>Rate Limiting<br/>Usage Tracking)]
    end

    subgraph "External Services"
        subgraph "NVIDIA Cloud Functions"
            NIM_LLM[NIM LLM Endpoints<br/>Multiple Models]
            NIM_EMBED[NIM Embeddings<br/>Llama 3.2 1B]
            NIM_RERANK[NIM Reranker<br/>Llama 3.2 1B]
            NIM_IMAGE[NIM Image Gen<br/>Stable Diffusion 3.5]
        end

        MILVUS[(Milvus Vector DB<br/>Kubernetes Docs<br/>NVIDIA Docs<br/>Veterinary Docs)]
        SERPAPI[SerpAPI<br/>Web Search<br/>News Search]
    end

    subgraph "Builder Environment"
        BUILDER[Python Builder<br/>Custom NAT Functions<br/>serpapi_search<br/>serpapi_news<br/>image_generation<br/>smart_milvus<br/>weather<br/>webscrape]
    end

    %% User flow
    USER -->|HTTPS/HTTP| NGINX
    NGINX -->|Proxy /| UI

    %% Frontend flow
    UI <-->|React Components| API
    API <-->|Session Auth| REDIS
    API -->|POST /chat<br/>Proxy to Backend| AGENT
    API -->|Usage Tracking<br/>Fire-and-Forget| REDIS

    %% Backend connections
    AGENT <-->|Session/Cache| REDIS

    %% Direct API access in Normal Mode (optional)
    NGINX -.->|Direct API Access<br/>Normal Mode Only| API

    %% Agent orchestration
    AGENT -->|Route Tasks| FAST
    AGENT -->|Route Tasks| BALANCED
    AGENT -->|Route Tasks| INTELLIGENT

    AGENT -->|Call Tools| RETRIEVAL
    AGENT -->|Call Tools| SEARCH
    AGENT -->|Call Tools| UTILITY
    AGENT -->|Call Tools| GENERATION
    AGENT -->|Call Tools| ANALYSIS
    AGENT -->|Call Tools| USER_DOCS

    %% Backend to external services
    FAST -->|LLM API| NIM_LLM
    BALANCED -->|LLM API| NIM_LLM
    INTELLIGENT -->|LLM API| NIM_LLM

    USER_DOCS -->|PDF Processing| MILVUS

    RETRIEVAL -->|Vector Search| MILVUS
    RETRIEVAL -->|Embed Query| NIM_EMBED
    RETRIEVAL -->|Rerank Results| NIM_RERANK

    SEARCH -->|Search API| SERPAPI

    GENERATION -->|Image API<br/>Returns Base64| NIM_IMAGE
    GENERATION -->|Code Gen| INTELLIGENT

    %% Builder relationship
    BUILDER -.->|Packaged into| AGENT

    classDef frontend fill:#4CAF50,stroke:#2E7D32,color:#fff
    classDef backend fill:#2196F3,stroke:#1565C0,color:#fff
    classDef data fill:#FF9800,stroke:#E65100,color:#fff
    classDef external fill:#9C27B0,stroke:#6A1B9A,color:#fff
    classDef edge fill:#607D8B,stroke:#37474F,color:#fff

    class UI,API frontend
    class AGENT,FAST,BALANCED,INTELLIGENT,RETRIEVAL,SEARCH,UTILITY,GENERATION,ANALYSIS,USER_DOCS backend
    class REDIS,MILVUS data
    class NIM_LLM,NIM_EMBED,NIM_RERANK,NIM_IMAGE,SERPAPI external
    class NGINX edge
```

## Component Details

### 1. Client Layer

**User Browser**

- Modern web browser with JavaScript enabled
- Supports WebSockets for real-time streaming
- Handles authentication tokens (JWT)
- **PWA Support**: The frontend is a Progressive Web App (PWA) enabling an installable, app-like experience on desktop and mobile.
- **Asynchronous Chat**: In PWA mode, long-running agent tasks can be processed in the background. The user can close the app and receive a notification when the response is ready.

### 2. Edge Layer

**NGINX Reverse Proxy**

- TLS termination for HTTPS traffic
- Routes requests to frontend and backend services
- Serves static assets and generated images
- Ports: 80 (HTTP), 443 (HTTPS)
- Configuration: `nginx/conf.d/frontend.conf`

### 3. Application Layer

#### Frontend (Next.js)

**Technology Stack:**

- Next.js 14.2 with React 18
- TypeScript for type safety
- Edge runtime for API routes
- Tailwind CSS for styling

**Key Components:**

- **Authentication**: JWT-based auth with bcrypt password hashing
- **Chat Interface**: Real-time streaming chat with markdown support
- **Chat Components**: Message bubbles, code blocks, images, charts
- **Sidebar**: Conversation history and folder management
- **Settings**: User preferences and configuration

**API Routes:**

- `/api/chat.ts`: Main chat endpoint, proxies to backend
- `/api/auth/*`: Authentication endpoints
- `/api/session/*`: Session management
- `/api/usage/*`: Usage tracking and statistics

**Key Features:**

- Streaming responses with Server-Sent Events
- Intermediate step visualization
- Base64 content filtering for performance
- Message history management
- Multi-language support (i18next)
- Automatic usage tracking per user

#### Backend (NeMo Agent Toolkit)

**Core Component:**

- Tool-calling agent with multi-tier LLM strategy
- Handles complex orchestration of tools and models
- Streaming response support
- Error handling and recovery

**LLM Strategy:**

1. **Fast LLM** (Nemotron Nano 9B)

   - Quick responses for simple tasks
   - Low latency operations
   - Prompt rewriting for image generation

2. **Balanced LLM** (Llama 3.3 49B)

   - Default agent LLM
   - General-purpose tasks
   - Good quality/speed tradeoff
   - Optimizable parameters

3. **Intelligent LLM** (GPT-OSS 120B)
   - Complex reasoning tasks
   - Code generation
   - Deep analysis tools
   - Highest quality outputs

**Tool Categories:**

1. **Knowledge Retrieval Tools**

   - `geolocation_retriever_tool`: Canonical geolocation data (top-1 with reranking)
   - `nvidia_retriever_tool`: NVIDIA docs and blogs
   - `kubernetes_retriever_tool`: K8s documentation
   - `veterinarian_retriever_tool`: Veterinary knowledge
   - Uses Smart Milvus with reranking

2. **Web Search & Information**

   - `serpapi_search_tool`: Google standard search with organic results, related questions, and web scraping enrichment (geolocation integration)
   - `serpapi_ai_tool`: Google AI Mode search with AI-generated summaries and structured text blocks (geolocation integration)
   - `serpapi_news_tool`: News aggregation with geolocation integration
   - `wikipedia_search_tool`: Wikipedia queries
   - `webscrape_tool`: Web page content extraction
   - `rss_feed_tool`: RSS feed monitoring, search, and content scraping with reranking

3. **Utility Tools**

   - `current_datetime_tool`: System time
   - `weather_tool`: Weather forecasting with hourly data and geolocation integration

4. **Content Generation**

   - `code_generation_tool`: Python code generation using intelligent LLM
   - `image_generation_tool`: Stable Diffusion 3.5 images (returns base64-encoded PNG in markdown format)
   - `image_augmentation_tool`: Augments existing images from text prompts using NVIDIA Flux Kontext NIM

5. **Specialized Analysis**
   - `bang_for_buck_tool`: Infrastructure ROI calculator
   - `first_principles_tool`: First-principles reasoning
   - `socratic_method_tool`: Socratic dialogue
   - `thinker_sequential_executor_tool`: Deep reasoning orchestrator

6. **User Document Processing**
   - `pdf_ingest_tool`: Processes user-uploaded PDFs using NVIDIA NvIngest service and indexes them into a user-specific Milvus collection for retrieval-augmented generation (RAG)

**SerpAPI Tool Comparison:**

| Feature                | serpapi_search_tool                                           | serpapi_ai_tool                         |
| ---------------------- | ------------------------------------------------------------- | --------------------------------------- |
| **Engine**             | `google`                                                      | `google_ai_mode`                        |
| **Results Type**       | Raw search results                                            | AI-generated summaries                  |
| **Web Scraping**       | Yes (enrichment)                                              | No (self-contained)                     |
| **Response Structure** | Organic results, related questions, hierarchical (0-3 levels) | Structured text blocks with references  |
| **Text Blocks**        | Only in ai_overview (if available)                            | Primary response format                 |
| **Source Citations**   | URLs in organic results                                       | Structured references with snippets     |
| **Geolocation**        | Optional integration                                          | Optional integration                    |
| **Use Case**           | Comprehensive search with multiple result types               | Quick AI-generated answers with sources |
| **Latency**            | Higher (due to scraping)                                      | Lower (no scraping)                     |
| **Result Hierarchy**   | 4 levels (0-3)                                                | Single level                            |

**Geolocation Integration:**

The geolocation retriever provides intelligent location name resolution for location-aware tools:

- **Purpose**: Resolve fuzzy or ambiguous location names to canonical forms
- **Technology**: Smart Milvus retriever with vector search and reranking
- **Data Source**: Milvus `geolocation` collection with canonical location data
- **Integration**: Used by `serpapi_search_tool`, `serpapi_ai_tool`, `serpapi_news_tool`, and `weather_tool`
- **Process**:
  1. User provides location (e.g., "SF", "Ann Arbor", "NYC")
  2. Location embedded using NIM Embeddings
  3. Vector search in geolocation collection (top-5 candidates)
  4. Reranked to top-1 canonical location
  5. Returns structured data: canonical name, GPS coordinates, country code
  6. Tool uses canonical location for API requests
- **Benefits**:
  - Consistent location naming across tools
  - Handles abbreviations and informal names
  - Reduces ambiguity in location-based queries
  - Improves search result relevance
  - Better weather data accuracy
- **Configuration**: Optional (controlled by `use_geolocation_retriever` flag in tool config)
- **Fallback**: Tools gracefully fall back to original location if retriever fails

### 4. Data Layer

**Redis**

- Version: Redis 8.0.3 (Kubernetes) / Redis 7 Alpine (Docker Compose)
- Persistence: AOF (Append-Only File) + RDB snapshots
- Use cases:
  - Session management
  - Chat history storage
  - Rate limiting
  - Caching
  - User-level usage tracking
  - Temporary storage for uploaded images and PDFs
- Configuration: Save every 60s if ≥1 key changed
- Port: 6379
- Storage:
  - Docker Compose: Local volume mount
  - Kubernetes: PVC with 64Gi capacity
- Redis JSON module: Used for structured data storage (users, sessions, usage stats)

**RedisInsight** (Kubernetes only)

- Version: latest
- Purpose: Redis management and monitoring UI
- Features:
  - Visual database browser
  - Query execution and profiling
  - Performance monitoring
  - Memory analysis
  - Key pattern analysis
- Port: 5540
- Auto-configured to connect to Redis instance
- Storage: PVC with 4Gi capacity
- Access: ClusterIP service with optional NodePort

### 5. External Services

**NVIDIA Cloud Functions (NIM)**

1. **LLM Endpoints**

   - Nemotron Nano 9B (fast)
   - Llama 3.3 49B (balanced)
   - GPT-OSS 120B (intelligent)
   - OpenAI-compatible API

2. **Embedding Model**

   - Llama 3.2 1B Embed QA
   - Text-to-vector conversion
   - Used for semantic search

3. **Reranker**

   - Llama 3.2 1B Rerank QA
   - Improves retrieval relevance
   - Top-K → Top-N refinement

4. **Image Generation**
   - Stable Diffusion 3.5 Large model
   - Configurable dimensions (768-1344 pixels)
   - Default: 1024x1024 resolution
   - Optional prompt rewriting with fast LLM
   - Returns base64-encoded PNG
   - Up to 300s timeout
   - Supports 50 diffusion steps (configurable 5-100)

**Milvus Vector Database**

- Kubernetes cluster deployment
- Collections:
  - `geolocation`: Canonical geolocation data for location resolution
  - `kubernetes`: K8s documentation
  - `nvidia`: NVIDIA corporate/technical docs
  - `vetpartner`: Veterinary knowledge
- Features: Vector search with reranking

**SerpAPI**

- Web search integration (Google standard search)
- AI Mode search with structured summaries
- News search capabilities
- Location-aware results with geolocation integration

### 6. Builder Environment

**Purpose**: Package custom NAT functions

**Custom Functions:**

- `serpapi_search`: Google standard search via SerpAPI with geolocation integration
- `serpapi_ai`: Google AI Mode search with structured summaries and geolocation integration
- `serpapi_news`: News aggregation with geolocation integration
- `image_generation`: SD 3.5 integration
- `smart_milvus`: Enhanced Milvus retrieval with reranking
- `weather`: Weather data fetching with geolocation integration
- `webscrape`: Web content extraction
- `rss_feed`: RSS feed parsing, reranking, and scraping
- `pdf_ingest`: PDF processing with NvIngest

**Build Process:**

- Base image with NAT toolkit
- Install custom function packages
- Deploy as backend container

## Data Flow

### 1. User Chat Request

The chat request flow varies depending on the client (PWA vs. standard browser) and whether background processing is enabled.

#### Standard SSE Streaming (Default)

This is the default mode for standard web browsers.

```mermaid
sequenceDiagram
    participant User
    participant Frontend (Browser)
    participant ChatAPI as /api/chat
    participant Backend
    participant Redis

    User->>Frontend (Browser): Sends message
    Frontend (Browser)->>ChatAPI: POST /api/chat (SSE)
    ChatAPI->>Redis: Authenticates session
    ChatAPI->>Backend: Proxies request
    Backend->>Backend: Processes with LLM/Tools
    Backend-->>ChatAPI: Streams response chunks
    ChatAPI-->>Frontend (Browser): Streams chunks to UI
    Frontend (Browser)->>User: Renders streaming response
```

#### Asynchronous Job Processing (PWA)

When the user is running the application as a PWA and has background processing enabled, a job-based flow is used.

```mermaid
sequenceDiagram
    participant User
    participant Frontend (PWA)
    participant AsyncAPI as /api/chat/async
    participant Redis

    User->>Frontend (PWA): Sends message
    Frontend (PWA)->>AsyncAPI: POST /start (initiates job)
    AsyncAPI->>Redis: Creates job, returns jobId
    AsyncAPI-->>Frontend (PWA): Returns jobId
    Frontend (PWA)->>User: Shows "processing in background"
    Note over User, Frontend (PWA): User can now close the app

    loop Poll for status
        Frontend (PWA)-->>AsyncAPI: GET /status?jobId=...
        AsyncAPI-->>Redis: Get job status
        Redis-->>AsyncAPI: Return status
        AsyncAPI-->>Frontend (PWA): Stream partial response
    end

    Note over Frontend (PWA): When app is in background, Service Worker handles polling and notifications.
```

### 2. Retrieval-Augmented Generation (RAG)

```
User asks domain-specific question
  ↓
Agent calls appropriate retriever tool
  ↓
Query embedded via NIM Embeddings
  ↓
Vector search in Milvus (top-K results)
  ↓
Results reranked via NIM Reranker (top-N)
  ↓
Context provided to LLM
  ↓
LLM generates answer using retrieved context
  ↓
Response streamed to user
```

**Example for Geolocation:**

```
User provides fuzzy location (e.g., "SF")
  ↓
Geolocation retriever tool called
  ↓
Query embedded via NIM Embeddings
  ↓
Vector search in Milvus geolocation collection (top-5)
  ↓
Reranked to top-1 canonical location
  ↓
Returns "San Francisco, California, United States"
  ↓
Canonical location used for weather/search tools
```

### 3. Image Generation

```mermaid
graph TD
    A[User requests image] --> B{Agent calls image_generation_tool};
    B --> C{Fast LLM rewrites prompt (optional)};
    C --> D[Request sent to SD 3.5 NIM endpoint];
    D --> E[Image generated];
    E --> F[Base64 PNG returned];
    F --> G[Backend wraps in markdown];
    G --> H[Response streamed to frontend];
    H --> I[Frontend renders inline image];
```

**Note:** Images are returned as base64-encoded data embedded in markdown, not saved to disk. A `/tmp/generated_images` volume exists for optional file-based serving but is not currently used by the image generation function.

### 4. Image Augmentation Flow

```mermaid
graph TD
    A[User uploads image] --> B{Frontend uploads to Redis};
    B --> C[User requests augmentation];
    C --> D{Agent calls image_augmentation_tool};
    D --> E[Function fetches image from Redis];
    E --> F[Image resized to valid dimensions];
    F --> G[Request sent to Flux Kontext NIM];
    G --> H[Augmented image returned as Base64];
    H --> I[Backend wraps in markdown];
    I --> J[Frontend renders inline image];
```

### 5. PDF Ingestion Flow

```mermaid
graph TD
    A[User uploads PDF] --> B{Frontend uploads to Redis};
    B --> C[User requests processing];
    C --> D{Agent calls pdf_ingest_tool};
    D --> E[Function fetches PDF from Redis];
    E --> F[PDF sent to NvIngest Service];
    F --> G[Text extracted and chunked];
    G --> H[Chunks embedded via NIM Embeddings];
    H --> I[Embeddings stored in user-specific Milvus collection];
    I --> J[Success message returned to user];
```

### 6. RSS Feed Search Flow

```mermaid
graph TD
    A[User provides search query] --> B{Agent calls rss_feed_tool};
    B --> C{Function fetches and parses RSS feed (with caching)};
    C --> D[Entry titles sent to NIM Reranker with query];
    D --> E[Top-ranked entry selected];
    E --> F[Full content scraped from top entry's link];
    F --> G[Content truncated to fit token limit];
    G --> H[Scraped content returned to LLM];
    H --> I[LLM generates answer using content];
    I --> J[Response streamed to user];
```

### 7. Web Search with AI Mode

```
User requests information via web search
  ↓
Agent selects between serpapi_search_tool or serpapi_ai_tool
  ↓
If location provided, geolocation_retriever resolves it (optional)
  ↓
serpapi_ai_tool: Requests AI-generated summary
  ↓
Returns structured text blocks with source references
  ↓
OR serpapi_search_tool: Requests standard search results
  ↓
Returns organic results, related questions, and enriched content
  ↓
Response streamed to user with formatted markdown
```

### 8. Location-Aware Tool Integration

```
User asks location-aware question (weather, news, search)
  ↓
Tool receives location parameter (e.g., "Ann Arbor")
  ↓
If geolocation integration enabled:
  ↓
  geolocation_retriever_tool called
  ↓
  Fuzzy location → Canonical location (e.g., "Ann Arbor, Michigan, United States")
  ↓
Tool uses canonical location for API request
  ↓
More accurate, consistent results returned
```

**Supported Tools with Geolocation:**

- `serpapi_search_tool`: Better search result locality
- `serpapi_ai_tool`: Improved AI summary context
- `serpapi_news_tool`: More relevant news results
- `weather_tool`: Accurate weather data fetching

### 9. Code Generation

```
User requests code
  ↓
Agent calls code_generation_tool
  ↓
Intelligent LLM (GPT-OSS 120B) generates code
  ↓
Code returned with proper formatting
  ↓
Frontend renders with syntax highlighting
```

### 10. Usage Tracking

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant ChatAPI
    participant Backend
    participant TrackAPI
    participant Redis

    User->>Frontend: Send chat message
    Frontend->>ChatAPI: POST /api/chat (with username)
    ChatAPI->>Backend: POST /chat (with x-user-id header)
    Backend->>ChatAPI: Stream response with usage data
    ChatAPI->>TrackAPI: POST /api/usage/track (async)
    TrackAPI->>Redis: Store usage stats
    ChatAPI->>Frontend: Return chat response
    Frontend->>User: Display response
```

**Usage Data Structure:**

- Total tokens (prompt + completion)
- Request count per user
- Daily usage breakdown (last 90 days)
- Monthly usage breakdown
- First and last request timestamps

**Redis Key Pattern:**

```
usage:user:<username>
```

**Example Usage Stats:**

```json
{
  "username": "john_doe",
  "total_prompt_tokens": 15000,
  "total_completion_tokens": 20000,
  "total_tokens": 35000,
  "request_count": 100,
  "first_request_at": 1672531200000,
  "last_request_at": 1704067200000,
  "daily_usage": {
    "2025-09-30": {
      "prompt_tokens": 150,
      "completion_tokens": 200,
      "total_tokens": 350
    }
  },
  "monthly_usage": {
    "2025-09": {
      "prompt_tokens": 5000,
      "completion_tokens": 6000,
      "total_tokens": 11000
    }
  }
}
```

## Deployment Architecture

### Docker Compose Deployment

**Services:**

```
Services:
├── builder (development helper)
├── backend (NAT agent)
├── frontend (Next.js app)
├── nginx (reverse proxy)
└── redis (data persistence)

Volumes:
├── ssl_certs (TLS certificates)
├── generated_images (reserved for file-based image serving, not currently used)
└── redis/data (persistent storage)

Network:
└── daedalus-network (bridge)
```

**Use Case:** Local development and testing

**Note:** Images are currently returned as base64 inline data, not saved to the `generated_images` volume.

### Kubernetes Deployment (Helm Chart)

#### Kubernetes Architecture Diagram

```mermaid
graph TB
    subgraph "External Traffic"
        INTERNET[Internet/Users]
    end

    subgraph "Kubernetes Cluster"
        subgraph "Ingress Layer (Optional)"
            INGRESS[Ingress Controller<br/>Optional External Access]
        end

        subgraph "Namespace: daedalus"
            subgraph "Edge Services"
                NGINX_SVC[NGINX Service<br/>ClusterIP:80/443]
                NGINX_POD[NGINX Pod<br/>- Routing<br/>- TLS Termination<br/>- Restricted Mode]
                NGINX_CFG[ConfigMap<br/>nginx-conf<br/>Two Modes]
                NGINX_PVC[PVC<br/>generated-images<br/>1Gi]
            end

            subgraph "Application Services"
                FE_SVC[Frontend Service<br/>ClusterIP:3000]
                FE_POD[Frontend Pod<br/>Next.js<br/>Port 3000]
                FE_SECRET[Secret<br/>frontend-env<br/>Environment Vars]

                BE_SVC[Backend Service<br/>ClusterIP:8000]
                BE_POD[Backend Pod<br/>NAT Agent<br/>Port 8000]
                BE_CFG[ConfigMap<br/>backend-config<br/>config.yaml]
                BE_SECRET[Secret<br/>backend-env<br/>API Keys]
                BE_PVC[PVC<br/>backend-data<br/>6Gi]
                BE_NP[NetworkPolicy<br/>Restrict Access]
            end

            subgraph "Data Services"
                REDIS_SVC[Redis Service<br/>ClusterIP:6379]
                REDIS_POD[Redis Pod<br/>v8.0.3<br/>AOF + RDB]
                REDIS_PVC[PVC<br/>redis-data<br/>64Gi]

                RI_SVC[RedisInsight Service<br/>ClusterIP:5540]
                RI_POD[RedisInsight Pod<br/>Management UI]
                RI_PVC[PVC<br/>redisinsight-data<br/>4Gi]
            end
        end

        subgraph "External Dependencies"
            MILVUS_EXT[Milvus Vector DB<br/>milvus.milvus.svc<br/>Port 19530]
        end
    end

    subgraph "External Cloud Services"
        NIM[NVIDIA NIM<br/>LLMs, Embeddings<br/>Reranker, Image Gen]
        SERP[SerpAPI<br/>Web/News Search]
    end

    %% Traffic Flow
    INTERNET -->|HTTPS| INGRESS
    INGRESS --> NGINX_SVC
    NGINX_SVC --> NGINX_POD

    %% NGINX Modes
    NGINX_CFG -.->|Normal Mode| NGINX_POD
    NGINX_CFG -.->|Restricted Mode| NGINX_POD
    NGINX_POD -->|Proxy to Frontend| FE_SVC
    NGINX_POD -.->|Direct API<br/>Normal Mode Only| BE_SVC

    %% Frontend to Backend
    FE_SVC --> FE_POD
    FE_POD -->|/api/chat| BE_SVC
    FE_POD -->|Session Auth| REDIS_SVC
    FE_POD -->|Usage Tracking| REDIS_SVC

    %% Backend connections
    BE_SVC --> BE_POD
    BE_POD --> REDIS_SVC
    BE_POD -->|External APIs| NIM
    BE_POD -->|Search| SERP
    BE_POD -->|Vector Search| MILVUS_EXT

    %% Redis connections
    REDIS_SVC --> REDIS_POD
    RI_SVC --> RI_POD
    RI_POD -->|Monitor| REDIS_SVC

    %% Storage
    NGINX_POD -.->|Mount| NGINX_PVC
    BE_POD -.->|Mount| BE_PVC
    REDIS_POD -.->|Mount| REDIS_PVC
    RI_POD -.->|Mount| RI_PVC

    %% Config & Secrets
    FE_POD -.->|Load| FE_SECRET
    BE_POD -.->|Load| BE_CFG
    BE_POD -.->|Load| BE_SECRET

    %% Network Policy
    BE_NP -.->|Protect| BE_POD

    classDef k8s fill:#326CE5,stroke:#1A4B9E,color:#fff
    classDef storage fill:#FF9800,stroke:#E65100,color:#fff
    classDef config fill:#9C27B0,stroke:#6A1B9A,color:#fff
    classDef external fill:#4CAF50,stroke:#2E7D32,color:#fff
    classDef security fill:#F44336,stroke:#C62828,color:#fff

    class NGINX_SVC,FE_SVC,BE_SVC,REDIS_SVC,RI_SVC k8s
    class NGINX_POD,FE_POD,BE_POD,REDIS_POD,RI_POD k8s
    class NGINX_PVC,BE_PVC,REDIS_PVC,RI_PVC storage
    class NGINX_CFG,BE_CFG,FE_SECRET,BE_SECRET config
    class NIM,SERP,MILVUS_EXT external
    class BE_NP,INGRESS security
```

#### Helm Chart Components

**Chart Information:**

- **Name:** daedalus
- **Version:** 0.1.0
- **Type:** Application
- **Location:** `helm/daedalus/`

**Deployments:**

1. **Backend Deployment**

   - Replicas: 1
   - Image: `daedalus.ddns.me:5050/btuttle/daedalus:backend-{version}`
   - Port: 8000
   - Environment: Loaded from Secret
   - Volumes: config.yaml (ConfigMap), /data (PVC)
   - Service: ClusterIP

2. **Frontend Deployment**

   - Replicas: 1
   - Image: `daedalus.ddns.me:5050/btuttle/daedalus:frontend-{version}`
   - Port: 3000
   - Environment: Auto-configured with K8s service FQDNs
   - Service: ClusterIP

3. **NGINX Deployment**

   - Replicas: 1
   - Image: `nginx:alpine`
   - Ports: 80 (HTTP), 443 (HTTPS - optional)
   - Volumes: nginx-conf (ConfigMap), generated-images (PVC), tls-secret (Secret - optional)
   - Service: ClusterIP with optional NodePort

4. **Redis Deployment**

   - Replicas: 1
   - Image: `redis:8.0.3`
   - Port: 6379
   - Persistence: AOF + RDB
   - Volume: redis-data (PVC - 64Gi)
   - Service: ClusterIP

5. **RedisInsight Deployment**
   - Replicas: 1
   - Image: `redis/redisinsight:latest`
   - Port: 5540
   - Purpose: Redis management and monitoring UI
   - Volume: redisinsight-data (PVC - 4Gi)
   - Service: ClusterIP with optional NodePort
   - Auto-configured to connect to Redis

**ConfigMaps:**

1. **backend-config**

   - Contains: `config.yaml` with NAT workflow configuration
   - Mounted at: `/workspace/config.yaml`

2. **nginx-conf**
   - Contains: `frontend.conf` NGINX configuration
   - Two modes:
     - **Normal Mode:** Allows direct API access through NGINX
     - **Restricted Mode:** Blocks direct API access, forces through frontend
   - Template-driven with Helm variables

**Secrets:**

1. **backend-env**

   - NVIDIA API keys
   - External service credentials
   - Environment-specific settings

2. **frontend-env**

   - Authentication credentials
   - Session secrets
   - Feature flags

3. **TLS Secret (Optional)**
   - Certificate and key for HTTPS
   - Name configurable via `nginx.https.tlsSecretName`

**Persistent Volume Claims:**

1. **backend-data** (6Gi)

   - Backend optimizer results
   - Temporary processing data

2. **redis-data** (64Gi)

   - Chat history
   - Session data
   - Cached responses

3. **redisinsight-data** (4Gi)

   - RedisInsight configuration
   - Saved queries and settings

4. **generated-images** (1Gi)
   - Reserved for file-based image serving
   - Currently unused (images returned as base64 inline)
   - Available for NGINX to serve from `/images/*` endpoint

**Network Policies:**

1. **backend-networkpolicy** (Optional, enabled by default)
   - Restricts backend ingress to:
     - Frontend pods only
     - NGINX pods (if needed)
     - Same namespace for health checks
   - Prevents direct external access to backend
   - Enhances security posture

**Ingress (Optional):**

- Kubernetes Ingress resource for external access
- Configurable ingress class
- TLS termination support
- Routes to NGINX service

#### NGINX Configuration Modes

**Normal Mode** (`restrictedMode: false`):

- Allows direct API access through NGINX
- Routes for:
  - `/v1/*` → Backend (OpenAI-compatible)
  - `/generate/*` → Backend (NAT generate endpoint)
  - `/chat/*` → Backend (NAT chat endpoint)
  - `/upload/*`, `/tools/*`, `/health/*` → Backend
  - `/evaluate` → Backend (with extended timeouts)
  - `/images/*` → Static files from PVC
  - `/` → Frontend
- Use case: Direct API integration, testing

**Restricted Mode** (`restrictedMode: true`, default):

- Blocks all direct API access with 403 Forbidden
- Only allows:
  - `/` → Frontend (all requests through Next.js)
  - `/_next/*` → Frontend static assets
  - `/images/*` → Generated images (if enabled)
  - Static files (js, css, images, fonts)
- Use case: Production security, force auth through frontend
- Security: Prevents API key exposure, enforces frontend authentication

#### Service Discovery

All services use Kubernetes DNS with fully qualified domain names:

```
<release>-<component>.<namespace>.svc.cluster.local
```

**Examples:**

- Backend: `myrelease-daedalus-backend.daedalus.svc.cluster.local:8000`
- Frontend: `myrelease-daedalus-frontend.daedalus.svc.cluster.local:3000`
- Redis: `myrelease-daedalus-redis.daedalus.svc.cluster.local:6379`
- NGINX: `myrelease-daedalus-nginx.daedalus.svc.cluster.local:80`

#### Helm Values Configuration

**Key Configuration Options:**

```yaml
# Enable/disable components
backend.enabled: true
frontend.enabled: true
nginx.enabled: true
redis.enabled: true

# Security
backend.networkPolicy.enabled: true # Restrict backend access
nginx.config.restrictedMode: true # Block direct API access

# TLS/HTTPS
nginx.https.enabled: true
nginx.https.tlsSecretName: "my-tls-secret"

# Storage
backend.persistence.size: 6Gi
redis.persistence.size: 64Gi
nginx.imageVolume.size: 1Gi

# External access
ingress.enabled: false
ingress.className: "nginx"
ingress.hosts: []
```

#### Deployment Workflow

**Script:** `helm-build-deploy.sh`

**Steps:**

1. Validate prerequisites (kubectl, helm, namespace)
2. Build Docker images for backend and frontend
3. Push images to container registry
4. Create Kubernetes namespace (if needed)
5. Create secrets from `.env` file:
   ```bash
   kubectl create secret generic <release>-daedalus-backend-env \
     --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
   kubectl create secret generic <release>-daedalus-frontend-env \
     --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
   ```
6. Provision TLS secrets (optional)
7. Install or upgrade Helm chart:
   ```bash
   helm upgrade --install <release> ./helm/daedalus \
     -n <namespace> \
     -f values.yaml \
     --set-file backend.config.data=backend/config.yaml
   ```
