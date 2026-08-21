import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { BottomNav } from '@/components/mobile/BottomNav';

import { useUISettingsStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('BottomNav', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    useUISettingsStore.setState({ activeView: 'chat', showChatbar: false });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('contains only peer destinations', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<BottomNav />));

    const labels = Array.from(container.querySelectorAll('button')).map(
      (button) => button.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Chat',
      'Create',
      'Autonomy',
      'Memory',
      'Connections',
    ]);
    expect(container.textContent).not.toContain('New');
    expect(container.textContent).not.toContain('Menu');

    act(() => root.unmount());
  });

  it('collapses while the software keyboard is open', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<BottomNav keyboardOpen />));

    expect(container.querySelector('nav')).toBeNull();

    act(() => root.unmount());
  });
});
