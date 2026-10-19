import handler from '@/pages/api/document/process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockDocumentRefAccessError extends Error {
    status: number;
    reason: string;

    constructor(status: number, message: string, reason: string) {
      super(message);
      this.name = 'DocumentRefAccessError';
      this.status = status;
      this.reason = reason;
    }
  }

  return {
    getStorageSessionId: vi.fn(() => 'current-session'),
    requireAuthenticatedUser: vi.fn(),
    validateDocumentRefsForUser: vi.fn(),
    DocumentRefAccessError: MockDocumentRefAccessError,
    postToBackend: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock('@/utils/server/httpProxy', () => ({
  postToBackend: mocks.postToBackend,
}));

vi.mock('@/utils/app/backendApi', () => ({
  getBackendHost: vi.fn(() => 'backend'),
  buildBackendUrl: vi.fn(
    ({ pathOverride }: { pathOverride: string }) =>
      `http://backend:8000${pathOverride}`,
  ),
}));

vi.mock('@/utils/server/backendAuth', () => ({
  resolveTimezoneFromHeaders: vi.fn(() => 'UTC'),
  withInternalBackendAuth: vi.fn((headers: Record<string, string>) => ({
    ...headers,
    'x-daedalus-internal-token': 'internal-secret',
  })),
  withTimezoneHeader: vi.fn((headers: Record<string, string>) => headers),
}));

vi.mock('@/server/session/_utils', () => ({
  getStorageSessionId: mocks.getStorageSessionId,
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

vi.mock('@/server/session/documentRefs', () => ({
  validateDocumentRefsForUser: mocks.validateDocumentRefsForUser,
  DocumentRefAccessError: mocks.DocumentRefAccessError,
}));

// Stub the rate limiter so the route test stays deterministic and never opens a
// real Redis connection (the limiter is covered by __tests__/server/rateLimit).
vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(true),
  ruleFromEnv: vi.fn(() => ({ name: 'test', limit: 1000, windowSeconds: 60 })),
}));

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

describe('/api/document/process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'alice' });
    vi.stubGlobal('fetch', mocks.fetch);
  });

  it('rejects documentRefs that are not authorized for the session user', async () => {
    mocks.validateDocumentRefsForUser.mockRejectedValueOnce(
      new mocks.DocumentRefAccessError(
        403,
        'You do not have access to one of the document attachments.',
        'document_ref_forbidden',
      ),
    );

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        mode: 'extract',
        documentRef: { documentId: 'doc-a', sessionId: 'other-session' },
        filename: 'a.pdf',
      },
    } as any;
    const res = makeRes();

    await handler(req, res);

    expect(mocks.validateDocumentRefsForUser).toHaveBeenCalledWith(
      [{ documentId: 'doc-a', sessionId: 'other-session' }],
      'current-session',
      'alice',
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'You do not have access to one of the document attachments.',
      reason: 'document_ref_forbidden',
    });
    expect(mocks.postToBackend).not.toHaveBeenCalled();
  });

  it('extracts one validated document through the typed backend route', async () => {
    const validatedRef = { documentId: 'doc-a', sessionId: 'current-session' };
    mocks.validateDocumentRefsForUser.mockResolvedValueOnce([validatedRef]);
    mocks.postToBackend.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          markdown: '# Paper',
          filename: 'paper.pdf',
          pages: 2,
          truncated: true,
          original_chars: 90_000,
        }),
      ),
    });
    const res = makeRes();

    await handler(
      {
        method: 'POST',
        headers: {},
        body: {
          mode: 'extract',
          documentRef: { ...validatedRef, userId: 'mallory' },
          filename: 'ignored.pdf',
        },
      } as any,
      res,
    );

    expect(mocks.postToBackend).toHaveBeenCalledWith(
      'http://backend:8000/v1/documents/extract',
      JSON.stringify({ documentRef: validatedRef, username: 'alice' }),
      expect.objectContaining({
        'x-user-id': 'alice',
        'x-daedalus-internal-token': 'internal-secret',
      }),
      900_000,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      mode: 'extract',
      markdown: '# Paper',
      filename: 'paper.pdf',
      pages: 2,
      truncated: true,
      originalChars: 90_000,
    });
  });

  it.each([undefined, 'ingest'])(
    'rejects mode %s without contacting metadata or the agent backend',
    async (mode) => {
      const res = makeRes();

      await handler(
        {
          method: 'POST',
          headers: {},
          body: {
            ...(mode ? { mode } : {}),
            documentRef: { documentId: 'doc-a', sessionId: 'current-session' },
            collection: 'user_uploads_alice',
          },
        } as any,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error:
          'Only mode "extract" is supported. Ingest documents by attaching them to a chat message.',
        reason: 'unsupported_mode',
      });
      expect(mocks.validateDocumentRefsForUser).not.toHaveBeenCalled();
      expect(mocks.postToBackend).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
});
