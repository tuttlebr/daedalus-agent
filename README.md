<p align="left">
  <img src="frontend/public/favicon.png" alt="Daedalus" width="120">
</p>

# Daedalus

Daedalus is my self-hosted AI assistant I build and maintain for myself and my
wife. I'm Brandon Tuttle, an independent developer, and our two-person
household guides the design of this personal project. It is also used as an
educational medium for me as LLMs, agents and technology progress. This started
as a Gradio app in early 2024 and has progressed into what you see today.

It combines a Next.js chat application, a Rust agent runtime built with Rig,
Tokio, and Axum, and a Python tool service. Chat history and streaming work with
the local setup below. Image creation, retrieval, durable memory, integrations,
and scheduled work depend on the additional services you configure.

You can steer a running response by sending another direction in the composer.
The agent keeps results from tools already started and uses your direction for
the next model round. See the [request path](docs/architecture.md#request-path)
for the execution and recovery boundaries.

Forks are encouraged but this is a personal project so I'll likely nver look for
contributions. I maintain this around my own use and available
time; there is no support team, guaranteed response time, or fixed release
schedule. Use by two people does not establish suitability for a public service.

## Start here

| You want to...                                    | Read this                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Run local text chat                               | [Local setup](#local-setup)                                                                                                         |
| Find code or add one integration                  | [Architecture and adaptation](docs/architecture.md)                                                                                 |
| Operate an installation or move to Kubernetes     | [Operations](docs/operations.md), [Helm chart](helm/daedalus/README.md)                                                             |
| Develop the UI or run browser tests               | [Frontend](frontend/README.md), [Browser tests](frontend/e2e/README.md)                                                             |
| Change shared payloads or agent instructions      | [Protocol](protocol/README.md), [Skill guidelines](skills/AGENTS.md)                                                                |
| Contribute a fix                                  | [Contributing](CONTRIBUTING.md), [Repository guidelines](AGENTS.md)                                                                 |
| Understand tool execution and exact answers       | [Tool contracts](docs/tool-correctness.md)                                                                                          |
| Validate model or research changes                | [Evaluation guide](evaluation/tool-correctness/README.md), [Research and response validation](docs/research-response-validation.md) |
| Review long-running workflows and recovery limits | [Workflow review](docs/long-running-workflows.md)                                                                                   |
| Run isolated experiments with durable files       | [Sandbox exploration](docs/sandbox-exploration.md)                                                                                  |
| Understand Rust ownership and rollback            | [Runtime migration](docs/rust-migration.md)                                                                                         |
| Review the Harness2 design work                   | [Focused review](docs/harness-improvement-review.md), [Implementation and evidence](docs/harness-improvements.md)                   |
| Understand skill maintenance or image signing     | [Skills review](docs/skills-review.md), [Content Credentials](docs/content-credentials.md)                                          |

## Local setup

Prerequisites: Git, Docker with the Compose plugin and BuildKit support, Bash,
OpenSSL, curl, and a model endpoint supporting the **Responses API and tool
calling**. Have its API root, model name, and credential ready. The containers
supply Node, Python, and Rust; no host language toolchains or GPU are required
for this path. The first build includes substantial Python dependencies and can
take longer than the configuration steps.

Run all commands below from the repository root in the same Bash session.

### 1. Configure the model and session

```bash
git clone https://github.com/tuttlebr/daedalus-agent.git
cd daedalus-agent
cp .env.example .env
openssl rand -base64 32
```

Copy the generated secret into `SESSION_SECRET` in `.env`, then fill in:

| Variable                          | Value                                             |
| --------------------------------- | ------------------------------------------------- |
| `TOOL_CALLING_LLM_MODEL_BASE_URL` | Your provider's API root, usually ending in `/v1` |
| `TOOL_CALLING_LLM_MODEL_MODEL`    | A tool-capable model available there              |
| `TOOL_CALLING_LLM_MODEL_API_KEY`  | Its credential                                    |
| `AUTH_USERNAME`, `AUTH_NAME`      | Your login and display name                       |

Leave `AUTH_PASSWORD_HASH` empty until step 2. Keep `.env` private and out of Git.
Inside Docker, `localhost` refers to the container; a self-hosted model needs a
URL reachable from the backend container.

The example selects [`backend/local-chat-config.yaml`](backend/local-chat-config.yaml):
one model and a native clock tool. It configures no MCP servers, retrieval,
Hindsight memory, sandbox, autonomy, or tracing. It sends model requests to
`/responses`. If your endpoint supports Chat Completions instead, change
`llms.main.api_type` to `chat` in that YAML before starting the backend.

### 2. Build and create your login hash

```bash
docker compose build backend frontend redis
docker compose build nginx object-store
```

The second command builds the repository's proxy and object-store images; they
are also needed by a fresh installation. Use the built frontend image to hash
your password, without installing Node or npm packages on the host:

```bash
read -rsp 'Password: ' DAEDALUS_PASSWORD; printf '\n'
printf '%s' "$DAEDALUS_PASSWORD" | docker compose run --rm -T --no-deps \
  --entrypoint node frontend -e \
  'console.log(require("bcryptjs").hashSync(require("node:fs").readFileSync(0, "utf8"), 12))'
unset DAEDALUS_PASSWORD
```

Copy the hash into `AUTH_PASSWORD_HASH` in `.env`, enclosed in **single quotes**
so Compose preserves its `$` characters. The application requires bcrypt cost
12 or greater. For multiple accounts or an existing plaintext configuration,
see [login configuration](docs/operations.md#login-configuration).

### 3. Start and verify

```bash
docker compose up -d nginx frontend stream-worker backend redis object-store object-store-init
docker compose ps -a
curl -fsS http://127.0.0.1:8000/health/ready
```

The backend, Redis, object store, and stream worker should become healthy;
`redis-volume-init` and `object-store-init` should exit successfully. Readiness
checks backend dependencies, not your model credentials.

Open **http://localhost:8080**, sign in, and ask: **"Use the clock tool to tell me
the current date and time."** A completed tool-backed answer verifies the model,
tool, queue, and streaming path. Start a second conversation and reload to check
saved history.

If startup or chat fails, inspect service logs:

```bash
docker compose logs --tail=100 backend stream-worker frontend
```

For model errors, check the API root, model name, credential, and selected API
type. After changing `.env` or backend YAML, recreate the affected services:

```bash
docker compose up -d --force-recreate backend stream-worker frontend nginx
```

Stop with `docker compose down`. Redis history remains in `redis/data/` and
document objects remain in the Docker volume. Compose publishes plaintext HTTP
with development storage credentials; use a trusted development machine. See
[exposure and storage](docs/operations.md#exposure-and-storage) before making
an installation accessible to others.

## Add a capability

Start with [one integration at a time](docs/architecture.md#where-to-change-things).
The full example, [`backend/tool-calling-config.yaml`](backend/tool-calling-config.yaml)
and [`.env.template`](.env.template), is opinionated around my home services and
assistant preferences. It is a reference for adapting your working setup.

Compose supplies Redis and S3-compatible storage. The UI also exposes features
whose external services are absent; those features need their own configuration.
The [capability requirements](docs/architecture.md#capability-requirements)
identify what to add for images, retrieval, memory, tools, sandbox, autonomy,
and tracing.

## License

[Apache 2.0](LICENSE).
