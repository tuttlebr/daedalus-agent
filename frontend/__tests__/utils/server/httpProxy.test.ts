// @vitest-environment node
import { postToBackend } from '@/utils/server/httpProxy';

import { once } from 'node:events';
import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('postToBackend', () => {
  it('forwards the POST and preserves upstream status, headers and binary bytes', async () => {
    const responseBytes = Buffer.from([0, 0xff, 0xc3, 0x28]);
    const body = JSON.stringify({ text: 'café' });
    let received: unknown;
    const baseUrl = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          method: req.method,
          path: req.url,
          token: req.headers['x-daedalus-internal-token'],
          contentType: req.headers['content-type'],
          length: req.headers['content-length'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(422, {
          'Content-Disposition': 'attachment; filename="result.bin"',
        });
        res.write(responseBytes.subarray(0, 2));
        res.end(responseBytes.subarray(2));
      });
    });

    const response = await postToBackend(
      `${baseUrl}/extract?format=raw`,
      body,
      {
        'Content-Type': 'application/json',
        'x-daedalus-internal-token': 'synthetic-test-token',
      },
      1000,
    );

    expect(received).toEqual({
      method: 'POST',
      path: '/extract?format=raw',
      token: 'synthetic-test-token',
      contentType: 'application/json',
      length: String(Buffer.byteLength(body)),
      body,
    });
    expect(response.statusCode).toBe(422);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="result.bin"',
    );
    expect(response.body).toEqual(responseBytes);
  });

  it.each([false, true])(
    'rejects an inactive request (headers sent: %s)',
    async (sendHeaders) => {
      const baseUrl = await listen((req, res) => {
        req.resume();
        if (sendHeaders) {
          res.writeHead(200);
          res.write('partial');
        }
      });
      await expect(postToBackend(baseUrl, '{}', {}, 50)).rejects.toThrow(
        'Backend request timed out after 50ms',
      );
    },
  );

  it('rejects an upstream disconnect before response headers', async () => {
    const baseUrl = await listen((req) => req.socket.destroy());
    await expect(postToBackend(baseUrl, '{}', {}, 1000)).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  });

  it('rejects a truncated response instead of returning partial bytes', async () => {
    const baseUrl = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Length': '100' });
      res.on('finish', () => req.socket.end());
      res.end('partial');
    });
    await expect(postToBackend(baseUrl, '{}', {}, 1000)).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  });

  it('rejects an invalid URL through the returned promise', async () => {
    await expect(postToBackend('not a URL', '{}', {}, 1000)).rejects.toThrow();
  });
});
