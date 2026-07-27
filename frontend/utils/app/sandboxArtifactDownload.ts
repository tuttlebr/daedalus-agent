const SANDBOX_ARTIFACT_PATH = '/api/session/documentStorage';
const RETRYABLE_DOWNLOAD_STATUSES = new Set([
  404, 409, 425, 429, 500, 502, 503, 504,
]);

const SANDBOX_ARTIFACT_RETRY_DELAYS_MS = [400, 800, 1_500, 2_500, 4_000, 5_000];

export function isSandboxArtifactDownloadUrl(href: string): boolean {
  try {
    const url = new URL(href, 'https://daedalus.invalid');
    const sessionId = url.searchParams.get('sessionId');
    return (
      url.origin === 'https://daedalus.invalid' &&
      url.pathname === SANDBOX_ARTIFACT_PATH &&
      !url.hash &&
      url.searchParams.size === 2 &&
      Boolean(url.searchParams.get('documentId')) &&
      Boolean(sessionId?.startsWith('sandbox-'))
    );
  } catch {
    return false;
  }
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Download cancelled', 'AbortError'));
      return;
    }

    const timeout = window.setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException('Download cancelled', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.clone().json();
    if (body && typeof body.error === 'string' && body.error.trim()) {
      return new Error(body.error);
    }
  } catch {
    // Fall back to the status below for non-JSON error responses.
  }
  return new Error(`Download failed (HTTP ${response.status})`);
}

export async function fetchSandboxArtifact(
  href: string,
  options: {
    signal?: AbortSignal;
    retryDelaysMs?: number[];
    wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<Response> {
  const retryDelays = options.retryDelaysMs || SANDBOX_ARTIFACT_RETRY_DELAYS_MS;
  const wait = options.wait || waitForRetry;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(href, {
        cache: 'no-store',
        credentials: 'include',
        signal: options.signal,
      });
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof DOMException && error.name === 'AbortError') ||
        attempt >= retryDelays.length
      ) {
        throw error;
      }
      await wait(retryDelays[attempt], options.signal);
      continue;
    }
    if (response.ok) return response;

    if (
      !RETRYABLE_DOWNLOAD_STATUSES.has(response.status) ||
      attempt >= retryDelays.length
    ) {
      throw await responseError(response);
    }

    await wait(retryDelays[attempt], options.signal);
  }
}

function safeFilename(value: string): string {
  const filename = value
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .trim()
    .slice(0, 200);
  return filename || 'sandbox-artifact';
}

export function downloadFilename(contentDisposition: string | null): string {
  if (!contentDisposition) return 'sandbox-artifact';

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(
    contentDisposition,
  )?.[1];
  if (encoded) {
    try {
      return safeFilename(decodeURIComponent(encoded));
    } catch {
      // Try the ASCII filename fallback below.
    }
  }

  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(contentDisposition)?.[1];
  if (quoted) return safeFilename(quoted);

  const plain = /filename\s*=\s*([^;]+)/i.exec(contentDisposition)?.[1];
  return safeFilename(plain || '');
}

export function saveArtifactBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
