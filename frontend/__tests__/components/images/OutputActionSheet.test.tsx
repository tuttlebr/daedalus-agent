import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { OutputActionSheet } from '@/components/images/OutputActionSheet';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/chat/OptimizedImage', () => ({
  OptimizedImage: () => <div data-testid="output-preview" />,
}));

const image = {
  imageId: '7f4e6e7a-9176-4b69-aed7-56a8018b3e5a',
  prompt: 'A bright product photograph',
  mode: 'generate' as const,
  model: 'gpt-image-2' as const,
  params: { output_format: 'png' as const },
  createdAt: 1,
};

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof OutputActionSheet>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    open: true,
    image,
    onClose: vi.fn(),
    onReuseAsInput: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };

  act(() => {
    root.render(<OutputActionSheet {...props} />);
  });

  return { container, root, props };
}

describe('OutputActionSheet', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('centralizes actions and uses the direct server download URL', () => {
    const { container, root } = renderSheet();

    expect(container.textContent).toContain('Selected image');
    expect(container.textContent).toContain('Continue editing');
    expect(container.textContent).toContain('Remove from workspace');

    const download = Array.from(container.querySelectorAll('a')).find((link) =>
      link.textContent?.includes('Download'),
    );
    expect(download?.getAttribute('href')).toBe(
      `/api/generated-image/${image.imageId}?download=1`,
    );

    act(() => root.unmount());
  });

  it('turns reuse into an edit input and closes the sheet', () => {
    const onReuseAsInput = vi.fn();
    const onClose = vi.fn();
    const { container, root } = renderSheet({ onReuseAsInput, onClose });
    const reuse = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Continue editing'),
    );

    act(() => {
      reuse?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onReuseAsInput).toHaveBeenCalledWith({
      imageId: image.imageId,
      sessionId: 'generated',
      mimeType: 'image/png',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('preserves the generated output format when it becomes an edit input', () => {
    const onReuseAsInput = vi.fn();
    const { container, root } = renderSheet({
      image: { ...image, params: { output_format: 'webp' } },
      onReuseAsInput,
    });
    const reuse = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Continue editing'),
    );

    act(() => {
      reuse?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onReuseAsInput).toHaveBeenCalledWith({
      imageId: image.imageId,
      sessionId: 'generated',
      mimeType: 'image/webp',
    });

    act(() => root.unmount());
  });
});
