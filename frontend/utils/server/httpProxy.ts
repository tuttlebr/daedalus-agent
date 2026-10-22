import http from 'http';
import https from 'https';

export interface BackendResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// Bound idle socket reuse; each request supplies its own inactivity timeout.
const KEEP_ALIVE_TIMEOUT_MS = 4_000;

const httpAgent = new http.Agent({
  keepAlive: true,
  timeout: KEEP_ALIVE_TIMEOUT_MS,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: KEEP_ALIVE_TIMEOUT_MS,
});

/**
 * POST to a backend URL and resolve with the full response (status, headers,
 * and raw bytes). Returning a `Buffer` plus the upstream headers lets callers
 * decode text or forward bytes and headers (for example a `Content-Disposition`
 * file download) losslessly.
 */
export function postToBackend(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<BackendResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? '443' : '80'),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Backend request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
