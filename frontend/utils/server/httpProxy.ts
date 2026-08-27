import type { NextApiResponse } from 'next';

import http from 'http';
import https from 'https';

export interface BackendResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * The backend runs under uvicorn, whose `timeout_keep_alive` defaults to 5s.
 * Node's global agent pools idle sockets indefinitely, so a request that reuses
 * a socket the server just closed fails with ECONNRESET or "socket hang up" and
 * no corresponding error on either side. Retire our sockets first.
 */
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
 * Issue a POST to the backend over raw `http`/`https` and hand the response to
 * `onResponse`. Callers either collect the bytes or pipe them onward; the
 * request construction, keep-alive policy, and timeout handling are identical
 * either way, and were previously duplicated across two modules that had
 * already drifted (one supported HTTPS, the other did not).
 */
function backendRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  onResponse: (res: http.IncomingMessage) => void,
  onTimeout: (reject: (error: Error) => void) => void,
  reject: (error: Error) => void,
): void {
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
    onResponse,
  );

  req.on('timeout', () => {
    req.destroy();
    onTimeout(reject);
  });
  req.on('error', reject);
  req.write(body);
  req.end();
}

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
    backendRequest(
      url,
      body,
      headers,
      timeoutMs,
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
      (rejectWith) =>
        rejectWith(new Error(`Backend request timed out after ${timeoutMs}ms`)),
      reject,
    );
  });
}

/** POST to the backend and pipe the response into a Next.js API response. */
export function proxyJsonToBackend(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  clientRes: NextApiResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    backendRequest(
      url,
      body,
      headers,
      timeoutMs,
      (backendRes) => {
        const statusCode = backendRes.statusCode || 500;
        const contentType = String(backendRes.headers['content-type'] || '');
        const isStream = contentType.includes('text/event-stream');

        clientRes.status(statusCode);
        if (contentType) clientRes.setHeader('Content-Type', contentType);

        if (isStream) {
          clientRes.setHeader('Cache-Control', 'no-cache, no-transform');
          clientRes.setHeader('X-Accel-Buffering', 'no');
          backendRes.on('data', (chunk: Buffer) => clientRes.write(chunk));
          backendRes.on('end', () => {
            clientRes.end();
            resolve();
          });
          backendRes.on('error', reject);
          return;
        }

        const chunks: Buffer[] = [];
        backendRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        backendRes.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          try {
            clientRes.json(JSON.parse(responseBody));
          } catch {
            clientRes.send(responseBody);
          }
          resolve();
        });
        backendRes.on('error', reject);
      },
      (rejectWith) => {
        // A partially streamed response cannot be turned into an error status.
        if (clientRes.headersSent) {
          clientRes.end();
          resolve();
          return;
        }
        rejectWith(new Error(`Backend request timed out after ${timeoutMs}ms`));
      },
      reject,
    );
  });
}
