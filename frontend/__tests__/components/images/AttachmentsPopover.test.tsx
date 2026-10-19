import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { uploadImage } from '@/utils/app/imageHandler';

import { EditAssetsPanel } from '@/components/images/AttachmentsPopover';

import { useImagePanelStore } from '@/state/imagePanelStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/chat/OptimizedImage', () => ({
  OptimizedImage: () => <div data-testid="input-preview" />,
}));

vi.mock('@/utils/app/imageHandler', () => ({
  uploadImage: vi.fn(),
}));

describe('Create image attachments', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useImagePanelStore.setState({
      inputImages: [],
      maskImage: null,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([1, 1024 * 1024 - 1, null])(
    'checks every pixel when validating a PNG mask (transparent pixel: %s)',
    async (transparentPixel) => {
      const pixels = new Uint8ClampedArray(1024 * 1024 * 4).fill(255);
      if (transparentPixel !== null) pixels[transparentPixel * 4 + 3] = 0;
      vi.stubGlobal(
        'Image',
        class {
          naturalWidth = 1024;
          naturalHeight = 1024;
          onload?: () => void;
          set src(_value: string) {
            queueMicrotask(() => this.onload?.());
          }
        },
      );
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mask');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
        getImageData: () => ({ data: pixels }),
      } as unknown as CanvasRenderingContext2D);
      vi.mocked(uploadImage).mockResolvedValue({
        imageId: 'mask',
        sessionId: 'session',
        mimeType: 'image/png',
      });
      useImagePanelStore.setState({
        inputImages: [
          {
            imageId: 'source',
            sessionId: 'session',
            mimeType: 'image/png',
            width: 1024,
            height: 1024,
          },
        ],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<EditAssetsPanel />));
        const input = container.querySelector<HTMLInputElement>(
          'input[accept="image/png"]',
        )!;
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: [
            new File(['synthetic-png'], 'mask.png', { type: 'image/png' }),
          ],
        });
        await act(async () => {
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await vi.waitFor(async () => {
          await act(async () => {});
          if (transparentPixel === null) {
            expect(container.textContent).toContain(
              'Mask must include transparent pixels.',
            );
          } else {
            expect(useImagePanelStore.getState().maskImage).toMatchObject({
              imageId: 'mask',
              hasAlpha: true,
            });
          }
        });
        expect(uploadImage).toHaveBeenCalledTimes(
          transparentPixel === null ? 0 : 1,
        );
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('rejects an image over 30 MiB before reading or uploading it', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<EditAssetsPanel />);
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][multiple]',
    );
    expect(input).not.toBeNull();
    if (!input) throw new Error('Expected the Create image file input');
    const oversized = {
      name: 'oversized.png',
      type: 'image/png',
      size: 31 * 1024 * 1024,
    } as File;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [oversized],
    });

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(uploadImage).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'exceeds maximum allowed size (30.0 MB)',
    );
    expect(container.textContent).toContain(
      'Up to 30 MB each; full resolution is preserved.',
    );

    act(() => root.unmount());
  });
});
