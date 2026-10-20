"""Transparent evaluation-only streaming proxy recording model identity and usage."""

import json
from http.server import BaseHTTPRequestHandler

import httpx


class EventLines:
    """Frame SSE on LF/CRLF without splitting Unicode inside JSON strings."""

    def __init__(self):
        self.pending = b""

    def feed(self, chunk):
        lines = (self.pending + chunk).split(b"\n")
        self.pending = lines.pop()
        return [line.removesuffix(b"\r").decode("utf-8") for line in lines]


def response_lines(response):
    lines = EventLines()
    for chunk in response.iter_bytes():
        yield from lines.feed(chunk)
    if lines.pending:
        yield from lines.feed(b"\n")


async def async_response_lines(response):
    lines = EventLines()
    async for chunk in response.aiter_bytes():
        for line in lines.feed(chunk):
            yield line
    if lines.pending:
        for line in lines.feed(b"\n"):
            yield line


def handler(base_url, records, targets):
    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            row = {
                "selected_target": None,
                "configured_provider_model": None,
                "configured_effort": None,
                "provider_reported_model": None,
                "usage": None,
            }
            records.append(row)
            try:
                length = int(self.headers["Content-Length"])
                if not 0 < length <= 8 * 1024 * 1024:
                    self.send_error(413)
                    return
                body = self.rfile.read(length)
                endpoint = base_url.rstrip("/") + "/" + self.path.rsplit("/", 1)[-1]
                with httpx.Client(timeout=65, trust_env=False) as client:
                    with client.stream(
                        "POST",
                        endpoint,
                        content=body,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": self.headers.get("Authorization", ""),
                        },
                    ) as response:
                        row["http_status"] = response.status_code
                        selected = response.headers.get("x-model-router-selected-model")
                        row["selected_target"] = selected
                        row.update(targets.get(selected, {}))
                        self.send_response(response.status_code)
                        self.send_header(
                            "Content-Type",
                            response.headers.get("Content-Type", "application/json"),
                        )
                        self.send_header("Connection", "close")
                        self.end_headers()
                        pending = b""
                        for chunk in response.iter_bytes():
                            self.wfile.write(chunk)
                            self.wfile.flush()
                            pending += chunk
                            while b"\n" in pending:
                                line, pending = pending.split(b"\n", 1)
                                if (
                                    not line.startswith(b"data:")
                                    or line[5:].strip() == b"[DONE]"
                                ):
                                    continue
                                event = json.loads(line[5:])
                                completed = event.get("response", event)
                                if completed.get("model"):
                                    row["provider_reported_model"] = completed["model"]
                                if isinstance(completed.get("usage"), dict):
                                    row["usage"] = {
                                        k: v
                                        for k, v in completed["usage"].items()
                                        if k
                                        in (
                                            "input_tokens",
                                            "output_tokens",
                                            "total_tokens",
                                            "prompt_tokens",
                                            "completion_tokens",
                                        )
                                        and type(v) is int
                                    }
                            if len(pending) > 8 * 1024 * 1024:
                                raise ValueError("SSE event limit")
            except Exception as error:
                row["error_class"] = type(error).__name__
            finally:
                self.close_connection = True

    return Gateway
