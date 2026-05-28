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
    getOrSetSessionId: vi.fn(() => 'current-session'),
    requireAuthenticatedUser: vi.fn(),
    validateDocumentRefsForUser: vi.fn(),
    DocumentRefAccessError: MockDocumentRefAccessError,
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

describe('/api/document/process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'alice' });
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
        documentRef: { documentId: 'doc-a', sessionId: 'other-session' },
        filename: 'a.pdf',
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

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
  });
});
