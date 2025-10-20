# Daedalus

## Overview

Daedalus is a full-stack AI agent platform built on the NVIDIA NeMo Agent Toolkit (NAT). It provides an intelligent chat interface with multi-modal capabilities including web search, retrieval-augmented generation, image processing, and document analysis. The system uses a microservice architecture with a Next.js frontend, Python-based backend agent service, Redis for session management, and optional NGINX reverse proxy for production deployments.

The platform orchestrates multiple LLM tiers (fast, balanced, and intelligent) to optimize response quality and speed, and integrates numerous specialized tools for search, weather, web scraping, image generation/augmentation, PDF processing, and analytical reasoning.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture (Next.js)

**Technology Stack:**
- Next.js 14.2.10 with TypeScript
- React 18.2.0 for UI components
- Tailwind CSS with custom design system for styling
- next-i18next for internationalization (22+ locales supported)
- Full Progressive Web App (PWA) support with offline capabilities

**Authentication & Authorization:**
- Custom JWT-based authentication using jsonwebtoken and bcryptjs
- Redis-backed session management via ioredis
- User-specific data isolation using username-scoped localStorage keys
- Protected routes via AuthProvider context and ProtectedRoute wrapper
- Cookie-based session persistence

**State Management:**
- React Context API (HomeContext, ChatbarContext, AuthContext)
- Custom useCreateReducer hook for typed reducers
- Local state with hooks (useState, useEffect, useCallback)
- User-scoped localStorage for conversations, settings, and folders

**Key Design Patterns:**
- Memoization with React.memo and useMemo to prevent unnecessary re-renders
- Server-Side Rendering (SSR) with getServerSideProps for initial page loads
- Responsive, mobile-first design with fluid typography and touch-friendly spacing
- Custom hooks for keyboard visibility, iOS fixes, and conversation operations

**Real-time Communication:**
- Server-Sent Events (SSE) for streaming chat responses
- SSEClient service handles reconnection logic and event parsing
- Support for intermediate step updates, chat tokens, and error handling

**Multi-modal Capabilities:**
- Image upload, compression, and Redis storage via /api/session/imageStorage
- PDF upload and Redis storage via /api/session/pdfStorage
- Optimized lazy-loading images with OptimizedImage component
- Voice recording with browser MediaRecorder API
- Image augmentation requests via imageRef references

**Progressive Web App (PWA) Features:**
- **Installable:** Full support for "Add to Home Screen" on iOS, Android, and desktop
- **Offline Support:** Service worker caching with cache-first strategy for static assets
- **Auto-Updates:** Automatic service worker updates with user notification
- **Offline Indicator:** Real-time network status indicator with smooth animations
- **App-like Experience:** Standalone display mode with custom theme colors
- **Mobile Optimization:** 
  - Safe-area support for notched devices (iPhone X+, modern Android)
  - Responsive padding utilities that adapt to screen size
  - Smart keyboard handling - input stays visible when typing on mobile
  - Auto-scroll management prevents chat from covering input field
- **Platform-Specific Meta Tags:** iOS splash screens, Windows tiles, and Android theming
- **Background Processing:** 
  - **Async Job Pattern**: PWA uses job-based polling with Redis persistence to allow LLM responses to complete server-side when screen is locked
  - **Job Persistence**: Active jobId + conversationId stored in localStorage to survive component unmounts and JS context freezes
  - **Automatic Resume**: On app visibility or mount, checks localStorage for persisted jobs and resumes polling immediately
  - **Push Notifications**: Alerts when responses complete (only if user is away from app)
  - **Visibility API**: Triggers immediate job status refetch when app becomes visible
  - **Server-Side Processing**: Backend continues generating responses even if client disconnects
  - **Polling Strategy**: Client polls every 2 seconds, with immediate refetch on visibility change
  - **Completion Reconciliation**: Completed jobs are fetched from Redis and reconciled into conversation state with full intermediate steps

### Backend Architecture (NeMo Agent Toolkit)

**Agent Orchestration:**
- Tool-calling agent with multi-tier LLM strategy
- Three LLM tiers for different use cases:
  - Fast: Nemotron Nano 9B for quick responses
  - Balanced: Llama 3.3 49B for general tasks
  - Intelligent: GPT-OSS 120B for complex reasoning

**Tool Categories:**
1. **Retrieval Tools:** Geolocation, Kubernetes docs, NVIDIA docs, veterinarian knowledge
2. **Search Tools:** SerpAPI (standard, AI mode, news), Wikipedia
3. **Utility Tools:** Weather, DateTime, WebScrape
4. **Generation Tools:** Code generation, image generation (Stable Diffusion 3.5), image augmentation (Flux Kontext)
5. **Analysis Tools:** Bang-for-Buck, First Principles, Socratic Method

**Custom NAT Functions:**
- Each tool is packaged as a reusable NAT function with config.yml
- Python-based with setuptools for installation
- Configurable via YAML with environment variable support
- Support for API keys (SerpAPI, NVIDIA NIM endpoints)

### Data Layer

**Redis:**
- Primary data store for session state and chat history
- Image and PDF attachment storage with TTL
- Rate limiting and usage tracking
- User-specific session isolation by sessionId

**Storage Strategy:**
- Frontend: User-scoped localStorage keys (prevents data leakage between users)
- Backend: Redis with session-based keys
- Migration logic for legacy non-user-scoped data
- Automatic cleanup of user data on logout

**Session Management:**
- Session ID stored in user-scoped localStorage
- Conversation ID maps to session ID for backend correlation
- Image and PDF attachments linked to session via imageRef/pdfRef objects

### Infrastructure & Deployment

**Docker Compose Stack:**
- Frontend container (Next.js standalone build)
- Backend container (NAT Python runtime)
- Redis container with persistent volume
- Optional NGINX container for reverse proxy and TLS termination

**Kubernetes Deployment:**
- Helm chart in /helm/daedalus directory
- Separate secrets for backend and frontend environment variables
- ConfigMap for backend config.yaml
- Service definitions for internal cluster communication

**Reverse Proxy (NGINX):**
- TLS termination and certificate management
- Static asset serving
- Proxy pass to frontend and backend services
- Port 80/443 external exposure

### API Endpoints

**Frontend API Routes:**
- `/api/auth/login` - POST - User authentication
- `/api/auth/logout` - POST - Session termination
- `/api/auth/me` - GET - Current user info
- `/api/chat` - POST - Send chat messages, stream responses via SSE (browser mode)
- `/api/chat/async` - POST/GET/DELETE - Async job management for background processing (PWA mode)
- `/api/session/imageStorage` - GET/POST - Image upload/retrieval (max 5MB)
- `/api/session/pdfStorage` - GET/POST - PDF upload/retrieval (max 20MB)

**Backend Endpoints:**
- Chat completion endpoint (configurable via chatCompletionURL)
- Image generation endpoint (Stable Diffusion 3.5)
- Image augmentation endpoint (Flux Kontext)
- NvIngest PDF processing endpoint

### Security Considerations

**Data Isolation:**
- User-specific localStorage keys prevent data leakage
- Session-based Redis keys with user context
- Protected routes require authentication
- Automatic migration of legacy data to user-scoped keys

**Authentication Flow:**
- JWT tokens in HTTP-only cookies (recommended for production)
- bcryptjs password hashing
- Redis-backed session validation
- Automatic re-authentication checks on mount

**Input Validation:**
- Image compression before upload (max 5MB server action limit)
- File type validation for PDFs and images
- Content sanitization for chat messages
- HTML malformation fixes in markdown rendering

## External Dependencies

### Third-Party APIs

**SerpAPI:**
- Google search, AI Mode, and News search
- API key required (set via SERPAPI_KEY environment variable)
- Used by serpapi_search, serpapi_ai, and serpapi_news NAT functions

**NVIDIA NIM:**
- Embeddings and reranking models
- Image generation (Stable Diffusion 3.5)
- Image augmentation (Flux Kontext)
- API key required (set via NVIDIA_API_KEY environment variable)

**NvIngest:**
- PDF document processing and text extraction
- Requires NvIngest service host and port configuration
- Integrates with Milvus for vector storage

### Vector Database

**Milvus:**
- Vector storage for retrieval-augmented generation
- User-specific collections for document storage
- Configurable embedding dimensions (default 2048)
- Optional reranking integration with NVIDIA NIM

**MinIO:**
- Object storage for NvIngest processing
- Configured with endpoint and credentials

### NPM Packages

**Core Dependencies:**
- next, react, react-dom - Framework and UI
- ioredis - Redis client
- jsonwebtoken, bcryptjs - Authentication
- next-i18next, i18next - Internationalization
- react-hot-toast - Notifications
- uuid - ID generation
- lodash - Utility functions
- eventsource-parser - SSE parsing

**UI Components:**
- @tabler/icons-react - Icon library
- @radix-ui/react-select - Accessible select components
- lucide-react - Additional icons
- react-markdown, remark-gfm, rehype-raw - Markdown rendering
- react-syntax-highlighter - Code highlighting

**Charts & Visualizations:**
- recharts - Chart components
- chart.js, react-chartjs-2 - Additional charting
- react-force-graph-2d - Network graphs
- pptxgenjs - PowerPoint export

**Utilities:**
- html-to-image - Screenshot generation
- file-saver - File downloads
- @dqbd/tiktoken - Token counting
- jwt-decode - JWT parsing

### Python Dependencies (Backend)

**NAT Functions:**
- NVIDIA NeMo Agent Toolkit (nat) - Core agent framework
- serpapi - Search API client
- Milvus SDK - Vector database client
- Redis client - Session storage

**Deployment:**
- Docker and Docker Compose v2
- Kubernetes (for cluster deployments)
- Helm 3 (for Kubernetes package management)
- Node.js 18+ and npm 9+ (frontend development)
- Python 3.13 and uv (builder workflows)