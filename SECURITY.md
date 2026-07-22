# Security Policy: Daedalus

## Security Architecture & Context

Daedalus is a production-oriented AI agent platform built on the NVIDIA NeMo
Agent Toolkit. It combines a Next.js web application, a FastAPI agent backend,
Redis-backed state, document retrieval, autonomous background work, external
model and tool integrations, and Docker Compose and Kubernetes deployment
surfaces.

The software operates primarily as a network-facing application and service.
Its security responsibilities include authenticating users, maintaining
per-user data boundaries, authorizing agent and MCP tool execution, protecting
credentials and uploaded content, and constraining untrusted model, document,
and web inputs.

**Repository Exposure Classification:** Public.
Basis: the origin is hosted on GitHub and GitHub reports the repository as
public; this document is written to public-safe detail.

**Service Exposure Classification:** External / Regulated (high confidence).
Basis: Daedalus is externally distributed, supports ingress and API deployment,
and handles authentication credentials, OAuth tokens, user conversations,
uploaded files, operational integrations, and deployment automation. This
classification describes service context, not vulnerability severity or a
claim that every deployment is regulated.

### Components and Trust Boundaries

| Boundary                                                  | Data and operations                                                                                                      | Principal controls                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser or API client to nginx and Next.js                | Login credentials, chat messages, file uploads, conversation state, and autonomy controls                                | Redis-backed sessions, `HttpOnly` and `SameSite=Strict` cookies, login lockout, route authentication, request limits, and security headers |
| Next.js frontend to FastAPI/NAT backend                   | Server-derived user identity, agent requests, document references, image operations, and streamed responses              | `DAEDALUS_INTERNAL_API_TOKEN`, `x-user-id`, default-deny backend middleware, and restricted nginx routing                                  |
| Backend to models, MCP, sandbox, and retrieval services   | Prompts, retrieved content, tool and sandbox arguments, OAuth flows, and remote results                                  | MCP allowlists, exact single-use approvals, authenticated sandbox capability discovery, bounded clients, and provider credentials          |
| Application to Redis, object storage, Milvus, and tracing | Sessions, password hashes, conversations, memories, OAuth tokens, uploads, collection metadata, job state, and telemetry | Per-user keys and ownership checks, TTLs, scoped credentials, optional TLS, and deployment network policy                                  |
| Autonomous worker to backend and Redis                    | Scheduled goals, queued work, approvals, execution state, and results                                                    | Dedicated execution scope, per-user queues, leases, approval-bound resume flow, and narrowly scoped workload secrets                       |
| Deployment operator to cluster and registry               | Builds, image publishing, Kubernetes Secrets, Helm releases, and service policy                                          | Workload-specific Secrets, non-root containers, network policies, image scanning, signing, and release provenance                          |

The normal public request path is ingress to nginx to the authenticated Next.js
frontend. The frontend derives the user identity from the Redis-backed session
and attaches the internal service credential before calling the backend. The
backend's `DaedalusInternalAuthMiddleware` protects execution routes by default;
health, API documentation, and the OAuth redirect are intentional exceptions.

Redis is a shared control and persistence plane. It contains session records,
password hashes, conversations, agent memory, OAuth token objects, autonomy
state, approval records, WebSocket state, and some uploaded media. Documents
are streamed to S3-compatible object storage with Redis metadata and ownership
references. Optional Milvus, ingestion, tracing, model, MCP, and isolated
sandbox services form additional trust boundaries.

### Trust Model

- Unauthenticated clients, uploaded files, scraped pages, model output, and
  remote tool output are untrusted.
- Authenticated users are not implicitly trusted to access another user's
  conversations, uploads, jobs, memories, OAuth state, or private collections.
- The deployment operator and changes to workflow, Helm, secret, ingress,
  network-policy, and MCP authorization configuration are trusted
  administrative actions.
- The username selected by `ADMIN_USERNAME` is trusted with user-management and
  cross-user administrative capabilities exposed by the frontend.
- External model, MCP, search, retrieval, image, sandbox, and observability
  providers receive the content necessary for their configured operations and
  are separate data processors and security boundaries.
- Shared Milvus collections are separated from private collections by
  application policy and naming rules, not by separate database instances.

### Threat Model

The following scenarios are the primary security concerns for this project,
ordered by expected impact and likelihood.

1. **Prompt Injection Causing Unauthorized Tool Execution:** Chat messages,
   uploaded documents, retrieved passages, and scraped web content can influence
   the agent in `backend/tool-calling-config.yaml`. A prompt injection could try
   to invoke an MCP operation, alter memory, execute a sandbox command, or
   redirect autonomous work. `builder/mcp_patches.py`, the
   `tool_overrides.approval_policy` declarations, and `builder/user_interaction`
   bind consequential operations to exact, single-use approvals. The
   `llm_sandbox` client separately authenticates command discovery, bounds
   command size and time, restricts environment-loader variables, and treats
   output as untrusted. Incorrect tool policy or weakened adapters could cross
   these boundaries.

2. **Identity Forgery or Cross-User Resource Access:** Frontend API routes,
   `frontend/ws-server.ts`, document references, Redis key construction, and
   Milvus collection resolution enforce user ownership. The backend accepts
   `x-user-id` only with the shared internal token. Exposing the backend
   directly, enabling `ALLOW_INSECURE_INTERNAL` outside loopback development,
   leaking the internal token, or introducing an ownership-check regression
   could allow one user to access or modify another user's state.

3. **Sensitive Data Disclosure Through Persistence, Telemetry, or Diagnostics:**
   Redis and object storage may contain conversations, uploaded media,
   documents, memories, sessions, approval state, and OAuth credentials.
   Phoenix traces and downloadable conversation traces may include prompts,
   tool inputs, retrieved content, and model output. `builder/entrypoint.py`
   removes request headers and cookies from telemetry metadata, but application
   content can still be sensitive. Over-broad datastore, trace, backup, or log
   access could disclose that content.

4. **SSRF or Data Exfiltration Through Outbound Integrations:** The web-scraping
   path uses `nat_helpers.url_guard`, pinned public-address transports, and
   per-redirect validation. The OAuth callback also restricts its backend
   target. Other model, MCP, retrieval, image, and operator-configured endpoints
   remain trusted destinations. A compromised configuration, overly broad
   egress policy, or tool misuse could send sensitive content to an unintended
   service or reach an unauthorized network target.

5. **Malicious Upload or Resource Exhaustion:** The image, video, transcript,
   and document endpoints accept complex, potentially large inputs.
   `frontend/pages/api/session/documentStorage.ts`,
   `frontend/server/multipartDocument.ts`, media decoders, document extraction,
   object storage, and ingestion services process those inputs. Size caps,
   magic-byte checks, per-user concurrency limits, rate limits, timeouts, and
   TTLs reduce exposure, but malformed files or parser vulnerabilities could
   still consume CPU, memory, storage, or worker capacity.

6. **Script Execution Through Model-Generated Content:** Assistant content is
   rendered through React Markdown, optional raw HTML processing, Mermaid, and
   generated media components. `rehype-sanitize`, the custom sanitization
   schema, Mermaid's strict mode, and response security headers constrain this
   surface. A sanitizer regression, unsafe schema expansion, rendering-library
   vulnerability, or unsafe handling of generated SVG could enable script
   execution in an authenticated browser session.

7. **Deployment or Software Supply-Chain Compromise:** `deploy.sh`, Helm
   templates, CI workflows, container builds, secret synchronization scripts,
   and registry artifacts can change live workloads or handle privileged
   credentials. The project uses dependency locks, secret scanning, static
   analysis, container and filesystem scanning, signed images, and release
   provenance. A compromised dependency, CI identity, registry artifact,
   deployment workstation, or unverified development build could still alter
   application behavior or expose deployment credentials.

### Critical Security Assumptions

- Production traffic terminates TLS at an ingress, reverse proxy, or equivalent
  trusted layer. Internal plaintext HTTP is used only inside a network boundary
  whose access is constrained by service routing and network policy.
- Production deployments keep nginx restricted mode enabled, configure a strong
  `DAEDALUS_INTERNAL_API_TOKEN`, and leave `ALLOW_INSECURE_INTERNAL` disabled.
  The tokenless Docker Compose mode is assumed to remain local with its backend
  port bound to loopback.
- Redis, object storage, Milvus, telemetry, and backups are reachable only by
  authorized workloads and administrators. Operators enable transport
  encryption where traffic crosses an untrusted network.
- Redis ACLs, object-storage credentials, model keys, MCP tokens, OAuth client
  credentials, and Kubernetes Secrets are unique, least-privileged, rotated,
  and never committed to the repository.
- Bucket lifecycle policy enforces document retention. Application TTL metadata
  alone is not assumed to delete orphaned object bytes.
- Operators review changes to MCP `include` lists, `approval_policy`
  declarations, autonomous action policy, and external endpoint configuration
  as security-sensitive code changes.
- External model, MCP, retrieval, image, and observability services protect the
  data and credentials sent to them and return untrusted content that must not
  bypass application authorization.
- The sandbox service accurately enforces its reported stateless Bubblewrap
  isolation and command allowlist. The backend rejects execution when readiness
  or capability discovery is inconsistent with that contract.
- The host OS, container runtime, Kubernetes control plane, DNS, network-policy
  implementation, registry, and secret-management system provide their expected
  isolation and integrity guarantees.
- Dependencies that parse images, video, documents, HTML, Markdown, SVG, YAML,
  and network protocols are kept current and are rebuilt when security fixes
  become available.
- Shared Milvus collection names and the configured shared-collection allowlist
  are trusted policy inputs. They do not provide the same isolation as separate
  databases or credentials.

## Deployment Security Requirements

For production deployments:

- Terminate TLS before application traffic and preserve the trusted
  `X-Forwarded-*` header chain.
- Keep direct backend routing disabled unless an authenticated gateway supplies
  the required internal token and server-derived user identity.
- Enable Redis ACL authentication and TLS when Redis traffic is not confined to
  a trusted local network.
- Use separate frontend, backend, stream-worker, object-storage, and autonomous
  worker Secrets as modeled by the Helm chart.
- Apply the Kubernetes NetworkPolicies and consider the optional FQDN-based
  egress policy when unrestricted web access is unnecessary.
- Give document-storage credentials access only to the configured bucket and
  prefix, with `GetObject`, `PutObject`, and `DeleteObject` permissions.
- Restrict Phoenix and exported conversation traces to users and operators
  authorized to view prompt, tool, and response content.
- Review and test MCP tool authorization whenever a remote server changes its
  advertised tool surface.
- Restrict sandbox egress to the configured service namespace and port, rotate
  its bearer credential, and review changes to its command allowlist as
  security-sensitive policy changes.
- Keep CI token permissions read-only by default. Grant package, attestation,
  or OIDC permissions only to the release or main-branch attestation jobs that
  need them; pull-request build jobs must not receive those credentials.
- Gate locked production dependencies with an ecosystem-native audit in
  addition to repository and image scanning, and fail on actionable findings.
- Prefer signed release artifacts and verify their source commit, image digest,
  signature, scan state, and provenance before deployment.

## Security Scope

Security reports are in scope when they demonstrate an impact to Daedalus's
confidentiality, integrity, availability, authentication, authorization,
tenant separation, tool-execution policy, secret handling, or deployment
security.

Examples include:

- Authentication or session bypass
- Cross-user conversation, upload, memory, job, OAuth, or collection access
- Unauthorized or replayed consequential tool execution
- Prompt injection that crosses an application authorization boundary
- SSRF that bypasses the public-address or configured-service boundary
- Stored or reflected script execution in the authenticated frontend
- Credential disclosure through logs, traces, APIs, deployment output, or
  release artifacts
- Malicious input causing a practical service-level denial of service

The following are generally outside the application's security boundary unless
an integration defect in Daedalus creates or amplifies the issue:

- Model accuracy, hallucination, or unsafe prose without a demonstrated
  confidentiality, integrity, availability, or authorization impact
- Vulnerabilities solely in a third-party managed service
- A fully compromised host, cluster administrator, deployment workstation, or
  source-control administrator
- Intentional exposure of the tokenless local-development configuration to an
  untrusted network
