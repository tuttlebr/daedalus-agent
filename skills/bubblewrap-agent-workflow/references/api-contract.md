# API contract and adapter pattern

## Calls

`GET /healthz` is unauthenticated liveness. `GET /readyz` is readiness. Capability discovery requires `Authorization: Bearer $SANDBOX_TOKEN`:

```sh
curl -fsS "$SANDBOX_URL/readyz"
curl -fsS "$SANDBOX_URL/v1/commands" -H "Authorization: Bearer $SANDBOX_TOKEN"
```

Execute with JSON:

```json
{
  "command": "printf '%s\n' hello",
  "timeoutSeconds": 10,
  "workingDirectory": "."
}
```

For a multi-step file task, use a trusted, opaque conversation scope and
structured file staging:

```json
{
  "workspaceId": "sha256-of-trusted-user-and-conversation",
  "argv": ["true"],
  "files": [
    {
      "path": "guide.html",
      "content": "<!doctype html>",
      "append": false
    }
  ],
  "collect": ["guide.html"]
}
```

The response includes `requestId`, `exitCode`, `stdout`, `stderr`,
`durationMs`, `timedOut`, `truncated`, `workspacePersisted`, `files`, and
`missingFiles`. HTTP 4xx means the request or command policy was rejected; HTTP
5xx is service/transport failure.

## Adapter pseudocode

```python
async def sandbox_tool(command, timeout=20, trusted_workspace_id=None):
    if not discovered:
        await discover_commands()
    payload = {"command": command, "timeoutSeconds": min(timeout, 60)}
    if trusted_workspace_id:
        payload["workspaceId"] = trusted_workspace_id
    result = await http.post(
        f"{url}/v1/execute",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=timeout + 5,
    )
    if result.status in (502, 503, 504):
        return retry_once_with_backoff()
    if result.status >= 400:
        return ToolError("sandbox policy or request rejected", result.json())
    body = result.json()
    return ToolResult(
        text=body["stdout"],
        metadata={"stderr": body["stderr"], "exitCode": body["exitCode"],
                  "requestId": body["requestId"], "timedOut": body["timedOut"],
                  "truncated": body["truncated"]},
    )
```

Do not expose the token or raw identity through tool metadata. Requests without
`workspaceId` are deleted immediately. For a multi-stage task, derive
`workspaceId` from trusted user and conversation context, reuse it across
calls, and use `files`/`collect` instead of shell here-documents. Treat the
workspace as temporary: it expires after an idle TTL and disappears when its
pod is replaced.
