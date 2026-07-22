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

The response includes `requestId`, `exitCode`, `stdout`, `stderr`, `durationMs`, `timedOut`, and `truncated`. HTTP 4xx means the request or command policy was rejected; HTTP 5xx is service/transport failure.

## Adapter pseudocode

```python
async def sandbox_tool(command, timeout=20):
    if not discovered:
        await discover_commands()
    result = await http.post(
        f"{url}/v1/execute",
        headers={"Authorization": f"Bearer {token}"},
        json={"command": command, "timeoutSeconds": min(timeout, 60)},
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

Do not expose the token through tool metadata. If a command needs multiple stages, issue separate requests and pass only the intended artifact or text between stages.
