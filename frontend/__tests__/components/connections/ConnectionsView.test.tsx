import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ConnectionsView } from '@/components/connections/ConnectionsView';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  setActiveView: vi.fn(),
}));

vi.mock('@/utils/app/api', () => ({
  apiGet: mocks.apiGet,
}));

vi.mock('@/state/uiSettingsStore', () => ({
  useUISettingsStore: (selector: (state: any) => unknown) =>
    selector({ setActiveView: mocks.setActiveView }),
}));

vi.mock('@/components/primitives', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Badge: ({ children }: any) => <span>{children}</span>,
}));

vi.mock('@/components/surfaces', () => ({
  GlassCard: ({ children }: any) => <div>{children}</div>,
}));

async function renderView(): Promise<{
  root: Root;
  container: HTMLDivElement;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionsView />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { root, container };
}

describe('ConnectionsView authorization semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.apiGet.mockResolvedValue({
      connections: [
        {
          id: 'gmail',
          label: 'Gmail',
          description: 'Search mail.',
          authorizationSaved: true,
        },
        {
          id: 'calendar',
          label: 'Google Calendar',
          description: 'Read calendars.',
          authorizationSaved: false,
        },
      ],
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('labels Redis token presence as saved and unverified', async () => {
    const { root, container } = await renderView();

    expect(container.textContent).toContain(
      '1 of 2 services have saved authorization',
    );
    expect(container.textContent).toContain('Saved, unverified');
    expect(container.textContent).toContain('No saved authorization');
    expect(container.textContent).toContain(
      'A saved record does not mean Google will still accept it.',
    );
    expect(container.textContent).not.toContain('services authorized');
    expect(container.textContent).not.toContain('Authorization saved');

    act(() => root.unmount());
  });
});
