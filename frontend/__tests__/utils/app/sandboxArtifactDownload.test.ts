import {
  downloadFilename,
  fetchSandboxArtifact,
  isSandboxArtifactDownloadUrl,
} from '@/utils/app/sandboxArtifactDownload';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sandbox artifact downloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recognizes only owner-scoped sandbox document links', () => {
    expect(
      isSandboxArtifactDownloadUrl(
        '/api/session/documentStorage?documentId=doc-1&sessionId=sandbox-session-1',
      ),
    ).toBe(true);
    expect(
      isSandboxArtifactDownloadUrl(
        '/api/session/documentStorage?documentId=doc-1&sessionId=session-1',
      ),
    ).toBe(false);
    expect(
      isSandboxArtifactDownloadUrl(
        'https://attacker.example/api/session/documentStorage?documentId=doc-1&sessionId=sandbox-session-1',
      ),
    ).toBe(false);
  });

  it('retries a transient miss without using the browser HTTP cache', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Document not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('ready', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    const wait = vi.fn().mockResolvedValue(undefined);

    const response = await fetchSandboxArtifact('/artifact', {
      retryDelaysMs: [25],
      wait,
    });

    expect(await response.text()).toBe('ready');
    expect(wait).toHaveBeenCalledWith(25, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/artifact',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
      }),
    );
  });

  it('retries a transient network failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network interrupted'))
      .mockResolvedValueOnce(new Response('ready', { status: 200 }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      fetchSandboxArtifact('/artifact', {
        retryDelaysMs: [50],
        wait,
      }),
    ).resolves.toBeInstanceOf(Response);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(50, undefined);
  });

  it('uses the UTF-8 attachment filename and sanitizes unsafe separators', () => {
    expect(
      downloadFilename(
        `attachment; filename="fallback.html"; filename*=UTF-8''daily%20summary.html`,
      ),
    ).toBe('daily summary.html');
    expect(downloadFilename('attachment; filename="../report.html"')).toBe(
      '.._report.html',
    );
  });
});
