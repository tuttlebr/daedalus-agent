// @vitest-environment node
import { ensureS3Bucket, waitForS3 } from '../../e2e/ensure-s3-bucket.mjs';
import { waitForHttp } from '../../e2e/wait-for-http.mjs';

import { type RequestListener, type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const servers: Server[] = [];

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('S3 fixture setup', () => {
  it.each([false, true])(
    'bounds a stalled bucket request even when headers were sent: %s',
    async (sendHeaders) => {
      const endpoint = await serve((_request, response) => {
        if (sendHeaders) {
          response.writeHead(200);
          response.flushHeaders();
        }
      });
      await expect(ensureS3Bucket({ endpoint, timeoutMs: 50 })).rejects.toThrow(
        'timed out',
      );
    },
  );
});

describe.each([
  ['HTTP', waitForHttp],
  ['S3', waitForS3],
] as const)('%s fixture readiness', (_name, waitForReady) => {
  it('retries unhealthy responses until the service becomes ready', async () => {
    let attempts = 0;
    const url = await serve((_request, response) => {
      response.writeHead(++attempts === 1 ? 503 : 200).end();
    });
    await expect(waitForReady(url, 2000)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('rejects persistent HTTP 500 responses by the deadline', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(500).end();
    });
    await expect(waitForReady(url, 50)).rejects.toThrow('did not become ready');
  });

  it('rejects an accepted connection that never returns headers', async () => {
    const url = await serve(() => {});
    await expect(waitForReady(url, 50)).rejects.toThrow('did not become ready');
  });

  it('uses the status without waiting indefinitely for a response body', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
    });
    await expect(waitForReady(url, 500)).resolves.toBeUndefined();
  });
});
