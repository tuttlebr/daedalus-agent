import handler, {
  DOCUMENT_UPLOAD_MAX_BYTES,
  config,
} from '@/pages/api/session/documentStorage';

import { isExpectedDocumentObjectKey } from '@/server/documentObjectStore';
import { validateHeaderValue } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class DocumentObjectStoreError extends Error {
    statusCode: number;
    storageCode?: string;

    constructor(statusCode: number, message: string, storageCode?: string) {
      super(message);
      this.statusCode = statusCode;
      this.storageCode = storageCode;
    }
  }

  return {
    DocumentObjectStoreError,
    deleteDocumentObject: vi.fn(),
    enforceRateLimit: vi.fn(),
    eval: vi.fn(),
    expire: vi.fn(),
    getDocumentObject: vi.fn(),
    getStorageSessionId: vi.fn(),
    jsonDel: vi.fn(),
    jsonGet: vi.fn(),
    jsonSetWithExpiry: vi.fn(),
    putDocumentObject: vi.fn(),
    requireAuthenticatedUser: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(),
    del: vi.fn(),
  };
});

vi.mock('@/server/documentObjectStore', () => ({
  DocumentObjectStoreError: mocks.DocumentObjectStoreError,
  buildDocumentObjectKey: vi.fn(
    (_owner: string, sessionId: string, documentId: string) =>
      `documents/owner/${sessionId}/${documentId}`,
  ),
  deleteDocumentObject: mocks.deleteDocumentObject,
  getDocumentObject: mocks.getDocumentObject,
  getDocumentObjectConfig: vi.fn(() => ({
    endpoint: new URL('http://minio:9000'),
    accessKey: 'access',
    secretKey: 'secret',
    bucket: 'documents',
    region: 'us-east-1',
    prefix: 'documents',
  })),
  isExpectedDocumentObjectKey: vi.fn(() => true),
  putDocumentObject: mocks.putDocumentObject,
}));

vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  ruleFromEnv: vi.fn(() => ({
    name: 'document-upload',
    limit: 600,
    windowSeconds: 60,
  })),
}));

vi.mock('@/server/session/_utils', () => ({
  getStorageSessionId: mocks.getStorageSessionId,
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => ({
    del: mocks.del,
    eval: mocks.eval,
    expire: mocks.expire,
    sadd: mocks.sadd,
    smembers: mocks.smembers,
    srem: mocks.srem,
  })),
  jsonDel: mocks.jsonDel,
  jsonGet: mocks.jsonGet,
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

function multipartRequest(
  file: Buffer,
  filename = 'paper.pdf',
  mimeType = 'application/pdf',
  finalCrlf = true,
) {
  const boundary = 'test-boundary-123';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--${finalCrlf ? '\r\n' : ''}`);
  const body = Buffer.concat([head, file, tail]);
  const req = Readable.from([
    body.subarray(0, Math.min(body.length, 11)),
    body.subarray(Math.min(body.length, 11)),
  ]) as any;
  req.method = 'POST';
  req.body = undefined;
  req.query = {};
  req.headers = {
    'content-length': String(body.length),
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-document-size': String(file.length),
  };
  return req;
}

function response() {
  return {
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as any;
}

function streamingResponse() {
  const res = new PassThrough() as any;
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn();
  res.status = vi.fn().mockReturnValue(res);
  return res;
}

describe('/api/session/documentStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceRateLimit.mockResolvedValue(true);
    mocks.getStorageSessionId.mockReturnValue('session-1');
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'alice' });
    mocks.eval.mockResolvedValue(1);
    mocks.expire.mockResolvedValue(1);
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
    mocks.jsonDel.mockResolvedValue(1);
    mocks.sadd.mockResolvedValue(1);
    mocks.deleteDocumentObject.mockResolvedValue(undefined);
    mocks.putDocumentObject.mockImplementation(async ({ source }) => {
      for await (const _chunk of source) {
        // Consume the stream so exact length and final-boundary checks run.
      }
      return { bucket: 'documents', etag: 'etag-1' };
    });
  });

  it('disables the Next body parser so bytes can stream', () => {
    expect(config.api.bodyParser).toBe(false);
    expect(DOCUMENT_UPLOAD_MAX_BYTES).toBeGreaterThan(0);
  });

  it('streams a valid file and stores only an owner-scoped object reference', async () => {
    const file = Buffer.from('%PDF-test payload');
    const res = response();

    await handler(multipartRequest(file), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.putDocumentObject).toHaveBeenCalledOnce();
    expect(mocks.putDocumentObject.mock.calls[0][0]).toMatchObject({
      contentLength: file.length,
      contentType: 'application/pdf',
      ownerId: 'alice',
      sessionId: 'session-1',
    });
    const metadata = mocks.jsonSetWithExpiry.mock.calls[0][1];
    expect(metadata).toMatchObject({
      storage: 'object-v1',
      objectBucket: 'documents',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      sessionId: 'session-1',
      size: file.length,
      userId: 'alice',
    });
    expect(metadata).not.toHaveProperty('data');
  });

  it('accepts browser multipart framing without a trailing CRLF', async () => {
    const res = response();
    await handler(
      multipartRequest(
        Buffer.from('%PDF-browser payload'),
        'browser.pdf',
        'application/pdf',
        false,
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.putDocumentObject).toHaveBeenCalledOnce();
  });

  it('reports an empty browser request without accepting or storing it', async () => {
    const req = multipartRequest(Buffer.from('%PDF-test'));
    req.headers['content-length'] = '0';
    const res = response();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error:
        'The browser sent an empty upload. Please select the file again and retry.',
    });
    expect(mocks.putDocumentObject).not.toHaveBeenCalled();
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
    expect(mocks.eval).toHaveBeenCalledTimes(2);
  });

  it.each(['-1', 'NaN', '12x', '9007199254740992'])(
    'still rejects invalid Content-Length %s before storage',
    async (contentLength) => {
      const req = multipartRequest(Buffer.from('%PDF-test'));
      req.headers['content-length'] = contentLength;
      const res = response();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Content-Length is invalid',
      });
      expect(mocks.putDocumentObject).not.toHaveBeenCalled();
    },
  );

  it('infers a known document MIME type before magic-byte validation', async () => {
    const res = response();
    await handler(
      multipartRequest(
        Buffer.from('%PDF-without-browser-type'),
        'untyped.pdf',
        'application/octet-stream',
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.putDocumentObject.mock.calls[0][0].contentType).toBe(
      'application/pdf',
    );
  });

  it('rejects binary content claimed as a text document', async () => {
    const res = response();
    await handler(
      multipartRequest(
        Buffer.from([0x61, 0x00, 0x62]),
        'notes.txt',
        'text/plain',
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(415);
    expect(mocks.putDocumentObject).not.toHaveBeenCalled();
  });

  it.each(['é', '文', '🙂'])(
    'accepts UTF-8 text with %s crossing the sniffed prefix boundary',
    async (character) => {
      const file = Buffer.from('a'.repeat(1023) + character + ' tail');
      const storedChunks: Buffer[] = [];
      mocks.putDocumentObject.mockImplementation(async ({ source }) => {
        for await (const chunk of source) storedChunks.push(chunk);
        return { bucket: 'documents', etag: 'etag-1' };
      });
      const res = response();

      await handler(multipartRequest(file, 'notes.md', 'text/markdown'), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(Buffer.concat(storedChunks)).toEqual(file);
    },
  );

  it.each([
    Buffer.from([0x61, 0xc3]),
    Buffer.concat([Buffer.alloc(1023, 0x61), Buffer.from([0xc3])]),
    Buffer.concat([Buffer.from([0x61, 0xff]), Buffer.alloc(1100, 0x61)]),
  ])('rejects invalid UTF-8 within the inspected text', async (file) => {
    const res = response();
    await handler(multipartRequest(file, 'notes.txt', 'text/plain'), res);

    expect(res.status).toHaveBeenCalledWith(415);
    expect(mocks.putDocumentObject).not.toHaveBeenCalled();
  });

  it('rejects mismatched ZIP signature bytes in an Office upload', async () => {
    const res = response();
    await handler(
      multipartRequest(
        Buffer.from([0x50, 0x4b, 0x03, 0x06, 0x14, 0x00]),
        'paper.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(415);
    expect(mocks.putDocumentObject).not.toHaveBeenCalled();
  });

  it('rejects a MIME mismatch before opening object storage', async () => {
    const res = response();
    await handler(multipartRequest(Buffer.from('not a pdf')), res);

    expect(res.status).toHaveBeenCalledWith(415);
    expect(mocks.putDocumentObject).not.toHaveBeenCalled();
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('rejects excess concurrent uploads without opening object storage', async () => {
    mocks.eval.mockResolvedValueOnce(0);
    const res = response();
    await handler(multipartRequest(Buffer.from('%PDF-test')), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(mocks.putDocumentObject).not.toHaveBeenCalled();
  });

  it('deletes an uploaded object when the Redis metadata write fails', async () => {
    mocks.jsonSetWithExpiry.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );
    const res = response();
    await handler(multipartRequest(Buffer.from('%PDF-test')), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mocks.deleteDocumentObject).toHaveBeenCalledOnce();
  });

  it('removes a possibly committed object when the PUT response is lost', async () => {
    mocks.putDocumentObject.mockImplementationOnce(async ({ source }) => {
      for await (const _chunk of source) {
        // Every byte reached the store before the connection reset.
      }
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const res = response();

    await handler(multipartRequest(Buffer.from('%PDF-test')), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mocks.deleteDocumentObject).toHaveBeenCalledWith(
      mocks.putDocumentObject.mock.calls[0][0].objectKey,
    );
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('surfaces rejected object-store credentials as an actionable 503', async () => {
    mocks.putDocumentObject.mockRejectedValueOnce(
      new mocks.DocumentObjectStoreError(
        403,
        'Document object storage returned 403',
        'InvalidAccessKeyId',
      ),
    );
    const res = response();

    await handler(multipartRequest(Buffer.from('%PDF-test')), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error:
        'Document storage credentials were rejected. Please contact an administrator.',
    });
  });

  it('surfaces a missing object-store bucket as an actionable 503', async () => {
    mocks.putDocumentObject.mockRejectedValueOnce(
      new mocks.DocumentObjectStoreError(
        404,
        'Document object storage returned 404',
        'NoSuchBucket',
      ),
    );
    const res = response();

    await handler(multipartRequest(Buffer.from('%PDF-test')), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error:
        'The document storage bucket was not found. Please contact an administrator.',
    });
  });

  it('releases the per-user upload slot after a successful write', async () => {
    const res = response();
    await handler(multipartRequest(Buffer.from('%PDF-test')), res);

    expect(mocks.eval).toHaveBeenCalledTimes(2);
  });

  it('streams an owner-scoped object download without buffering it', async () => {
    const payload = Buffer.from('%PDF-object payload');
    mocks.jsonGet.mockResolvedValue({
      id: 'doc-1',
      storage: 'object-v1',
      objectKey: 'documents/owner/session-1/doc-1',
      objectBucket: 'documents',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      size: payload.length,
      createdAt: Date.now(),
      sessionId: 'session-1',
      userId: 'alice',
    });
    const object = Readable.from([payload]) as any;
    object.headers = { 'content-length': String(payload.length) };
    mocks.getDocumentObject.mockResolvedValue(object);
    const req = {
      method: 'GET',
      headers: {},
      query: { documentId: 'doc-1', sessionId: 'session-1' },
    } as any;
    const res = streamingResponse();
    const received: Buffer[] = [];
    res.on('data', (chunk: Buffer) => received.push(chunk));

    await handler(req, res);

    expect(Buffer.concat(received)).toEqual(payload);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Length',
      String(payload.length),
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=3600',
    );
    expect(res.send).not.toHaveBeenCalled();
  });

  it('prevents browsers from caching a transient missing-document response', async () => {
    mocks.jsonGet.mockResolvedValue(null);
    const req = {
      method: 'GET',
      headers: {},
      query: { documentId: 'doc-1', sessionId: 'sandbox-session-1' },
    } as any;
    const res = response();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('keeps explicit read compatibility for legacy base64 records', async () => {
    const payload = Buffer.from('%PDF-legacy payload');
    mocks.jsonGet.mockResolvedValue({
      id: 'doc-1',
      data: payload.toString('base64'),
      filename: 'legacy.pdf',
      mimeType: 'application/pdf',
      size: payload.length,
      createdAt: Date.now(),
      sessionId: 'session-1',
      userId: 'alice',
    });
    const req = {
      method: 'GET',
      headers: {},
      query: { documentId: 'doc-1' },
    } as any;
    const res = response();
    res.send = vi.fn().mockReturnThis();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(payload);
    expect(mocks.getDocumentObject).not.toHaveBeenCalled();
  });

  it('downloads a Unicode filename using an ASCII header and UTF-8 filename parameter', async () => {
    const payload = Buffer.from('document text');
    mocks.jsonGet.mockResolvedValue({
      id: 'doc-1',
      data: payload.toString('base64'),
      filename: '文档🙂.txt',
      mimeType: 'text/plain',
      size: payload.length,
      sessionId: 'session-1',
      userId: 'alice',
    });
    const res = response();
    // Next.js sends these values through Node's actual HTTP header validator.
    res.setHeader.mockImplementation(validateHeaderValue);
    res.send = vi.fn().mockReturnThis();

    await handler(
      { method: 'GET', headers: {}, query: { documentId: 'doc-1' } } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(payload);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename="____.txt"; filename*=UTF-8''${encodeURIComponent(
        '文档🙂.txt',
      )}`,
    );
  });

  it('checks ownership before deleting the object and metadata', async () => {
    mocks.jsonGet.mockResolvedValue({
      id: 'doc-1',
      storage: 'object-v1',
      objectKey: 'documents/owner/session-1/doc-1',
      objectBucket: 'documents',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 10,
      createdAt: Date.now(),
      sessionId: 'session-1',
      userId: 'mallory',
    });
    const req = {
      method: 'DELETE',
      headers: {},
      query: { documentId: 'doc-1' },
    } as any;
    const res = response();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mocks.deleteDocumentObject).not.toHaveBeenCalled();
    expect(mocks.jsonDel).not.toHaveBeenCalled();
  });

  it('stores upload metadata without an unread session index', async () => {
    const res = response();
    await handler(multipartRequest(Buffer.from('%PDF-test')), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.jsonSetWithExpiry).toHaveBeenCalledOnce();
    expect(mocks.sadd).not.toHaveBeenCalled();
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it('refuses an owned record whose object key points into another scope', async () => {
    const real = await vi.importActual<
      typeof import('@/server/documentObjectStore')
    >('@/server/documentObjectStore');
    vi.mocked(isExpectedDocumentObjectKey).mockImplementation(
      real.isExpectedDocumentObjectKey,
    );
    const objectConfig = {
      endpoint: new URL('http://minio:9000'),
      accessKey: 'access',
      secretKey: 'secret',
      bucket: 'documents',
      region: 'us-east-1',
      prefix: 'documents',
      requestTimeoutMs: 1_000,
    };
    const record = (objectKey: string) => ({
      id: 'doc-1',
      storage: 'object-v1',
      objectKey,
      objectBucket: 'documents',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 4,
      createdAt: Date.now(),
      sessionId: 'session-1',
      userId: 'alice',
    });
    const download = async () => {
      const res = response();
      await handler(
        {
          method: 'GET',
          headers: {},
          query: { documentId: 'doc-1', sessionId: 'session-1' },
        } as any,
        res,
      );
      return res;
    };
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      for (const objectKey of [
        // Alice's metadata naming Bob's object, another session, another file.
        real.buildDocumentObjectKey('bob', 'session-1', 'doc-1', objectConfig),
        real.buildDocumentObjectKey(
          'alice',
          'session-2',
          'doc-1',
          objectConfig,
        ),
        real.buildDocumentObjectKey(
          'alice',
          'session-1',
          'doc-2',
          objectConfig,
        ),
      ]) {
        mocks.jsonGet.mockResolvedValueOnce(record(objectKey));
        expect((await download()).status).toHaveBeenCalledWith(500);
      }
      expect(mocks.getDocumentObject).not.toHaveBeenCalled();

      const object = Readable.from([Buffer.from('%PDF')]) as any;
      object.headers = { 'content-length': '4' };
      mocks.getDocumentObject.mockResolvedValueOnce(object);
      mocks.jsonGet.mockResolvedValueOnce(
        record(
          real.buildDocumentObjectKey(
            'alice',
            'session-1',
            'doc-1',
            objectConfig,
          ),
        ),
      );
      const owned = streamingResponse();
      owned.resume();
      await handler(
        {
          method: 'GET',
          headers: {},
          query: { documentId: 'doc-1', sessionId: 'session-1' },
        } as any,
        owned,
      );
      expect(mocks.getDocumentObject).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
      vi.mocked(isExpectedDocumentObjectKey).mockImplementation(() => true);
    }
  });

  it('fails a download whose object length differs from its metadata', async () => {
    mocks.jsonGet.mockResolvedValue({
      id: 'doc-1',
      storage: 'object-v1',
      objectKey: 'documents/owner/session-1/doc-1',
      objectBucket: 'documents',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 10,
      createdAt: Date.now(),
      sessionId: 'session-1',
      userId: 'alice',
    });
    const object = Readable.from([Buffer.from('%PDF-truncated')]) as any;
    object.headers = { 'content-length': '14' };
    const destroy = vi.spyOn(object, 'destroy');
    mocks.getDocumentObject.mockResolvedValue(object);
    const res = streamingResponse();
    const received: Buffer[] = [];
    res.on('data', (chunk: Buffer) => received.push(chunk));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      await handler(
        { method: 'GET', headers: {}, query: { documentId: 'doc-1' } } as any,
        res,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(res.status).toHaveBeenCalledWith(500);
    expect(destroy).toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Length', '10');
  });

  it.each([
    [{ documentId: 'session-2:doc-1' }],
    [{ documentId: 'doc-1', sessionId: 'session-1:doc-2' }],
    [{ documentId: '../doc-1' }],
    [{ documentId: 'x'.repeat(129) }],
  ])(
    'rejects reference IDs that could address another key (%j)',
    async (query) => {
      for (const method of ['GET', 'DELETE']) {
        const res = response();
        await handler({ method, headers: {}, query } as any, res);
        expect(res.status).toHaveBeenCalledWith(400);
      }
      expect(mocks.jsonGet).not.toHaveBeenCalled();
      expect(mocks.jsonDel).not.toHaveBeenCalled();
    },
  );
});
