import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

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
    vi.clearAllMocks();
  });

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
