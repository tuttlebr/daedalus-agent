import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ModalSurface } from '@/components/surfaces/ModalSurface';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ModalSurface', () => {
  let root: Root;
  let host: HTMLDivElement;
  let main: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    main = document.createElement('main');
    main.id = 'main-content';
    host = document.createElement('div');
    document.body.append(main, host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('isolates the background, closes on Escape, and restores the page', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <ModalSurface
          open
          onClose={onClose}
          position="bottom"
          aria-label="Adjust image"
        >
          <button type="button">Done</button>
        </ModalSurface>,
      );
      vi.runOnlyPendingTimers();
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector('[role="dialog"]')?.getAttribute('aria-label'),
    ).toBe('Adjust image');
    expect(main.inert).toBe(true);
    expect(main.getAttribute('aria-hidden')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <ModalSurface open={false} onClose={onClose} aria-label="Adjust image">
          <button type="button">Done</button>
        </ModalSurface>,
      );
    });

    expect(main.inert).toBe(false);
    expect(main.hasAttribute('aria-hidden')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });
});
