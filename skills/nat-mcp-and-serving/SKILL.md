---
name: nat-mcp-and-serving
description: >-
  Use when serving or deploying NeMo Agent Toolkit workflows as an API and
  when integrating Model Context Protocol (MCP). Covers nat serve and nat
  start, the FastAPI front_end, custom HTTP and REST endpoints, streaming
  responses, and configuring MCP clients (mcp_client) and MCP servers over sse
  or streamable-http transports, plus transport and server-setup
  troubleshooting. Use nat-workflow-creation for the workflow logic itself,
  and nat-tools-and-functions to implement the tools the workflow calls.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit MCP and Serving

Use this skill when a workflow needs to call remote MCP tools or be served as an API.

## Workflow

1. Read the reference for the protocol or server target.
2. Keep serving configuration separate from workflow logic where possible.
3. Validate locally with a small request before adding deployment details.
4. Prefer documented `nat serve` and `nat start` commands over ad hoc servers.

## References

- `references/mcp.md`
- `references/fastapi-frontend.md`
