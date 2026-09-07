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

  it('opens a native modal, handles cancellation, and restores scroll', () => {
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
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      document
        .querySelector('dialog')!
        .dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <ModalSurface open={false} onClose={onClose} aria-label="Adjust image">
          <button type="button">Done</button>
        </ModalSurface>,
      );
    });

    expect(document.querySelector('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });
});
