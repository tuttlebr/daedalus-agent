"""
Enhanced OpenAI SDK logging for diagnosing LLM connection errors.

Patches the OpenAI Python SDK so that retry and connection-error log messages
include the base_url, HTTP status code, and retry attempt of the client that
triggered them. Without this, the default messages only show the path
(/chat/completions) with no indication of which upstream provider is failing
or why.

Usage: import this module before any OpenAI clients are created.
"""

import functools
import inspect
import logging

logger = logging.getLogger("daedalus.llm_diagnostics")

# Registry: maps id(client._client) -> diagnostic label
_client_registry: dict[int, str] = {}


class _OpenAIRetryFilter(logging.Filter):
    """Enriches openai._base_client log records with diagnostic context.

    When the OpenAI SDK logs a retry or connection error, it only includes
    the request path and backoff delay. This filter walks the call stack to
    extract and append:
      - base_url of the client (which upstream provider)
      - HTTP status code from the failed response (if available)
      - retry-after header (if present, e.g. rate limiting)
      - retry attempt number and max retries
    """

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "Retrying request" not in msg and "Connection error" not in msg:
            return True

        extras: list[str] = []
        found_base_url = False

        try:
            for frame_info in inspect.stack():
                local_vars = frame_info.frame.f_locals

                # Find client's base_url
                if not found_base_url:
                    local_self = local_vars.get("self")
                    if local_self is not None and hasattr(local_self, "_base_url"):
                        base_url = str(local_self._base_url).rstrip("/")
                        extras.append(f"base_url={base_url}")
                        found_base_url = True

                # Find HTTP status code from the response that triggered the retry
                response = local_vars.get("response")
                if response is not None and hasattr(response, "status_code"):
                    status = response.status_code
                    extras.append(f"status={status}")
                    # Extract rate-limit / retry-after headers
                    headers = getattr(response, "headers", None)
                    if headers:
                        retry_after = headers.get("retry-after")
                        if retry_after:
                            extras.append(f"retry-after={retry_after}")
                        # OpenRouter / OpenAI rate limit headers
                        remaining = headers.get("x-ratelimit-remaining-requests")
                        if remaining is not None:
                            extras.append(f"ratelimit-remaining={remaining}")

                # Find retry attempt count
                retries_taken = local_vars.get("retries_taken")
                if retries_taken is not None and isinstance(retries_taken, int):
                    max_retries = local_vars.get("max_retries")
                    if max_retries is not None:
                        extras.append(f"attempt={retries_taken + 1}/{max_retries}")
                    else:
                        extras.append(f"attempt={retries_taken + 1}")

        except Exception:  # nosec B110 — intentional; diagnostic extras are non-critical
            pass

        if extras:
            # Deduplicate while preserving order
            seen: set[str] = set()
            unique: list[str] = []
            for e in extras:
                if e not in seen:
                    seen.add(e)
                    unique.append(e)
            record.msg = f"{record.msg} [{', '.join(unique)}]"

        return True


def _wrap_init(original_init, client_kind: str):
    """Wrap OpenAI client __init__ to log base_url and model at creation time."""

    @functools.wraps(original_init)
    def wrapper(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        base_url = str(getattr(self, "_base_url", kwargs.get("base_url", "?")))
        label = f"{client_kind} base_url={base_url}"
        logger.info("Initialized OpenAI client: %s", label)

        # Register the internal httpx client for lookup
        inner = getattr(self, "_client", None)
        if inner is not None:
            _client_registry[id(inner)] = label

    return wrapper


def patch():
    """Apply all OpenAI SDK logging patches. Safe to call multiple times."""
    try:
        import openai

        openai.AsyncOpenAI.__init__ = _wrap_init(
            openai.AsyncOpenAI.__init__, "AsyncOpenAI"
        )
        openai.OpenAI.__init__ = _wrap_init(openai.OpenAI.__init__, "OpenAI")
    except Exception as exc:
        logger.warning("Could not patch OpenAI client __init__: %s", exc)

    retry_filter = _OpenAIRetryFilter()

    # IMPORTANT: Python logging filters do NOT propagate to child loggers.
    # The retry messages come from "openai._base_client", so the filter must
    # be registered there explicitly — not just on the "openai" parent logger.
    for logger_name in ("openai", "openai._base_client", "httpx"):
        logging.getLogger(logger_name).addFilter(retry_filter)

    logger.info("LLM diagnostics patches applied")
