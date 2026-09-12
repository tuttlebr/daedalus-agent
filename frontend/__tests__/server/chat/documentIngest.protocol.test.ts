// @vitest-environment node
import { startBackgroundDocumentIngest } from '@/server/chat/documentIngest';
import type { AsyncJobRequest } from '@/server/chat/types';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/server/chat/finalization', () => ({
  finalizeSuccess: mocks.success,
  finalizeError: mocks.error,
}));
vi.mock('@/server/chat/jobState', () => ({
  updateJobStatus: vi.fn(),
  clearOAuthStatusFields: () => ({}),
}));
vi.mock('@/server/chat/natMessages', () => ({
  buildNatRequestHeaders: () => ({}),
}));
let server: Server | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function ingest(data: string, signal?: AbortSignal, remainOpen = false) {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Split across CRLF boundaries to exercise buffering, not a mock reader.
    res.write(data.slice(0, 13));
    if (remainOpen) res.write(data.slice(13));
    else res.end(data.slice(13));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const request = {
    userId: 'test-user',
    natBaseUrl: `http://127.0.0.1:${address.port}`,
    messages: [],
    additionalProps: {},
    documentIngest: {
      documentRefs: [{ documentId: 'fixture' }],
      username: 'test-user',
      collectionName: 'private-test',
      collectionScope: 'private',
    },
  } as unknown as AsyncJobRequest;
  return startBackgroundDocumentIngest('protocol-test', request, 'test-user', {
    signal,
  });
}

describe('real HTTP ingestion terminal protocol', () => {
  it.each(['\n', '\r\n', '\r'])(
    'accepts an explicit complete with %j framing',
    async (newline) => {
      await ingest(
        `event: complete${newline}data: {"output":"Indexed"}${newline}${newline}`,
      );
      expect(mocks.success).toHaveBeenCalledWith(
        'protocol-test',
        expect.anything(),
        'Indexed',
      );
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );
  it.each([
    'event: progress\ndata: {"completed":1,"total":1}\n\n',
    'event: error\r\ndata: {"detail":"Index failed"}\r\n\r\n',
    'event: complete\ndata: {"output":"Truncated"}',
    'event: complete\ndata: invalid-json\n\n',
    'event: complete\ndata: {"output":"Done"}\n\nevent: error\ndata: {"detail":""}\n\n',
  ])('never saves incomplete or error streams as success: %s', async (data) => {
    await ingest(data);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
  });
  it('accepts mixed legal SSE line endings', async () => {
    await ingest('event: complete\r\ndata: {"output":"Mixed framing"}\n\r\n');
    expect(mocks.success).toHaveBeenCalledWith(
      'protocol-test',
      expect.anything(),
      'Mixed framing',
    );
  });
  it('propagates cancellation without success finalization', async () => {
    const controller = new AbortController();
    const pending = ingest(
      'event: progress\ndata: {"completed":0}\n\n',
      controller.signal,
      true,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeDefined();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
