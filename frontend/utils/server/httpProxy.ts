import http from 'http';
import https from 'https';

export interface ProxyResponse {
  statusCode: number;
  body: string;
}

export function postJsonToBackend(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<ProxyResponse> {
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
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
            body: Buffer.concat(chunks).toString('utf-8'),
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
