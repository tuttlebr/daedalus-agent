import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ImagesDock } from '@/components/images/ImagesDock';

import { useImagePanelStore } from '@/state/imagePanelStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useMediaQuery', () => ({
  useIsMobile: () => true,
}));

vi.mock('@/components/chat/OptimizedImage', () => ({
  OptimizedImage: () => <div data-testid="edit-thumbnail" />,
}));

describe('mobile Create dock', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    useImagePanelStore.setState({
      mode: 'edit',
      prompt: '',
      inputImages: [],
      maskImage: null,
      loading: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('keeps edit assets in a dedicated row and consolidates adjustments', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => root.render(<ImagesDock onSubmit={vi.fn()} />));

    const assetsRow = container.querySelector('[data-mobile-edit-assets]');
    const actionsRow = container.querySelector('[data-create-actions]');
    expect(assetsRow).not.toBeNull();
    expect(actionsRow).not.toBeNull();
    expect(assetsRow?.textContent).toContain('Add image');
    expect(assetsRow?.textContent).toContain(
      'Required before applying an edit',
    );
    expect(actionsRow?.textContent).toContain('Adjust');
    expect(actionsRow?.textContent).toContain('Apply edit');
    expect(actionsRow?.textContent).not.toContain('Add image');

    act(() => root.unmount());
  });
});
