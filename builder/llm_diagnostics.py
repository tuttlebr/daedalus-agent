"""
Enhanced OpenAI SDK logging and resilience for diagnosing LLM connection errors.

Patches the OpenAI Python SDK so that retry and connection-error log messages
include the base_url, HTTP status code, and retry attempt of the client that
triggered them. Without this, the default messages only show the path
(/chat/completions) with no indication of which upstream provider is failing
or why.

Also enforces timeout and max_retries on every OpenAI client at creation time,
working around a NAT/LangChain issue where ChatOpenAI passes timeout=None to
the SDK (see https://github.com/NVIDIA/NeMo-Agent-Toolkit/issues/1617).

Usage: import this module before any OpenAI clients are created.
"""

import functools
import inspect
import logging
import os

import httpx

logger = logging.getLogger("daedalus.llm_diagnostics")

# Defaults (override via environment variables)
_DEFAULT_MAX_RETRIES = 3
_DEFAULT_TIMEOUT_SECONDS = 120.0
_CONNECT_TIMEOUT = 10.0
_WRITE_TIMEOUT = 30.0
_POOL_TIMEOUT = 10.0

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
    """Wrap OpenAI client __init__ to log base_url, enforce timeout and max_retries.

    NAT/LangChain's ChatOpenAI passes timeout=None to the OpenAI SDK, which
    disables the httpx timeout entirely. This wrapper re-applies a sensible
    timeout and caps max_retries after the client is constructed, regardless
    of what the caller passed.
    """

    max_retries = int(os.environ.get("DAEDALUS_LLM_MAX_RETRIES", _DEFAULT_MAX_RETRIES))
    timeout_seconds = float(
        os.environ.get("DAEDALUS_LLM_TIMEOUT", _DEFAULT_TIMEOUT_SECONDS)
    )

    @functools.wraps(original_init)
    def wrapper(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        base_url = str(getattr(self, "_base_url", kwargs.get("base_url", "?")))
        label = f"{client_kind} base_url={base_url}"

        # --- Enforce max_retries ---
        if hasattr(self, "_max_retries"):
            old = self._max_retries
            if old != max_retries:
                self._max_retries = max_retries
                logger.info("Patched %s max_retries: %s -> %s", label, old, max_retries)

        # --- Enforce split timeout on the inner httpx client ---
        # Short connect/pool timeouts to fail fast on unreachable servers;
        # long read timeout for slow inference responses (e.g. 504 retries).
        inner = getattr(self, "_client", None)
        if inner is not None:
            _client_registry[id(inner)] = label
            http_client = getattr(inner, "_client", None)
            if http_client is not None and isinstance(
                http_client, (httpx.Client, httpx.AsyncClient)
            ):
                desired = httpx.Timeout(
                    connect=_CONNECT_TIMEOUT,
                    read=timeout_seconds,
                    write=_WRITE_TIMEOUT,
                    pool=_POOL_TIMEOUT,
                )
                if http_client.timeout != desired:
                    old_timeout = http_client.timeout
                    http_client.timeout = desired
                    logger.info(
                        "Patched %s timeout: %s -> %s",
                        label,
                        old_timeout,
                        desired,
                    )

        logger.info("Initialized OpenAI client: %s", label)

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
