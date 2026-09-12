/**
 * Wrapper around fetch that adds timeout support.
 * The deadline covers headers and response-body consumption. Callers should
 * consume or cancel response bodies to release their timer/listeners promptly.
 */

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * Fetch with configurable timeout.
 *
 * @param url - The URL to fetch
 * @param options - Standard RequestInit options plus optional timeoutMs
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns Promise<Response>
 * @throws FetchTimeoutError if request times out
 *
 * @example
 * // Basic usage
 * const response = await fetchWithTimeout('/api/data');
 *
 * // With custom timeout
 * const response = await fetchWithTimeout('/api/slow-endpoint', {}, 60000);
 *
 * // With options
 * const response = await fetchWithTimeout('/api/data', {
 *   method: 'POST',
 *   body: JSON.stringify(data),
 *   headers: { 'Content-Type': 'application/json' }
 * }, 15000);
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let bodyOwnsCleanup = false;

  let signal: AbortSignal = controller.signal;
  let cleanupCombined: (() => void) | undefined;
  if (options.signal) {
    const combined = combineAbortSignals(options.signal, controller.signal);
    signal = combined.signal;
    cleanupCombined = combined.cleanup;
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
    cleanupCombined?.();
  };

  try {
    const response = await fetch(url, { ...options, signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            reader.releaseLock();
            stream.close();
          } else {
            stream.enqueue(value);
          }
        } catch (error) {
          cleanup();
          reader.releaseLock();
          stream.error(
            controller.signal.aborted
              ? new FetchTimeoutError(url, timeoutMs)
              : error,
          );
        }
      },
      async cancel(reason) {
        cleanup();
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Preserve fetch metadata lost by constructing a response around the body.
    const preserveMetadata = (target: Response): Response => {
      for (const key of ['url', 'redirected', 'type'] as const) {
        Object.defineProperty(target, key, { value: response[key] });
      }
      Object.defineProperty(target, 'clone', {
        value: () => preserveMetadata(Response.prototype.clone.call(target)),
      });
      return target;
    };
    bodyOwnsCleanup = true;
    return preserveMetadata(wrapped);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Check if it was our timeout that caused the abort
      if (controller.signal.aborted) {
        throw new FetchTimeoutError(url, timeoutMs);
      }
    }
    throw error;
  } finally {
    // Body completion/cancellation owns cleanup once response headers arrive.
    if (!bodyOwnsCleanup) cleanup();
  }
}

/**
 * Combines two AbortSignals into one that aborts when either signal aborts.
 */
function combineAbortSignals(
  signal1: AbortSignal,
  signal2: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const abort = () => controller.abort();

  if (signal1.aborted || signal2.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }

  signal1.addEventListener('abort', abort);
  signal2.addEventListener('abort', abort);

  const cleanup = () => {
    signal1.removeEventListener('abort', abort);
    signal2.removeEventListener('abort', abort);
  };

  return { signal: controller.signal, cleanup };
}
