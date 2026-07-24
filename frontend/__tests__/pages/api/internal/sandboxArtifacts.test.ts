import handler, { config } from '@/pages/api/internal/sandboxArtifacts';

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storeSandboxArtifact: vi.fn(),
}));

vi.mock('@/server/sandboxArtifactStore', () => ({
  SANDBOX_ARTIFACT_MAX_BYTES: 6_291_456,
  storeSandboxArtifact: mocks.storeSandboxArtifact,
}));

function encoded(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function request(content: Buffer, token = 'internal-secret'): any {
  const req = Readable.from([
    content.subarray(0, 3),
    content.subarray(3),
  ]) as any;
  req.method = 'POST';
  req.headers = {
    'content-length': String(content.length),
    'content-type': 'application/octet-stream',
    'x-daedalus-internal-token': token,
    'x-daedalus-owner-id-b64': encoded('alice'),
    'x-daedalus-conversation-id-b64': encoded('conversation-1'),
    'x-daedalus-artifact-path-b64': encoded('travel/alaska.html'),
  };
  return req;
}

function response(): any {
  return {
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
  };
}

describe('/api/internal/sandboxArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DAEDALUS_INTERNAL_API_TOKEN', 'internal-secret');
    mocks.storeSandboxArtifact.mockResolvedValue({
      version: 1,
      documentId: 'document-1',
      sessionId: 'sandbox-session-1',
      sourcePath: 'travel/alaska.html',
      filename: 'alaska.html',
      mimeType: 'text/html; charset=utf-8',
      size: 5,
      downloadUrl:
        '/api/session/documentStorage?documentId=document-1&sessionId=sandbox-session-1',
    });
  });

  it('keeps body parsing disabled for byte-exact publication', () => {
    expect(config.api.bodyParser).toBe(false);
  });

  it('publishes exact bytes only for a trusted internal caller', async () => {
    const content = Buffer.from('hello');
    const res = response();

    await handler(request(content), res);

    expect(mocks.storeSandboxArtifact).toHaveBeenCalledWith({
      ownerId: 'alice',
      conversationId: 'conversation-1',
      filePath: 'travel/alaska.html',
      content,
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects an invalid internal token before reading or storing bytes', async () => {
    const res = response();

    await handler(request(Buffer.from('hello'), 'wrong'), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.storeSandboxArtifact).not.toHaveBeenCalled();
  });

  it('rejects a declared body that exceeds the artifact limit', async () => {
    const req = request(Buffer.from('hello'));
    req.headers['content-length'] = String(6_291_457);
    const res = response();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(mocks.storeSandboxArtifact).not.toHaveBeenCalled();
  });
});
