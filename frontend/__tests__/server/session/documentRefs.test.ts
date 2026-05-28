import {
  DocumentRefAccessError,
  validateDocumentRefsForUser,
} from '@/server/session/documentRefs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  canAccessStoredDocument: vi.fn(),
}));

vi.mock('@/pages/api/session/documentStorage', () => ({
  getDocument: mocks.getDocument,
  canAccessStoredDocument: mocks.canAccessStoredDocument,
}));

describe('documentRefs validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAccessStoredDocument.mockReturnValue(true);
  });

  it('normalizes refs from the stored document record', async () => {
    mocks.getDocument.mockResolvedValue({
      id: 'doc-a',
      sessionId: 'sess-1',
      filename: 'stored.pdf',
      mimeType: 'application/pdf',
      userId: 'alice',
    });

    const refs = await validateDocumentRefsForUser(
      [{ documentId: 'doc-a', sessionId: 'sess-1', filename: 'upload.pdf' }],
      'current-session',
      'alice',
    );

    expect(mocks.getDocument).toHaveBeenCalledWith('sess-1', 'doc-a');
    expect(refs).toEqual([
      {
        documentId: 'doc-a',
        sessionId: 'sess-1',
        filename: 'upload.pdf',
        mimeType: 'application/pdf',
        userId: 'alice',
      },
    ]);
  });

  it('rejects refs that do not belong to the authenticated user', async () => {
    mocks.getDocument.mockResolvedValue({
      id: 'doc-a',
      sessionId: 'other-session',
      filename: 'stored.pdf',
      mimeType: 'application/pdf',
      userId: 'bob',
    });
    mocks.canAccessStoredDocument.mockReturnValue(false);

    await expect(
      validateDocumentRefsForUser(
        [{ documentId: 'doc-a', sessionId: 'other-session' }],
        'current-session',
        'alice',
      ),
    ).rejects.toMatchObject({
      status: 403,
      reason: 'document_ref_forbidden',
    } satisfies Partial<DocumentRefAccessError>);
  });

  it('rejects malformed ids before hitting Redis', async () => {
    await expect(
      validateDocumentRefsForUser(
        [{ documentId: 'doc:a', sessionId: 'sess-1' }],
        'current-session',
        'alice',
      ),
    ).rejects.toMatchObject({
      status: 400,
      reason: 'document_ref_invalid',
    } satisfies Partial<DocumentRefAccessError>);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });
});
