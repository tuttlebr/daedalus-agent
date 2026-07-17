import {
  assertDocumentEncodedSize,
  uploadDocument,
} from '@/utils/app/documentHandler';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('documentHandler encoded-size guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('measures only the data URL payload', () => {
    expect(() =>
      assertDocumentEncodedSize('data:application/pdf;base64,AAAA', 'a.pdf', 4),
    ).not.toThrow();
  });

  it('can reject before fetch and JSON serialization', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => assertDocumentEncodedSize('AAAAA', 'large.pdf', 4)).toThrow(
      'exceeds the server upload limit',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue({
      headers: { get: () => 'application/json' },
      ok: true,
      json: async () => ({
        documentId: 'doc-1',
        sessionId: 'session-1',
        userId: 'alice',
      }),
      status: 200,
    });
    await uploadDocument('AAAA', 'small.txt', 'text/plain');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
