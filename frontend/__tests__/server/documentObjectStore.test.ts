import {
  buildDocumentObjectKey,
  getDocumentObject,
  getDocumentObjectConfig,
  isExpectedDocumentObjectKey,
  putDocumentObject,
} from '@/server/documentObjectStore';
import { once } from 'node:events';
import http from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('documentObjectStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed when object-store credentials are absent', () => {
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', '');
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', '');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', '');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', '');
    vi.stubEnv('MINIO_ENDPOINT', '');
    vi.stubEnv('MINIO_ACCESS_KEY', '');
    vi.stubEnv('MINIO_SECRET_KEY', '');
    vi.stubEnv('MINIO_BUCKET', '');

    expect(() => getDocumentObjectConfig()).toThrow('not configured');
  });

  it('does not reuse general MinIO credentials as document credentials', () => {
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', '');
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', '');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', '');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', '');
    vi.stubEnv('MINIO_ENDPOINT', 'http://minio:9000');
    vi.stubEnv('MINIO_ACCESS_KEY', 'broad-access');
    vi.stubEnv('MINIO_SECRET_KEY', 'broad-secret');
    vi.stubEnv('MINIO_BUCKET', 'nv-ingest');

    expect(() => getDocumentObjectConfig()).toThrow(
      'set DOCUMENT_OBJECT_BUCKET',
    );

    // A document bucket alone must not unlock the broad MinIO credentials.
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    expect(() => getDocumentObjectConfig()).toThrow(
      'set DOCUMENT_OBJECT_ENDPOINT',
    );
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', 'http://documents:9000');
    expect(() => getDocumentObjectConfig()).toThrow(
      'set DOCUMENT_OBJECT_ACCESS_KEY',
    );
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'document-access');
    expect(() => getDocumentObjectConfig()).toThrow(
      'set DOCUMENT_OBJECT_SECRET_KEY',
    );
  });

  it('builds deterministic owner-scoped keys without filenames', () => {
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', 'http://minio:9000');
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'access');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'secret');
    vi.stubEnv('DOCUMENT_OBJECT_SESSION_TOKEN', 'temporary-session-token');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    const config = getDocumentObjectConfig();

    const key = buildDocumentObjectKey('alice', 'session-1', 'doc-1', config);

    expect(key).toMatch(/^daedalus-documents\/[a-f0-9]{32}\/session-1\/doc-1$/);
    expect(key).not.toContain('paper.pdf');
    expect(config.requestTimeoutMs).toBe(300_000);
    expect(config.sessionToken).toBe('temporary-session-token');
    expect(
      isExpectedDocumentObjectKey(key, 'alice', 'session-1', 'doc-1', config),
    ).toBe(true);
    expect(
      isExpectedDocumentObjectKey(key, 'bob', 'session-1', 'doc-1', config),
    ).toBe(false);
  });

  it('rejects unsafe key segments', () => {
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', 'http://minio:9000');
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'access');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'secret');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    expect(() =>
      buildDocumentObjectKey('alice', '../session', 'doc-1'),
    ).toThrow('Session ID is invalid');
  });

  it('rejects request deadlines outside the configured safety bounds', () => {
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', 'http://minio:9000');
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'access');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'secret');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    vi.stubEnv('DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS', '900001');

    expect(() => getDocumentObjectConfig()).toThrow(
      'DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS must be between 100 and 900000',
    );
  });

  it('streams a signed PUT with exact length and lifecycle metadata', async () => {
    const received: Buffer[] = [];
    let requestHeaders: http.IncomingHttpHeaders = {};
    let requestPath = '';
    const server = http.createServer(async (req, res) => {
      requestHeaders = req.headers;
      requestPath = req.url || '';
      for await (const chunk of req) received.push(Buffer.from(chunk));
      res.setHeader('ETag', '"etag-1"');
      res.statusCode = 200;
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'access');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'secret');
    vi.stubEnv('DOCUMENT_OBJECT_SESSION_TOKEN', 'temporary-session-token');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    const config = getDocumentObjectConfig();
    const payload = Buffer.from('%PDF-streamed');
    const objectKey = buildDocumentObjectKey(
      'alice',
      'session-1',
      'doc-1',
      config,
    );

    try {
      const result = await putDocumentObject(
        {
          objectKey,
          contentType: 'application/pdf',
          contentLength: payload.length,
          expiresAt: 123456789,
          ownerId: 'alice',
          sessionId: 'session-1',
          documentId: 'doc-1',
          source: (async function* () {
            yield payload.subarray(0, 4);
            yield payload.subarray(4);
          })(),
        },
        config,
      );

      expect(result).toEqual({ bucket: 'documents', etag: 'etag-1' });
      expect(Buffer.concat(received)).toEqual(payload);
      expect(requestPath).toBe(`/documents/${objectKey}`);
      expect(requestHeaders.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(requestHeaders['x-amz-security-token']).toBe(
        'temporary-session-token',
      );
      expect(requestHeaders['content-length']).toBe(String(payload.length));
      expect(requestHeaders['x-amz-meta-expires-at']).toBe('123456789');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('preserves an early object-store rejection while the source is streaming', async () => {
    let chunksRead = 0;
    const server = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.end(
        '<Error><Code>InvalidAccessKeyId</Code><Message>rejected</Message></Error>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'invalid-access');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'invalid-secret');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    const config = getDocumentObjectConfig();

    try {
      await expect(
        putDocumentObject(
          {
            objectKey: 'daedalus-documents/owner/session/doc',
            contentType: 'application/pdf',
            contentLength: 1024 * 1024,
            expiresAt: 123456789,
            ownerId: 'alice',
            sessionId: 'session-1',
            documentId: 'doc-1',
            source: (async function* () {
              for (let index = 0; index < 1024; index += 1) {
                chunksRead += 1;
                yield Buffer.alloc(1024);
                await new Promise((resolve) => setImmediate(resolve));
              }
            })(),
          },
          config,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('InvalidAccessKeyId'),
        statusCode: 403,
        storageCode: 'InvalidAccessKeyId',
      });
      expect(chunksRead).toBeLessThan(1024);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  // The timeout bounds an operation that stops making progress. Browser
  // uploads and downloads stream through these requests, so a large transfer
  // over a slow link legitimately outlasts it while bytes keep moving.
  async function slowObjectStore(handler: http.RequestListener): Promise<{
    server: http.Server;
    config: ReturnType<typeof getDocumentObjectConfig>;
  }> {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'access');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'secret');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    vi.stubEnv('DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS', '250');
    return { server, config: getDocumentObjectConfig() };
  }

  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps streaming a download that outlasts the timeout while bytes arrive', async () => {
    const { server, config } = await slowObjectStore(async (_req, res) => {
      res.writeHead(200, { 'Content-Length': '8' });
      for (let index = 0; index < 8; index += 1) {
        res.write('x');
        await pause(100);
      }
      res.end();
    });

    try {
      const object = await getDocumentObject('documents/owner/s/doc', config);
      const chunks: Buffer[] = [];
      for await (const chunk of object!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('xxxxxxxx');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('keeps an upload open while a slow browser keeps sending bytes', async () => {
    const received: Buffer[] = [];
    const { server, config } = await slowObjectStore(async (req, res) => {
      for await (const chunk of req) received.push(Buffer.from(chunk));
      res.statusCode = 200;
      res.end();
    });

    try {
      await expect(
        putDocumentObject(
          {
            objectKey: 'documents/owner/s/doc',
            contentType: 'text/plain',
            contentLength: 8,
            expiresAt: 1,
            ownerId: 'alice',
            sessionId: 's',
            documentId: 'doc',
            source: (async function* () {
              for (let index = 0; index < 8; index += 1) {
                await pause(100);
                yield Buffer.from('y');
              }
            })(),
          },
          config,
        ),
      ).resolves.toEqual({ bucket: 'documents' });
      expect(Buffer.concat(received).toString()).toBe('yyyyyyyy');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('aborts a download whose body stalls for longer than the timeout', async () => {
    const { server, config } = await slowObjectStore((_req, res) => {
      res.writeHead(200, { 'Content-Length': '8' });
      res.write('x');
      // Never send the remaining bytes.
    });

    try {
      const object = await getDocumentObject('documents/owner/s/doc', config);
      await expect(
        (async () => {
          for await (const _chunk of object!) {
            // Drain until the stall is detected.
          }
        })(),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('destroys a socket when an accepted request never receives a response', async () => {
    let acceptedSocket: Socket | undefined;
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });
    const server = http.createServer(() => {
      // Accept the request and intentionally never send response headers.
    });
    server.on('connection', (socket) => {
      acceptedSocket = socket;
      socket.once('close', resolveSocketClosed);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    vi.stubEnv('DOCUMENT_OBJECT_ENDPOINT', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('DOCUMENT_OBJECT_ACCESS_KEY', 'access');
    vi.stubEnv('DOCUMENT_OBJECT_SECRET_KEY', 'secret');
    vi.stubEnv('DOCUMENT_OBJECT_BUCKET', 'documents');
    vi.stubEnv('DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS', '100');
    const config = getDocumentObjectConfig();

    try {
      await expect(
        getDocumentObject('daedalus-documents/owner/session/doc', config),
      ).rejects.toThrow(
        'Document object storage GET request timed out after 100ms',
      );
      await socketClosed;
      expect(acceptedSocket?.destroyed).toBe(true);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
