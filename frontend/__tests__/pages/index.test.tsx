import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import Home from '@/pages/index';

import { useConversationStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shellRenders: 0,
  webSocketOptions: null as any,
}));

vi.mock('@/components/auth', () => ({
  useAuth: () => ({ user: { username: 'alice' } }),
  ProtectedRoute: ({ children }: any) => children,
}));
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (options: any) => {
    mocks.webSocketOptions = options;
  },
}));
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: any) => {
    mocks.shellRenders += 1;
    return children;
  },
  ViewTabs: () => null,
}));
vi.mock('@/components/sidebar/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/mobile/BottomNav', () => ({ BottomNav: () => null }));
vi.mock('@/components/chat/ChatView', () => ({ ChatView: () => null }));
vi.mock('@/components/autonomy', () => ({ AutonomyDashboard: () => null }));
vi.mock('@/components/connections', () => ({ ConnectionsView: () => null }));
vi.mock('@/components/images', () => ({ ImagePanel: () => null }));
vi.mock('@/components/memory', () => ({ MemoryCenter: () => null }));
vi.mock('@/utils/app/api', () => ({
  apiGet: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/utils/app/conversation', () => ({
  loadConversation: vi.fn().mockResolvedValue(null),
  saveConversation: vi.fn(),
}));

describe('Home', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.shellRenders = 0;
    useConversationStore.getState().clearConversations();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not re-render the app shell for streamed message updates', async () => {
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(<Home />);
    });
    const store = useConversationStore.getState();
    await act(async () => {
      store.addConversation({
        id: 'conv-1',
        name: 'Streaming',
        folderId: null,
        messages: [{ id: 'assistant-1', role: 'assistant', content: '' }],
      });
      store.setStreaming('conv-1', true);
    });
    const rendersBeforeStream = mocks.shellRenders;

    // Each streamed flush replaces the conversations array.
    for (const content of ['Hel', 'Hello', 'Hello!']) {
      await act(async () => {
        store.updateMessage('conv-1', 'assistant-1', { content });
      });
    }
    expect(mocks.shellRenders).toBe(rendersBeforeStream);

    // Sync handlers still compare with the current store contents.
    await act(async () => {
      mocks.webSocketOptions.onConversationUpdated({
        id: 'conv-2',
        name: 'From another device',
        folderId: null,
        messages: [],
        updatedAt: 1,
      });
    });
    expect(
      useConversationStore
        .getState()
        .conversations.some((conversation) => conversation.id === 'conv-2'),
    ).toBe(true);
    act(() => root.unmount());
  });
});
