# Daedalus

Daedalus is a full-stack reference implementation of the NVIDIA NeMo Agent toolkit that combines multi-model reasoning, retrieval-augmented generation, and a React-based chat interface for human-in-the-loop workflows.

## Features

The platform offers the following capabilities:

- Orchestrated agent runtime with tool calling, retrieval, and content generation
- Modular builder packages for search, weather, scraping, and image generation workflows
- Next.js frontend with authenticated chat experience and localization support
- Turnkey Docker Compose stack with Redis cache and NGINX reverse proxy
- Helm chart and automation scripts for Kubernetes deployments

## Repository Layout

The top-level directories are organized as follows:

- `backend/`: NeMo Agent toolkit configuration and runtime settings
- `builder/`: Custom NAT function packages and shared Docker build context
- `frontend/`: Next.js application with API routes, components, and tests
- `helm/`: Helm chart and templates for cluster deployment
- `nginx/`: Reverse proxy configuration and TLS materials
- `redis/`: Persistent volume mount point for Redis data

## Architecture

Daedalus runs as a containerized microservice stack:

- **Backend**: NAT-powered agent service exposing chat and image generation endpoints, backed by Redis for session state
- **Builder image**: Python environment that packages reusable tools such as SerpAPI search, Smart Milvus retriever, web scraping, weather, and image generation
- **Frontend**: Next.js web client providing authentication, chat UI, and settings management
- **NGINX**: Optional edge proxy that fronts HTTPS traffic and static assets
- **Redis**: Persistence for chat history, session metadata, and rate limiting

## Getting Started

### Prerequisites

You need the following before launching Daedalus:

- Docker and Docker Compose v2
- Node.js 18 or newer and npm 9 or newer (for frontend development)
- Python 3.13 and `uv` (for custom builder workflows)
- Access credentials for required third-party APIs such as SerpAPI and NVIDIA NIM endpoints

### Quick Start (Local Docker Compose)

To boot the full stack locally:

1. Copy the example environment file and adjust credentials: `cp frontend/env.example .env`
2. Start the services: `docker compose up --build`
3. Open the frontend at `http://localhost:3000` and sign in with the configured credentials

### Managing Services

The automation script in `docker-build-deploy.sh` rebuilds, pushes, and restarts the stack. Run it when you need to regenerate container images or renew registry pushes.

## Configuration

Configuration is split across the following assets:

- `.env`: Centralized environment variables for Docker Compose and Helm secrets (history retention, authentication, service endpoints)
- `backend/config.yaml`: Agent orchestration, model endpoints, retrievers, and available tool definitions
- `frontend/env.example`: Reference values for authentication, Redis access, and UI defaults
- `helm/daedalus/values.yaml`: Kubernetes service, ingress, persistence, and environment overrides

Update the secrets in your deployment environment and keep `.env` out of version control.

## Development

Follow these workflows when contributing code:

- Install frontend dependencies and run the development server with `npm install` and `npm run dev` inside `frontend/`
- Execute Vitest unit tests in watch mode using `npm run test`
- Reinstall and test builder packages with `uv pip install -e <package>` inside the `builder/` directory
- Format code with `npm run format` and lint with `npm run lint` (linting issues outside syntax errors are optional per repository guidance)

## Deployment

For Kubernetes clusters, use `helm-build-deploy.sh` to package secrets, provision TLS (optional), and install or upgrade the `helm/daedalus` chart. The script validates prerequisites, manages namespaces, and applies environment secrets from your `.env` file. Advanced users can call `helm upgrade --install` directly with the chart if they prefer manual control.

## Testing and Troubleshooting

The repository includes tooling to validate runtime health:

- `frontend/__tests__/...`: Vitest suites for import and export utilities
- `test-security.sh`: Shell script that verifies network policy and restricted mode by probing backend endpoints through NGINX and in-cluster pods
- `docker compose logs` and `helm status` are helpful for diagnosing deployment issues across services

## Security

Never commit secrets or API keys. Use Kubernetes secrets or Docker environment files to inject credentials at runtime, and run `test-security.sh` after each deployment to validate ingress restrictions.
