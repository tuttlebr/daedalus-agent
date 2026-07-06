import type { NextApiResponse } from 'next';

import http from 'http';
import https from 'https';

export function proxyJsonToBackend(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  clientRes: NextApiResponse,
): Promise<void> {
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
    );
    req.on('timeout', () => {
      req.destroy();
      if (clientRes.headersSent) {
        clientRes.end();
        resolve();
        return;
      }
      reject(new Error(`Backend request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
