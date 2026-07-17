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
