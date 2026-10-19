import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { SplitPane } from '@/components/layout/SplitPane';

import { useUISettingsStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useMediaQuery', () => ({ useIsMobile: () => false }));
vi.mock('@/utils/app/storage', () => ({ setUserSessionItem: vi.fn() }));

describe('sidebar resize lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useUISettingsStore.setState({ showChatbar: true, chatbarWidth: 280 });
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it.each(['up', 'cancel', 'lost capture', 'hide', 'unmount'])(
    'restores the page styles after %s during a drag',
    (ending) => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      let mounted = true;
      const unmount = () => {
        if (mounted) act(() => root.unmount());
        mounted = false;
      };
      try {
        act(() => root.render(<SplitPane sidebar="Sidebar">Chat</SplitPane>));
        const handle =
          container.querySelector<HTMLElement>('[role="separator"]')!;
        const pointer = (name: string) =>
          act(() =>
            handle.dispatchEvent(new MouseEvent(name, { bubbles: true })),
          );
        let captured = false;
        handle.setPointerCapture = () => {
          captured = true;
        };
        handle.hasPointerCapture = () => captured;
        handle.releasePointerCapture = () => {
          captured = false;
        };
        pointer('pointerdown');
        expect(document.body.style.cursor).toBe('col-resize');
        expect(document.body.style.userSelect).toBe('none');
        if (ending === 'up') pointer('pointerup');
        else if (ending === 'cancel') pointer('pointercancel');
        else if (ending === 'lost capture') {
          captured = false;
          pointer('lostpointercapture');
        } else if (ending === 'hide') {
          act(() => useUISettingsStore.setState({ showChatbar: false }));
          act(() => useUISettingsStore.setState({ showChatbar: true }));
        } else unmount();
        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
      } finally {
        unmount();
        container.remove();
      }
    },
  );
});
