// @vitest-environment node
import {
  assertDocumentFileSize,
  uploadDocument,
} from '@/utils/app/documentHandler';

import { UPLOAD_LIMITS } from '@/constants/uploadLimits';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WEBKIT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.2 Mobile/15E148 Safari/604.1';

function successfulFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    headers: { get: () => 'application/json' },
    ok: true,
    json: async () => ({ documentId: 'doc-1', sessionId: 'session-1' }),
    status: 200,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('documentHandler multipart upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects an oversized raw file before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = new File(['12345'], 'large.pdf', {
      type: 'application/pdf',
    });
    // Report the configured limit plus one byte without allocating it.
    Object.defineProperty(file, 'size', {
      value: UPLOAD_LIMITS.DOCUMENT_SERVER_LIMIT_BYTES + 1,
    });

    expect(() => assertDocumentFileSize(file, 4)).toThrow(
      'exceeds the server upload limit',
    );
    await expect(uploadDocument(file)).rejects.toThrow(
      'exceeds the server upload limit',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty selected document before fetch', async () => {
    const fetchMock = successfulFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(uploadDocument(new File([], 'empty.pdf'))).rejects.toThrow(
      'The selected document is empty',
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

  it('preserves an actionable JSON error returned by document storage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      headers: { get: () => 'application/json' },
      ok: false,
      json: async () => ({
        error:
          'Document storage credentials were rejected. Please contact an administrator.',
      }),
      status: 503,
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF-test'], 'small.pdf', {
      type: 'application/pdf',
    });

    await expect(uploadDocument(file)).rejects.toThrow(
      'Document storage credentials were rejected. Please contact an administrator.',
    );
  });

  describe('WebKit file upload compatibility', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', { userAgent: WEBKIT });
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it.each([
      WEBKIT,
      WEBKIT.replace('Version/27.2', 'CriOS/140.0.0.0'),
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.2 Safari/605.1.15',
    ])(
      'reads selected file bytes in the page before sending on %s',
      async (userAgent) => {
        vi.stubGlobal('navigator', { userAgent });
        const fetchMock = successfulFetch();
        const bytes = Buffer.from('%PDF-1.7\n\x00\xff\x80\n%%EOF', 'latin1');
        const file = new File([bytes], '文档.pdf', { type: 'application/pdf' });
        const read = vi.spyOn(file, 'arrayBuffer');
        const controller = new AbortController();

        await uploadDocument(file, controller.signal);

        expect(read).toHaveBeenCalledOnce();
        const [, init] = fetchMock.mock.calls[0];
        const uploaded = init.body.get('file') as File;
        expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(bytes);
        expect(uploaded.name).toBe(file.name);
        expect(uploaded.type).toBe(file.type);
        expect(init.headers).toEqual({
          'X-Document-Size': String(bytes.length),
        });
        expect(init.signal).toBe(controller.signal);
      },
    );

    it('keeps the direct file path for Chromium without a memory copy', async () => {
      vi.stubGlobal('navigator', {
        userAgent:
          'Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
      });
      successfulFetch();
      const file = new File(['%PDF-test'], 'paper.pdf');
      const read = vi.spyOn(file, 'arrayBuffer');

      await uploadDocument(file);

      expect(read).not.toHaveBeenCalled();
    });

    it('does not send an unreadable file as an empty request', async () => {
      const fetchMock = successfulFetch();
      const file = new File(['%PDF-test'], 'paper.pdf');
      vi.spyOn(file, 'arrayBuffer').mockRejectedValue(
        new DOMException('File unavailable', 'NotReadableError'),
      );

      await expect(uploadDocument(file)).rejects.toThrow(
        'Please select the file again',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an incomplete file read before fetch', async () => {
      const fetchMock = successfulFetch();
      const file = new File(['%PDF-test'], 'paper.pdf');
      vi.spyOn(file, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(0));

      await expect(uploadDocument(file)).rejects.toThrow(
        'Please select the file again',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('checks the size limit before copying file bytes', async () => {
      const fetchMock = successfulFetch();
      const file = new File(['%PDF-test'], 'large.pdf');
      Object.defineProperty(file, 'size', {
        value: UPLOAD_LIMITS.DOCUMENT_SERVER_LIMIT_BYTES + 1,
      });
      const read = vi.spyOn(file, 'arrayBuffer');

      await expect(uploadDocument(file)).rejects.toThrow(
        'exceeds the server upload limit',
      );
      expect(read).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not read or send a cancelled upload', async () => {
      const fetchMock = successfulFetch();
      const file = new File(['%PDF-test'], 'paper.pdf');
      const read = vi.spyOn(file, 'arrayBuffer');
      const controller = new AbortController();
      controller.abort();

      await expect(
        uploadDocument(file, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(read).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not send a file cancelled while its bytes were being read', async () => {
      const fetchMock = successfulFetch();
      const file = new File(['%PDF-test'], 'paper.pdf');
      const controller = new AbortController();
      vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
        controller.abort();
        return new ArrayBuffer(file.size);
      });

      await expect(
        uploadDocument(file, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
