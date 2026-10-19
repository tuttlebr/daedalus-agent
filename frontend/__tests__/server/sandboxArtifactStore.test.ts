import { storeSandboxArtifact } from '@/server/sandboxArtifactStore';
import { createHash } from 'node:crypto';
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
  sha256: (value: string | Buffer) =>
    createHash('sha256').update(value).digest('hex'),
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

  it.each([
    '',
    '/etc/passwd',
    '../escape.html',
    'travel/../../escape.html',
    'travel/./alaska.html',
    'travel//alaska.html',
    'travel/',
    'nul\0byte.txt',
  ])(
    'rejects an unsafe artifact path %j before storing anything',
    async (filePath) => {
      await expect(
        storeSandboxArtifact({
          ownerId: 'alice',
          conversationId: 'conversation-1',
          filePath,
          content: Buffer.from('ready'),
        }),
      ).rejects.toThrow('Sandbox artifact path is invalid');
      expect(mocks.putDocumentObject).not.toHaveBeenCalled();
      expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
    },
  );

  it('retains an upload for expiry when metadata persistence fails', async () => {
    mocks.jsonSetWithExpiry.mockRejectedValueOnce(new Error('redis failed'));

    await expect(
      storeSandboxArtifact({
        ownerId: 'alice',
        conversationId: 'conversation-1',
        filePath: 'report.txt',
        content: Buffer.from('ready'),
      }),
    ).rejects.toThrow('redis failed');

    expect(mocks.srem).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentObject).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'preserves committed bytes when a metadata reply fails (concurrent=%s)',
    async (concurrent) => {
      const objects = new Map<string, Buffer>();
      const documents = new Set<string>();
      const metadata = new Map<string, unknown>();
      const input = {
        ownerId: 'alice',
        conversationId: 'conversation-1',
        filePath: 'report.txt',
        content: Buffer.from('durable report'),
      };
      let entered!: () => void;
      let rejectFirst!: (reason: Error) => void;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const firstReply = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
      mocks.putDocumentObject.mockImplementation(
        async ({ objectKey, source }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of source) chunks.push(chunk);
          objects.set(objectKey, Buffer.concat(chunks));
          return { bucket: 'documents' };
        },
      );
      mocks.deleteDocumentObject.mockImplementation(async (key) =>
        objects.delete(key),
      );
      mocks.sadd.mockImplementation(async (_key, id) => documents.add(id));
      mocks.srem.mockImplementation(async (_key, id) => documents.delete(id));
      mocks.jsonGet.mockImplementation(
        async (key) => metadata.get(key) ?? null,
      );
      mocks.jsonSetWithExpiry
        .mockImplementationOnce(async (key, value) => {
          if (!concurrent) metadata.set(key, value);
          entered();
          return firstReply;
        })
        .mockImplementation(async (key, value) => {
          metadata.set(key, value);
        });

      const first = storeSandboxArtifact(input);
      const rejected = expect(first).rejects.toThrow('reply lost');
      await firstEntered;
      const committed = concurrent ? await storeSandboxArtifact(input) : null;
      rejectFirst(new Error('reply lost'));
      await rejected;

      const retry = await storeSandboxArtifact(input);
      if (committed) expect(retry).toEqual(committed);
      expect(documents.has(retry.documentId)).toBe(true);
      expect([...objects.values()]).toEqual([input.content]);
    },
  );
});
