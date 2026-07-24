import { storeSandboxArtifact } from '@/server/sandboxArtifactStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteDocumentObject: vi.fn(),
  expire: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  putDocumentObject: vi.fn(),
  sadd: vi.fn(),
  srem: vi.fn(),
}));

vi.mock('@/server/documentObjectStore', () => ({
  buildDocumentObjectKey: vi.fn(
    (_owner: string, sessionId: string, documentId: string) =>
      `documents/owner/${sessionId}/${documentId}`,
  ),
  deleteDocumentObject: mocks.deleteDocumentObject,
  getDocumentObjectConfig: vi.fn(() => ({
    endpoint: new URL('http://minio:9000'),
    accessKey: 'access',
    secretKey: 'secret',
    bucket: 'documents',
    region: 'us-east-1',
    prefix: 'documents',
    requestTimeoutMs: 1000,
  })),
  isExpectedDocumentObjectKey: vi.fn(() => true),
  putDocumentObject: mocks.putDocumentObject,
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => ({
    expire: mocks.expire,
    sadd: mocks.sadd,
    srem: mocks.srem,
  })),
  jsonGet: mocks.jsonGet,
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  sessionKey: vi.fn((parts: string[]) => parts.join(':')),
}));

describe('sandbox artifact object storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jsonGet.mockResolvedValue(null);
    mocks.putDocumentObject.mockImplementation(async ({ source }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(chunk);
      return { bucket: 'documents', etag: 'etag-1', chunks };
    });
    mocks.sadd.mockResolvedValue(1);
    mocks.expire.mockResolvedValue(1);
    mocks.srem.mockResolvedValue(1);
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
    mocks.deleteDocumentObject.mockResolvedValue(undefined);
  });

  it('stores exact bytes with owner-scoped metadata and a durable link', async () => {
    const content = Buffer.from('<!doctype html><title>Alaska</title>');

    const artifact = await storeSandboxArtifact({
      ownerId: 'alice',
      conversationId: 'conversation-1',
      filePath: 'travel/alaska.html',
      content,
    });

    expect(mocks.putDocumentObject).toHaveBeenCalledOnce();
    expect(mocks.putDocumentObject.mock.calls[0][0]).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      contentLength: content.length,
      ownerId: 'alice',
    });
    await expect(
      mocks.putDocumentObject.mock.results[0].value,
    ).resolves.toMatchObject({ chunks: [content] });
    const metadata = mocks.jsonSetWithExpiry.mock.calls[0][1];
    expect(metadata).toMatchObject({
      id: artifact.documentId,
      storage: 'object-v1',
      filename: 'alaska.html',
      mimeType: 'text/html; charset=utf-8',
      size: content.length,
      userId: 'alice',
      source: 'sandbox',
    });
    expect(metadata).not.toHaveProperty('data');
    expect(artifact.downloadUrl).toBe(
      `/api/session/documentStorage?documentId=${artifact.documentId}&sessionId=${artifact.sessionId}`,
    );
  });

  it('reuses matching deterministic metadata without uploading twice', async () => {
    const input = {
      ownerId: 'alice',
      conversationId: 'conversation-1',
      filePath: 'report.txt',
      content: Buffer.from('ready'),
    };
    const first = await storeSandboxArtifact(input);
    const stored = mocks.jsonSetWithExpiry.mock.calls[0][1];
    mocks.jsonGet.mockResolvedValue(stored);

    const second = await storeSandboxArtifact(input);

    expect(second).toEqual(first);
    expect(mocks.putDocumentObject).toHaveBeenCalledOnce();
  });

  it('removes an object when metadata persistence fails', async () => {
    mocks.jsonSetWithExpiry.mockRejectedValueOnce(new Error('redis failed'));

    await expect(
      storeSandboxArtifact({
        ownerId: 'alice',
        conversationId: 'conversation-1',
        filePath: 'report.txt',
        content: Buffer.from('ready'),
      }),
    ).rejects.toThrow('redis failed');

    expect(mocks.srem).toHaveBeenCalledOnce();
    expect(mocks.deleteDocumentObject).toHaveBeenCalledOnce();
  });
});
