<p align="left">
  <img src="frontend/public/favicon.png" alt="Daedalus" width="120">
</p>

# Daedalus

Daedalus is a self-hosted AI assistant I build and maintain for myself and my
wife. I'm Brandon Tuttle, an independent developer, and this is my personal
project. Our two-person household is the use case that guides its design.

I'm sharing the code so other developers can understand it, run their own
version, adapt individual tools, and contribute useful improvements. It combines
a Next.js chat application with a Python backend built on
[NVIDIA NeMo Agent Toolkit](https://github.com/NVIDIA/NeMo-Agent-Toolkit).

The app includes chat history and streaming, image creation, document retrieval,
durable memory, tool integrations, and scheduled background work. Those
capabilities depend on the services you configure. Start with text chat, then add
what you need.

## Project expectations

I maintain this around my own use and available time. Contributions are welcome;
there is no support team, guaranteed response time, or fixed release schedule.
The repository includes tests and deployment controls, but use by two people
does not establish suitability for a larger or public service.

My home setup uses Kubernetes and several external services. Those choices are
visible as worked examples. The local starting point below needs Docker Compose
and one compatible model endpoint. It still uses the application's full images;
the initial build includes substantial Python dependencies.

## Start here

| You want to...                                      | Read this                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Run text chat with your own model endpoint          | [Local setup](#local-setup)                                                       |
| Understand the request path and find code to change | [Architecture and adaptation](docs/architecture.md)                               |
| Add integrations or adapt my home deployment        | [Operations reference](docs/operations.md), [Helm guide](helm/daedalus/README.md) |
| Fix a bug or contribute an improvement              | [Contributing](CONTRIBUTING.md)                                                   |
| Understand security boundaries or report an issue   | [Security](SECURITY.md)                                                           |

## Local setup

You need Git, Docker with the Compose plugin and BuildKit support, and an API
endpoint with a model that supports the **Responses API and tool calling**.
Have its API root URL, model name, and credential ready. Model serving happens
outside this stack; no GPU is required by the app containers themselves.

Run these commands in a fresh clone:

```bash
git clone https://github.com/tuttlebr/daedalus-agent.git
cd daedalus-agent
cp .env.example .env
```

Edit `.env` and fill in:

| Variable                                      | Value                                             |
| --------------------------------------------- | ------------------------------------------------- |
| `TOOL_CALLING_LLM_MODEL_BASE_URL`             | Your provider's API root, usually ending in `/v1` |
| `TOOL_CALLING_LLM_MODEL_MODEL`                | A model available at that endpoint                |
| `TOOL_CALLING_LLM_MODEL_API_KEY`              | Its API credential                                |
| `SESSION_SECRET`                              | A fresh value from `openssl rand -base64 32`      |
| `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_NAME` | Your login and display name                       |

The example selects [`backend/local-chat-config.yaml`](backend/local-chat-config.yaml),
which contains text chat and a clock tool. It has no MCP servers, retrieval,
Hindsight memory, or tracing configured. A Chat Completions-only model endpoint
will not work with this agent; the backend uses `/responses` for model requests.
Inside a container, `localhost` refers to that container, so use a URL reachable
from Docker for a model you host yourself.

Build the application images, then start the services:

```bash
docker compose build backend frontend redis
docker compose up -d nginx frontend stream-worker backend redis object-store object-store-init
```

Open **http://localhost:8080**, sign in, and ask for the current date and time.
A completed answer using the clock tool checks the model and tool path. Start a
second conversation and reload to check saved history.

To see service status and diagnose startup:

```bash
docker compose ps
docker compose logs --tail=100 backend stream-worker frontend
curl -fsS http://127.0.0.1:8000/health/ready
```

A healthy backend does not test your model credentials; the chat request does.
If the model request fails, check the endpoint, model, credentials, and Responses
API support. Recreate the backend after editing its YAML:

```bash
docker compose up -d --force-recreate backend
```

Stop the stack with `docker compose down`. Redis data remains in `redis/data/`
and document objects remain in a Docker volume. Local Compose uses plaintext
HTTP and development storage credentials; its frontend ports are published on
host interfaces. Use it on a trusted development machine. See the
[deployment reference](docs/operations.md) before exposing an installation.

### Two accounts

To use two logins, replace the single-user `AUTH_*` entries with consecutively
numbered entries. Give each account its own password:

```dotenv
AUTH_USER_1_USERNAME=alex
AUTH_USER_1_PASSWORD=replace-with-a-unique-password
AUTH_USER_1_NAME=Alex
AUTH_USER_2_USERNAME=sam
AUTH_USER_2_PASSWORD=replace-with-another-unique-password
AUTH_USER_2_NAME=Sam
```

User ownership checks apply to conversations, uploads, jobs, and private state.
The deployment operator controls the services and their stored data.

## Add capabilities when you need them

The full integration example is [`backend/tool-calling-config.yaml`](backend/tool-calling-config.yaml),
with environment settings in [`.env.template`](.env.template). It includes my
assistant preferences and home service assumptions. Use the
[adaptation guide](docs/architecture.md#where-to-change-things) to add one
integration at a time.

| Capability                               | Additional requirements                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| Image creation and analysis              | Configured image and vision providers                                         |
| Document ingestion and retrieval         | NV-Ingest, Milvus, compatible embeddings/reranking, and object storage wiring |
| Durable agent memory                     | Hindsight service and credentials                                             |
| GitHub, Google Workspace, or other tools | Corresponding MCP endpoints, credentials or OAuth, and tool policies          |
| Sandbox execution and generated files    | Compatible sandbox service, token, and artifact storage                       |
| Scheduled autonomous work                | Autonomous worker deployment, account identity, and the tools its tasks need  |
| Tracing                                  | Phoenix or another configured tracing exporter                                |

Compose supplies Redis and S3-compatible storage. It does not start the external
services in this table or the autonomous worker. The UI still shows features
whose integrations are absent; text chat is the supported scope of the local
starting configuration. Create, retrieval, memory, and Autonomy require their
own configuration before use.

## Code map

| Path                                        | Purpose                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| [`frontend/`](frontend/README.md)           | Next.js UI, API routes, stream worker, WebSocket sidecar, and PWA            |
| [`backend/`](backend/)                      | Agent workflow YAML; start with `local-chat-config.yaml`                     |
| [`builder/`](builder/)                      | Python tools, application routes, toolkit adapters, runtime image, and tests |
| [`protocol/`](protocol/README.md)           | Shared payload schemas and generated types                                   |
| [`skills/`](skills/)                        | Instructions loaded by the agent when configured                             |
| [`helm/daedalus/`](helm/daedalus/README.md) | Kubernetes deployment chart                                                  |
| [`custom-values.yaml`](custom-values.yaml)  | My home deployment overrides                                                 |
| [`Makefile`](Makefile)                      | Local counterparts to CI checks; run `make help`                             |

For development, use Node.js 22 and Python 3.12. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks by area.

## License

[Apache 2.0](LICENSE).
