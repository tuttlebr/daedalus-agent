import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { AutonomyDashboard } from '@/components/autonomy/AutonomyDashboard';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  wsConnected: true,
  wsOptions: null as any,
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn((options: any) => {
    mocks.wsOptions = options;
    return {
      isConnected: mocks.wsConnected,
      connect: vi.fn(),
      disconnect: vi.fn(),
      streamingStates: {},
      subscribeToJob: vi.fn(),
      unsubscribeFromJob: vi.fn(),
      subscribeToChat: vi.fn(),
      unsubscribeFromChat: vi.fn(),
    };
  }),
}));

vi.mock('@/components/autonomy/ApprovalBanner', () => ({
  ApprovalBanner: () => <div data-testid="approvals" />,
}));

vi.mock('@/components/autonomy/AutonomyFeed', () => ({
  AutonomyFeed: () => <div data-testid="feed" />,
}));

vi.mock('@/components/autonomy/StatusStrip', () => ({
  StatusStrip: React.forwardRef(() => <div data-testid="status" />),
}));

vi.mock('@/components/autonomy/WorkspaceDrawer', () => ({
  WorkspaceDrawer: () => <div data-testid="workspace" />,
}));

function responseBody(url: string): unknown {
  if (url.endsWith('/config')) return {};
  return [];
}

function renderDashboard(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<AutonomyDashboard />));
  return { root, container };
}

async function flushRequests(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requestedUrls(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url]) => String(url));
}

describe('AutonomyDashboard refresh strategy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.wsConnected = true;
    mocks.wsOptions = null;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return {
          ok: true,
          json: async () => responseBody(url),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('stops interval polling while connected and coalesces targeted WS refreshes', async () => {
    const { root } = renderDashboard();
    await flushRequests();
    vi.mocked(fetch).mockClear();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(fetch).not.toHaveBeenCalled();

    act(() => {
      mocks.wsOptions.onAutonomyFeedUpdated({});
      mocks.wsOptions.onAutonomyFeedUpdated({});
      mocks.wsOptions.onAutonomyApprovalRequested({});
    });
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestedUrls().sort()).toEqual(
      ['/api/autonomy/approvals', '/api/autonomy/feed'].sort(),
    );

    act(() => root.unmount());
  });

  it('retains the full interval refresh as a disconnected fallback', async () => {
    mocks.wsConnected = false;
    const { root } = renderDashboard();
    await flushRequests();
    vi.mocked(fetch).mockClear();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestedUrls().sort()).toEqual(
      [
        '/api/autonomy/approvals',
        '/api/autonomy/config',
        '/api/autonomy/feed',
        '/api/autonomy/goals',
        '/api/autonomy/queue',
        '/api/autonomy/runs',
      ].sort(),
    );

    act(() => root.unmount());
  });
});
