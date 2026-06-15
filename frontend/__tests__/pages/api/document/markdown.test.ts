import handler from '@/pages/api/document/markdown';

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
    getOrSetSessionId: vi.fn(() => 'current-session'),
    requireAuthenticatedUser: vi.fn(),
    validateDocumentRefsForUser: vi.fn(),
    DocumentRefAccessError: MockDocumentRefAccessError,
    postToBackend: vi.fn(),
  };
});

vi.mock('@/server/session/_utils', () => ({
  getOrSetSessionId: mocks.getOrSetSessionId,
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

vi.mock('@/server/session/documentRefs', () => ({
  validateDocumentRefsForUser: mocks.validateDocumentRefsForUser,
  DocumentRefAccessError: mocks.DocumentRefAccessError,
}));

vi.mock('@/server/backend/postToBackend', () => ({
  postToBackend: mocks.postToBackend,
}));

vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(true),
  ruleFromEnv: vi.fn(() => ({ name: 'test', limit: 1000, windowSeconds: 60 })),
}));

vi.mock('@/utils/app/backendApi', () => ({
  getBackendHost: vi.fn(() => 'backend'),
  buildBackendUrl: vi.fn(() => 'http://backend/v1/documents/markdown'),
}));

vi.mock('@/utils/server/backendAuth', () => ({
  resolveTimezoneFromHeaders: vi.fn(() => 'UTC'),
  withInternalBackendAuth: vi.fn((h: Record<string, string>) => h),
  withTimezoneHeader: vi.fn((h: Record<string, string>) => h),
}));

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

describe('/api/document/markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'alice' });
  });

  it('rejects non-POST methods', async () => {
    const req = { method: 'GET', headers: {} } as any;
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('rejects a missing document reference', async () => {
    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {},
    } as any;
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.postToBackend).not.toHaveBeenCalled();
  });

  it('rejects documentRefs not authorized for the session user', async () => {
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
        documentRef: { documentId: 'doc-a', sessionId: 'other-session' },
        filename: 'a.pdf',
      },
    } as any;
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'You do not have access to one of the document attachments.',
      reason: 'document_ref_forbidden',
    });
    expect(mocks.postToBackend).not.toHaveBeenCalled();
  });

  it('streams the markdown file on success', async () => {
    const validatedRef = { documentId: 'doc-a', sessionId: 'current-session' };
    mocks.validateDocumentRefsForUser.mockResolvedValueOnce([validatedRef]);
    const body = Buffer.from('# Hello\n');
    mocks.postToBackend.mockResolvedValueOnce({
      statusCode: 200,
      headers: {
        'content-disposition': 'attachment; filename="report.md"',
        'x-document-truncated': 'false',
      },
      body,
    });

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        documentRef: { documentId: 'doc-a', sessionId: 'current-session' },
        filename: 'report.pdf',
      },
    } as any;
    const res = makeRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/markdown; charset=utf-8',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="report.md"',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(body);
  });

  it('forwards an upstream error status and detail', async () => {
    mocks.validateDocumentRefsForUser.mockResolvedValueOnce([
      { documentId: 'doc-a', sessionId: 'current-session' },
    ]);
    mocks.postToBackend.mockResolvedValueOnce({
      statusCode: 404,
      headers: {},
      body: Buffer.from(JSON.stringify({ detail: 'Document not found' })),
    });

    const req = {
      method: 'POST',
      headers: { cookie: 'sid=current-session' },
      body: {
        documentRef: { documentId: 'doc-a', sessionId: 'current-session' },
        filename: 'report.pdf',
      },
    } as any;
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Document conversion failed',
      details: 'Document not found',
    });
  });
});
