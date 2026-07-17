import handler, {
  DOCUMENT_UPLOAD_BODY_LIMIT_BYTES,
  DOCUMENT_UPLOAD_MAX_BASE64_CHARS,
  decodedBase64Size,
  inspectDocumentPayload,
  storeDocument,
} from '@/pages/api/session/documentStorage';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  eval: vi.fn(),
  expire: vi.fn(),
  getOrSetSessionId: vi.fn(),
  jsonDel: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
  sadd: vi.fn(),
  srem: vi.fn(),
  smembers: vi.fn(),
  del: vi.fn(),
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

function requestResponse(body: unknown) {
  const req = { method: 'POST', body } as any;
  const res = {
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as any;
  return { req, res };
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
    mocks.sadd.mockResolvedValue(1);
  });

  it('calculates padded and unpadded decoded lengths without allocating buffers', () => {
    expect(decodedBase64Size('Zg==')).toBe(1);
    expect(decodedBase64Size('Zm8=')).toBe(2);
    expect(decodedBase64Size('Zm9v')).toBe(3);
    expect(decodedBase64Size('Zm8')).toBe(2);
    expect(() => decodedBase64Size('A')).toThrow('not valid base64');
    expect(() => decodedBase64Size('Zm$=')).toThrow('not valid base64');
  });

  it('derives the request-body limit from the encoded raw-byte limit', () => {
    expect(DOCUMENT_UPLOAD_BODY_LIMIT_BYTES).toBe(
      DOCUMENT_UPLOAD_MAX_BASE64_CHARS + 64 * 1024,
    );
  });

  it('decodes only a bounded prefix for magic-byte validation', () => {
    const raw = Buffer.alloc(8 * 1024, 0x20);
    raw.write('<!doctype html><html>');
    const encoded = raw.toString('base64');
    const bufferFrom = vi.spyOn(Buffer, 'from');

    try {
      const parsed = inspectDocumentPayload(
        `data:text/html;base64,${encoded}`,
        'text/html',
      );
      expect(parsed.size).toBe(raw.length);
      expect(parsed.cleanBase64).toBe(encoded);
      expect(
        bufferFrom.mock.calls.some(
          ([value]) => typeof value === 'string' && value === encoded,
        ),
      ).toBe(false);
      const decodedStringLengths = bufferFrom.mock.calls
        .map(([value]) => (typeof value === 'string' ? value.length : 0))
        .filter(Boolean);
      expect(Math.max(...decodedStringLengths)).toBeLessThanOrEqual(1366);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it('stores the original encoded payload with its exact decoded size', async () => {
    const raw = Buffer.from('%PDF-test payload');
    const payload = raw.toString('base64');
    await storeDocument(
      'session-1',
      'alice',
      payload,
      'paper.pdf',
      'application/pdf',
    );

    expect(mocks.jsonSetWithExpiry).toHaveBeenCalledOnce();
    expect(mocks.jsonSetWithExpiry.mock.calls[0][1]).toMatchObject({
      data: payload,
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      sessionId: 'session-1',
      size: raw.length,
      userId: 'alice',
    });
  });

  it('rejects excess concurrent uploads without writing a document', async () => {
    mocks.eval.mockResolvedValueOnce(0);
    const payload = Buffer.from('%PDF-test').toString('base64');
    const { req, res } = requestResponse({
      base64Data: payload,
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('releases the atomic upload slot after a successful write', async () => {
    const payload = Buffer.from('%PDF-test').toString('base64');
    const { req, res } = requestResponse({
      base64Data: payload,
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.eval).toHaveBeenCalledTimes(2);
    expect(mocks.jsonSetWithExpiry).toHaveBeenCalledOnce();
  });
});
