/**
 * Wrapper around fetch that adds timeout support.
 * Prevents fetch operations from hanging indefinitely.
 */

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
}

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
  timeoutMs = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal
        ? combineAbortSignals(options.signal, controller.signal)
        : controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Check if it was our timeout that caused the abort
      if (controller.signal.aborted) {
        throw new FetchTimeoutError(url, timeoutMs);
      }
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Combines two AbortSignals into one that aborts when either signal aborts.
 */
function combineAbortSignals(
  signal1: AbortSignal,
  signal2: AbortSignal
): AbortSignal {
  const controller = new AbortController();

  const abort = () => controller.abort();

  if (signal1.aborted || signal2.aborted) {
    controller.abort();
    return controller.signal;
  }

  signal1.addEventListener('abort', abort);
  signal2.addEventListener('abort', abort);

  return controller.signal;
}

/**
 * Wraps a Promise with a timeout.
 * Useful for any async operation, not just fetch.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param timeoutError - Optional custom error to throw on timeout
 * @returns Promise that rejects if timeout is reached
 *
 * @example
 * const result = await withTimeout(
 *   someAsyncOperation(),
 *   5000,
 *   new Error('Operation timed out')
 * );
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error = new Error(`Operation timed out after ${timeoutMs}ms`)
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(timeoutError), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}
