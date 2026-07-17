import handler, {
  cleanupSessionDocuments,
  DOCUMENT_UPLOAD_MAX_BYTES,
  config,
} from '@/pages/api/session/documentStorage';

import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteDocumentObject: vi.fn(),
  enforceRateLimit: vi.fn(),
  eval: vi.fn(),
  expire: vi.fn(),
  getDocumentObject: vi.fn(),
  getOrSetSessionId: vi.fn(),
  jsonDel: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  putDocumentObject: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  sadd: vi.fn(),
  srem: vi.fn(),
  smembers: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/server/documentObjectStore', () => ({
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
  getOrSetSessionId: mocks.getOrSetSessionId,
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
    mocks.getOrSetSessionId.mockReturnValue('session-1');
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
    expect(res.send).not.toHaveBeenCalled();
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

  it('cleans up only session documents owned by the authenticated user', async () => {
    mocks.smembers.mockResolvedValue(['owned-doc', 'foreign-doc']);
    mocks.jsonGet.mockImplementation(async (key: string) => ({
      id: key.endsWith('owned-doc') ? 'owned-doc' : 'foreign-doc',
      storage: 'object-v1',
      objectKey: key.endsWith('owned-doc')
        ? 'documents/owner/session-1/owned-doc'
        : 'documents/other/session-1/foreign-doc',
      objectBucket: 'documents',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 10,
      createdAt: Date.now(),
      sessionId: 'session-1',
      userId: key.endsWith('owned-doc') ? 'alice' : 'mallory',
    }));

    await expect(cleanupSessionDocuments('session-1', 'alice')).resolves.toBe(
      1,
    );

    expect(mocks.deleteDocumentObject).toHaveBeenCalledOnce();
    expect(mocks.deleteDocumentObject).toHaveBeenCalledWith(
      'documents/owner/session-1/owned-doc',
    );
    expect(mocks.jsonDel).toHaveBeenCalledOnce();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('keeps metadata when cleanup cannot delete the owned object', async () => {
    mocks.smembers.mockResolvedValue(['owned-doc']);
    mocks.jsonGet.mockResolvedValue({
      id: 'owned-doc',
      storage: 'object-v1',
      objectKey: 'documents/owner/session-1/owned-doc',
      objectBucket: 'documents',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 10,
      createdAt: Date.now(),
      sessionId: 'session-1',
      userId: 'alice',
    });
    mocks.deleteDocumentObject.mockRejectedValueOnce(
      new Error('object store unavailable'),
    );

    await expect(cleanupSessionDocuments('session-1', 'alice')).rejects.toThrow(
      'object store unavailable',
    );

    expect(mocks.jsonDel).not.toHaveBeenCalled();
    expect(mocks.srem).not.toHaveBeenCalled();
  });
});
