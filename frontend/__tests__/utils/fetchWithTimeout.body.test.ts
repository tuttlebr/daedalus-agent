// @vitest-environment node
import { fetchWithTimeout, FetchTimeoutError } from '@/utils/fetchWithTimeout';

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function stalledBody(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    res.write('{');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${
    typeof address === 'object' && address ? address.port : 0
  }`;
}

describe('fetch body lifetime', () => {
  it('preserves response metadata and clone/body behavior on success', async () => {
    server = createServer((_req, res) => {
      res.setHeader('x-fixture', 'present');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const url = `http://127.0.0.1:${
      (server.address() as { port: number }).port
    }/fixture`;
    const response = await fetchWithTimeout(url, {}, 500);
    const cloned = response.clone();
    expect(cloned.url).toBe(url);
    expect(response.url).toBe(url);
    expect(response.headers.get('x-fixture')).toBe('present');
    expect(await response.json()).toEqual({ ok: true });
    expect(await cloned.json()).toEqual({ ok: true });
    expect(response.bodyUsed).toBe(true);
  });

  it('cleans up the caller listener when a body is explicitly canceled', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const response = await fetchWithTimeout(
      await stalledBody(),
      { signal: controller.signal },
      1000,
    );
    await response.body!.cancel();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('enforces the deadline after headers arrive', async () => {
    const response = await fetchWithTimeout(await stalledBody(), {}, 80);
    const result = await Promise.race([
      response.text().then(
        () => 'completed',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 400)),
    ]);
    expect(result).toBeInstanceOf(FetchTimeoutError);
  });

  it('propagates caller cancellation after headers arrive', async () => {
    const controller = new AbortController();
    const response = await fetchWithTimeout(
      await stalledBody(),
      { signal: controller.signal },
      1000,
    );
    const reading = response.text().catch((error: unknown) => error);
    controller.abort();
    const result = await Promise.race([
      reading,
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 300)),
    ]);
    expect(result).toMatchObject({ name: 'AbortError' });
  });
});
