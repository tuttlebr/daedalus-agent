import { proxyJsonToBackend } from '@/utils/server/httpProxy';

import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.length = 0;
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve(address.port);
    });
  });
}

function mockResponse() {
  const chunks: Buffer[] = [];
  const res = {
    headersSent: false,
    status: vi.fn(() => res),
    setHeader: vi.fn(),
    write: vi.fn((chunk: Buffer) => {
      res.headersSent = true;
      chunks.push(Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(() => {
      res.headersSent = true;
      return res;
    }),
    json: vi.fn(() => res),
    send: vi.fn(() => res),
    chunks,
  };
  return res;
}

describe('proxyJsonToBackend', () => {
  it('pipes text/event-stream chunks without buffering', async () => {
    const server = http.createServer((req, res) => {
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: partial\ndata: {"type":"partial"}\n\n');
        res.end('data: [DONE]\n\n');
      });
      req.resume();
    });
    const port = await listen(server);
    const res = mockResponse();

    await proxyJsonToBackend(
      `http://127.0.0.1:${port}/images`,
      '{}',
      { 'Content-Type': 'application/json' },
      1000,
      res as any,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream',
    );
    expect(Buffer.concat(res.chunks).toString('utf-8')).toContain(
      'event: partial',
    );
    expect(res.end).toHaveBeenCalled();
  });
});
