// @vitest-environment node
import { startBackgroundDocumentIngest } from '@/server/chat/documentIngest';
import type { AsyncJobRequest } from '@/server/chat/types';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  updateJobStatus: vi.fn(),
}));
vi.mock('@/server/chat/finalization', () => ({
  finalizeSuccess: mocks.success,
  finalizeError: mocks.error,
}));
vi.mock('@/server/chat/jobState', () => ({
  updateJobStatus: mocks.updateJobStatus,
  clearOAuthStatusFields: () => ({}),
}));
vi.mock('@/server/chat/natMessages', () => ({
  buildNatRequestHeaders: () => ({}),
}));
let server: Server | undefined;
let secondChunk: NodeJS.Timeout | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  clearTimeout(secondChunk);
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function ingest(data: string, signal?: AbortSignal, remainOpen = false) {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Split inside the first line terminator (between CR and LF for CRLF) and
    // send the rest later: back-to-back writes reach the reader as one chunk,
    // which would not exercise buffering of partial frames across reads.
    const split = data.includes('\r') ? data.indexOf('\r') + 1 : 13;
    res.write(data.slice(0, split));
    secondChunk = setTimeout(() => {
      if (remainOpen) res.write(data.slice(split));
      else res.end(data.slice(split));
    }, 20);
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
  it('closes the backend stream when local progress persistence fails', async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    server = createServer((req, res) => {
      res.on('close', () => closed());
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: progress\ndata: {"completed":0,"total":1}\n\n');
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    mocks.updateJobStatus
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Redis unavailable'));
    const request = {
      userId: 'test-user',
      natBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      documentIngest: {
        documentRefs: [{ documentId: 'fixture' }],
        username: 'test-user',
        collectionName: 'private-test',
        collectionScope: 'private',
      },
    } as unknown as AsyncJobRequest;

    await startBackgroundDocumentIngest('protocol-test', request, 'test-user');

    expect(mocks.error).toHaveBeenCalledWith(
      'protocol-test',
      expect.anything(),
      'Redis unavailable',
    );
    // The failed job must not leave the backend ingesting on an orphaned
    // connection until the one-hour ingestion deadline.
    await expect(
      Promise.race([
        connectionClosed.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('open'), 1_000)),
      ]),
    ).resolves.toBe('closed');
  });

  it('reports a backend rejection without waiting for a stalled error body', async () => {
    server = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.write('{"detail":"documentRef or documentRefs required"}');
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const request = {
      userId: 'test-user',
      natBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      documentIngest: {
        documentRefs: [],
        username: 'test-user',
        collectionName: 'private-test',
        collectionScope: 'private',
      },
    } as unknown as AsyncJobRequest;

    const started = Date.now();
    await startBackgroundDocumentIngest('protocol-test', request, 'test-user');

    // The complete JSON detail must end the read, well before the 5 s error
    // body deadline that only bounds an incomplete diagnostic body.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(mocks.error).toHaveBeenCalledWith(
      'protocol-test',
      expect.anything(),
      'Document ingest failed (400): documentRef or documentRefs required',
    );
  }, 15_000);

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
