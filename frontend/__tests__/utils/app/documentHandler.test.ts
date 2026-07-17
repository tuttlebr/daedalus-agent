import {
  assertDocumentFileSize,
  uploadDocument,
} from '@/utils/app/documentHandler';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('documentHandler multipart upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an oversized raw file before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['12345'], 'large.pdf', {
      type: 'application/pdf',
    });

    expect(() => assertDocumentFileSize(file, 4)).toThrow(
      'exceeds the server upload limit',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the File in FormData without JSON or a manual content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      headers: { get: () => 'application/json' },
      ok: true,
      json: async () => ({
        documentId: 'doc-1',
        sessionId: 'session-1',
        userId: 'alice',
      }),
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF-test'], 'small.pdf', {
      type: 'application/pdf',
    });

    const result = await uploadDocument(file);

    expect(result).toMatchObject({
      documentId: 'doc-1',
      filename: 'small.pdf',
      mimeType: 'application/pdf',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toEqual({ 'X-Document-Size': String(file.size) });
    const uploaded = (init.body as FormData).get('file') as File;
    expect(uploaded.name).toBe(file.name);
    expect(uploaded.size).toBe(file.size);
  });
});
