import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { uploadDocument } from '@/utils/app/documentHandler';
import { saveArtifactBlob } from '@/utils/app/sandboxArtifactDownload';

import { ChatInput } from '@/components/chat/ChatInput';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'loading-toast'),
    success: vi.fn(),
  });

  return { toast };
});

vi.mock('react-hot-toast', () => ({ default: mocks.toast }));

vi.mock('@/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/utils/app/queries', () => ({
  useMilvusCollections: () => ({ data: [] }),
}));

vi.mock('@/utils/app/documentHandler', () => ({
  uploadDocument: vi.fn(),
}));

vi.mock('@/utils/app/imageHandler', () => ({
  uploadImage: vi.fn(),
}));

vi.mock('@/utils/app/videoHandler', () => ({
  getVideoMimeType: vi.fn(),
  uploadVideo: vi.fn(),
}));

vi.mock('@/utils/app/sandboxArtifactDownload', () => ({
  saveArtifactBlob: vi.fn(),
}));

describe('ChatInput inline document download', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(uploadDocument).mockResolvedValue({
      documentId: 'doc-1',
      sessionId: 'session-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reveals a full Markdown download after Read inline is selected', async () => {
    const onSend = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<ChatInput onSend={onSend} />);
    });

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Expected the chat file input');
    const documentFile = new File(['%PDF-test'], 'report.pdf', {
      type: 'application/pdf',
    });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [documentFile],
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const select = container.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Expected the document mode selector');
    expect(container.textContent).not.toContain('Download full Markdown');

    await act(async () => {
      select.value = '__inline__';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain(
      'The full Markdown download stays outside chat and history.',
    );
    const downloadButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Download full Markdown'));
    if (!downloadButton)
      throw new Error('Expected the Markdown download button');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# Complete document\n', {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="report.md"',
          'Content-Type': 'text/markdown; charset=utf-8',
        },
      }),
    );

    await act(async () => {
      downloadButton.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/document/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentRef: {
          documentId: 'doc-1',
          sessionId: 'session-1',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
        },
        filename: 'report.pdf',
      }),
    });
    const [savedBlob, savedFilename] =
      vi.mocked(saveArtifactBlob).mock.calls[0];
    expect(savedFilename).toBe('report.md');
    expect(await savedBlob.text()).toBe('# Complete document\n');
    expect(onSend).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
