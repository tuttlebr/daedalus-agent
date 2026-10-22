import { IconRefresh } from '@tabler/icons-react';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  ToolbarButton,
  ToolbarGroup,
  ToolbarItems,
  ToolbarSlotProvider,
  ViewProvider,
} from '@/components/layout/ToolbarSlot';

import { useUISettingsStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('destination toolbar items', () => {
  let root: Root;
  let page: HTMLDivElement;
  let toolbar: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useUISettingsStore.setState({ activeView: 'memory' });
    page = document.body.appendChild(document.createElement('div'));
    toolbar = document.body.appendChild(document.createElement('div'));
    root = createRoot(page);
  });

  afterEach(() => {
    act(() => root.unmount());
    page.remove();
    toolbar.remove();
    vi.unstubAllGlobals();
  });

  const refresh = (
    <ToolbarButton icon={<IconRefresh />} label="Refresh" onClick={() => {}} />
  );

  function render(
    slot: HTMLElement | null,
    view: 'memory' | 'chat',
    children: ReactNode = refresh,
  ) {
    act(() =>
      root.render(
        <ToolbarSlotProvider value={slot}>
          <ViewProvider value={view}>
            <ToolbarItems>{children}</ToolbarItems>
          </ViewProvider>
        </ToolbarSlotProvider>,
      ),
    );
  }

  it('keeps controls in the page while the toolbar is hidden', () => {
    render(null, 'memory');
    const button = page.querySelector('[aria-label="Refresh"]');
    expect(button).not.toBeNull();
    expect(button!.className).not.toContain('app-chrome');
    expect(toolbar.childElementCount).toBe(0);
  });

  it("moves the shown destination's controls into the toolbar as glass", () => {
    render(toolbar, 'memory');
    expect(page.querySelector('[aria-label="Refresh"]')).toBeNull();
    const button = toolbar.querySelector('[aria-label="Refresh"]');
    expect(button!.className).toContain('app-chrome');
    expect(button!.className).toContain('app-toolbar-button');
  });

  it('leaves the toolbar to the destination on screen', () => {
    render(toolbar, 'chat');
    expect(toolbar.querySelector('[aria-label="Refresh"]')).toBeNull();
    expect(page.querySelector('[aria-label="Refresh"]')).toBeNull();
  });

  it('lets a group supply the glass for its controls', () => {
    render(
      toolbar,
      'memory',
      <ToolbarGroup label="Commands">{refresh}</ToolbarGroup>,
    );
    const group = toolbar.querySelector('[role="group"]');
    expect(group!.getAttribute('aria-label')).toBe('Commands');
    expect(group!.className).toContain('app-toolbar-group');
    const button = group!.querySelector('[aria-label="Refresh"]');
    expect(button!.className).toContain('app-toolbar-item');
    expect(button!.className).not.toContain('app-chrome');
  });
});
