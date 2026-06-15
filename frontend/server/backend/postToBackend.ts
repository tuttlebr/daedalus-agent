import http from 'http';

export interface BackendResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * POST a body to a backend URL over raw `http` and resolve with the full
 * response (status, headers, and raw bytes).
 *
 * Lives under `server/` (not `pages/api`) so it can be shared by multiple API
 * routes per the route-inventory rule. Returning a `Buffer` plus the upstream
 * headers lets callers either decode text (`body.toString('utf-8')`) or forward
 * bytes and headers (e.g. a `Content-Disposition` file download) losslessly.
 */
export function postToBackend(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<BackendResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || '80',
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
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
