import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import Home from '@/pages/index';

import { useConversationStore } from '@/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shellRenders: 0,
  webSocketOptions: null as any,
  history: [] as any[],
  selection: null as any,
  records: {} as Record<string, any>,
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
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
vi.mock('@/utils/app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/app/api')>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
  apiPost: mocks.apiPost,
}));

const conversation = (id: string, extra: Record<string, any> = {}) => ({
  id,
  name: id,
  folderId: null,
  messages: [],
  ...extra,
});

async function renderHome() {
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(<Home />);
  });
  await act(async () => {});
  return root;
}

const selectionWrites = () =>
  mocks.apiPut.mock.calls
    .filter(([path]) => path === '/api/session/selectedConversation')
    .map(([, body]) => body);

describe('Home', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.shellRenders = 0;
    mocks.history = [];
    mocks.selection = null;
    mocks.records = {};
    vi.clearAllMocks();
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/session/conversationHistory') return mocks.history;
      if (path === '/api/session/selectedConversation') return mocks.selection;
      const id = decodeURIComponent(path.split('/').pop() || '');
      if (mocks.records[id]) return mocks.records[id];
      throw new Error(`Unexpected GET ${path}`);
    });
    mocks.apiPut.mockResolvedValue(undefined);
    mocks.apiPost.mockResolvedValue({ success: true });
    sessionStorage.clear();
    localStorage.clear();
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      streamingConversationIds: new Set(),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['update', 'delete'])(
    'preserves a concurrent %s when initial history fails and falls back to cache',
    async (event) => {
      sessionStorage.setItem(
        'user:anon:conversationHistory',
        JSON.stringify([conversation('conv-a', { revision: 'r2' })]),
      );
      let rejectInitial!: (error: Error) => void;
      mocks.apiGet.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectInitial = reject;
          }),
      );
      const root = await renderHome();
      try {
        await act(async () => {
          if (event === 'update') {
            mocks.webSocketOptions.onConversationUpdated({
              conversation: conversation('conv-a', { revision: 'r3' }),
            });
          } else {
            mocks.webSocketOptions.onConversationDeleted('conv-a');
          }
        });
        await act(async () => rejectInitial(new Error('History unavailable')));
        const stored = useConversationStore
          .getState()
          .conversations.find(({ id }) => id === 'conv-a');
        if (event === 'update') expect(stored?.revision).toBe('r3');
        else expect(stored).toBeUndefined();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('ignores a superseded initial history failure after later sync events', async () => {
    let rejectInitial!: (error: Error) => void;
    mocks.apiGet.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectInitial = reject;
        }),
    );
    const root = await renderHome();
    try {
      mocks.history = [conversation('conv-a', { revision: 'r2' })];
      await act(async () => mocks.webSocketOptions.onConnected());
      await act(async () =>
        mocks.webSocketOptions.onConversationUpdated({
          conversation: conversation('conv-a', { revision: 'r3' }),
        }),
      );
      await act(async () => rejectInitial(new Error('Old request failed')));
      expect(
        useConversationStore
          .getState()
          .conversations.find(({ id }) => id === 'conv-a')?.revision,
      ).toBe('r3');
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['success', 'failure'])(
    'waits for a newer history refresh before restoring the selection after initial %s',
    async (initialOutcome) => {
      sessionStorage.setItem(
        'user:anon:selectedConversation',
        JSON.stringify({ id: 'conv-a' }),
      );
      let resolveInitial!: (value: any) => void;
      let rejectInitial!: (error: Error) => void;
      let resolveRefresh!: (value: any) => void;
      mocks.apiGet
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              resolveInitial = resolve;
              rejectInitial = reject;
            }),
        )
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveRefresh = resolve)),
        );
      const root = await renderHome();
      try {
        act(() => mocks.webSocketOptions.onConnected());
        await act(async () => {
          if (initialOutcome === 'success') resolveInitial([]);
          else rejectInitial(new Error('Old history request failed'));
        });
        // A reconnect read superseded the initial request. Its pending result
        // must not make the saved selection look like a deleted conversation.
        expect(
          useConversationStore.getState().selectedConversationId,
        ).toBeNull();
        expect(
          JSON.parse(sessionStorage.getItem('user:anon:selectedConversation')!),
        ).toEqual({ id: 'conv-a' });
        await act(async () => resolveRefresh([conversation('conv-a')]));
        expect(useConversationStore.getState().selectedConversationId).toBe(
          'conv-a',
        );
        expect(selectionWrites()).toEqual([]);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('keeps waiting when another history refresh supersedes selection restoration', async () => {
    sessionStorage.setItem(
      'user:anon:selectedConversation',
      JSON.stringify({ id: 'conv-a' }),
    );
    const resolvers: ((value: any) => void)[] = [];
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/session/conversationHistory') {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      if (path === '/api/session/selectedConversation') return null;
      throw new Error(`Unexpected GET ${path}`);
    });
    const root = await renderHome();
    try {
      act(() => mocks.webSocketOptions.onConnected());
      await act(async () => resolvers[0]([]));
      act(() => mocks.webSocketOptions.onConnected());
      await act(async () => resolvers[1]([]));
      expect(useConversationStore.getState().selectedConversationId).toBeNull();
      await act(async () => resolvers[2]([conversation('conv-a')]));
      expect(useConversationStore.getState().selectedConversationId).toBe(
        'conv-a',
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not restore a selection after unmounting during the replacement history read', async () => {
    const resolvers: ((value: any) => void)[] = [];
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/session/conversationHistory') {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      if (path === '/api/session/selectedConversation') return { id: 'conv-a' };
      throw new Error(`Unexpected GET ${path}`);
    });
    const root = await renderHome();
    act(() => mocks.webSocketOptions.onConnected());
    await act(async () => resolvers[0]([]));
    act(() => root.unmount());
    await act(async () => resolvers[1]([conversation('conv-a')]));
    expect(useConversationStore.getState().selectedConversationId).toBeNull();
    expect(useConversationStore.getState().conversations).toEqual([]);
  });

  it.each(['updated', 'deleted'] as const)(
    'uses the initial history if its replacement fails without losing a concurrent %s event',
    async (event) => {
      sessionStorage.setItem(
        'user:anon:selectedConversation',
        JSON.stringify({ id: 'conv-b' }),
      );
      let resolveInitial!: (value: any) => void;
      let rejectRefresh!: (error: Error) => void;
      mocks.apiGet
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveInitial = resolve)),
        )
        .mockImplementationOnce(
          () => new Promise((_resolve, reject) => (rejectRefresh = reject)),
        );
      const root = await renderHome();
      try {
        act(() => mocks.webSocketOptions.onConnected());
        act(() => {
          if (event === 'updated') {
            mocks.webSocketOptions.onConversationUpdated({
              conversation: conversation('conv-a', { revision: 'r3' }),
            });
          } else {
            mocks.webSocketOptions.onConversationDeleted('conv-a');
          }
        });
        await act(async () =>
          resolveInitial([
            conversation('conv-a', { revision: 'r1' }),
            conversation('conv-b'),
          ]),
        );
        await act(async () => rejectRefresh(new Error('Refresh unavailable')));
        const state = useConversationStore.getState();
        expect(state.selectedConversationId).toBe('conv-b');
        const saved = state.conversations.find(({ id }) => id === 'conv-a');
        if (event === 'updated') expect(saved?.revision).toBe('r3');
        else expect(saved).toBeUndefined();
      } finally {
        act(() => root.unmount());
      }
    },
  );

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
        conversationId: 'conv-2',
        conversation: {
          id: 'conv-2',
          name: 'From another device',
          folderId: null,
          messages: [],
          updatedAt: 1,
        },
      });
    });
    expect(
      useConversationStore
        .getState()
        .conversations.some((conversation) => conversation.id === 'conv-2'),
    ).toBe(true);
    act(() => root.unmount());
  });

  it('opens a new conversation when the saved selection was deleted elsewhere', async () => {
    // Server history no longer has conv-deleted and its deletion cleared the
    // server selection; this tab's session cache still names it.
    mocks.history = [conversation('conv-kept')];
    sessionStorage.setItem(
      'user:anon:selectedConversation',
      JSON.stringify(conversation('conv-deleted', { name: 'gone' })),
    );
    const root = await renderHome();

    const state = useConversationStore.getState();
    expect(state.selectedConversationId).not.toBe('conv-deleted');
    expect(
      state.conversations.some(({ id }) => id === state.selectedConversationId),
    ).toBe(true);
    // This tab remembers the replacement; the server pointer is left for an
    // explicit choice.
    expect(
      JSON.parse(sessionStorage.getItem('user:anon:selectedConversation')!),
    ).toEqual({ id: state.selectedConversationId });
    expect(selectionWrites()).toEqual([]);
    act(() => root.unmount());
  });

  it('reopens a saved selection that history still contains', async () => {
    mocks.history = [conversation('conv-a'), conversation('conv-b')];
    // Older servers stored a full copy; only its id is used.
    mocks.selection = conversation('conv-b', {
      messages: [{ id: 'old', role: 'user', content: 'stale copy' }],
    });
    const root = await renderHome();

    expect(useConversationStore.getState().selectedConversationId).toBe(
      'conv-b',
    );
    expect(
      useConversationStore
        .getState()
        .conversations.find(({ id }) => id === 'conv-b')!.messages,
    ).toEqual([]);
    expect(selectionWrites()).toEqual([]);
    act(() => root.unmount());
  });

  it('remembers each selection in this tab as an id', async () => {
    mocks.history = [conversation('conv-a'), conversation('conv-b')];
    mocks.selection = { id: 'conv-a' };
    const root = await renderHome();

    // For example the reselection after a deletion: the user's own choices
    // are saved on the server where they are made (Sidebar, new chat).
    await act(async () => {
      useConversationStore.getState().selectConversation('conv-b');
    });

    expect(
      JSON.parse(sessionStorage.getItem('user:anon:selectedConversation')!),
    ).toEqual({ id: 'conv-b' });
    expect(selectionWrites()).toEqual([]);
    act(() => root.unmount());
  });

  it('reads a conversation another session announced by id and revision', async () => {
    mocks.history = [conversation('conv-a', { revision: 'r1' })];
    mocks.records['conv-a'] = conversation('conv-a', {
      revision: 'r2',
      messages: [{ id: 'm1', role: 'user', content: 'from another device' }],
    });
    const root = await renderHome();
    const reads = () =>
      mocks.apiGet.mock.calls.filter(
        ([path]) => path === '/api/conversations/conv-a',
      ).length;

    // A copy that already holds that revision (this tab's own save) is kept.
    await act(async () => {
      mocks.webSocketOptions.onConversationUpdated({
        conversationId: 'conv-a',
        revision: 'r1',
      });
    });
    expect(reads()).toBe(0);

    await act(async () => {
      mocks.webSocketOptions.onConversationUpdated({
        conversationId: 'conv-a',
        revision: 'r2',
      });
    });
    const adopted = useConversationStore
      .getState()
      .conversations.find(({ id }) => id === 'conv-a') as any;
    expect(reads()).toBe(1);
    expect(adopted.revision).toBe('r2');
    expect(adopted.messages).toHaveLength(1);

    // A streaming conversation stays under this tab's control.
    useConversationStore.getState().setStreaming('conv-a', true);
    await act(async () => {
      mocks.webSocketOptions.onConversationUpdated({
        conversationId: 'conv-a',
        revision: 'r3',
      });
    });
    expect(reads()).toBe(1);
    act(() => root.unmount());
  });

  it('removes a conversation deleted in another session', async () => {
    mocks.history = [conversation('conv-a'), conversation('conv-b')];
    mocks.selection = { id: 'conv-b' };
    const root = await renderHome();

    await act(async () => {
      mocks.webSocketOptions.onConversationDeleted('conv-b');
    });

    const state = useConversationStore.getState();
    expect(state.conversations.map(({ id }) => id)).toEqual(['conv-a']);
    expect(state.selectedConversationId).toBe('conv-a');
    act(() => root.unmount());
  });

  it.each(['updated', 'deleted'] as const)(
    'discards a delayed sync read after the conversation is %s again',
    async (event) => {
      mocks.history = [conversation('conv-a', { revision: 'r1' })];
      const root = await renderHome();
      let resolveRead!: (value: any) => void;
      mocks.apiGet.mockImplementationOnce(
        () => new Promise((resolve) => (resolveRead = resolve)),
      );
      act(() => {
        mocks.webSocketOptions.onConversationUpdated({
          conversationId: 'conv-a',
          revision: 'r2',
        });
      });

      act(() => {
        if (event === 'deleted') {
          mocks.webSocketOptions.onConversationDeleted('conv-a');
        } else {
          mocks.webSocketOptions.onConversationUpdated({
            conversationId: 'conv-a',
            conversation: conversation('conv-a', { revision: 'r3' }),
          });
        }
      });
      await act(async () => {
        resolveRead(conversation('conv-a', { revision: 'r2' }));
      });
      const saved = useConversationStore
        .getState()
        .conversations.find(({ id }) => id === 'conv-a');
      if (event === 'deleted') expect(saved).toBeUndefined();
      else expect(saved?.revision).toBe('r3');
      act(() => root.unmount());
    },
  );

  it.each(['updated', 'deleted'] as const)(
    'preserves a conversation %s during a history refresh',
    async (event) => {
      mocks.history = [
        conversation('conv-a', { revision: 'r1' }),
        conversation('conv-b'),
      ];
      mocks.selection = { id: 'conv-b' };
      const root = await renderHome();
      let resolveRead!: (value: any) => void;
      mocks.apiGet.mockImplementationOnce(
        () => new Promise((resolve) => (resolveRead = resolve)),
      );
      act(() => mocks.webSocketOptions.onConnected());
      act(() => {
        if (event === 'deleted') {
          mocks.webSocketOptions.onConversationDeleted('conv-a');
        } else {
          mocks.webSocketOptions.onConversationUpdated({
            conversationId: 'conv-a',
            conversation: conversation('conv-a', { revision: 'r3' }),
          });
        }
      });
      await act(async () => {
        resolveRead([
          conversation('conv-a', { revision: 'r2' }),
          conversation('conv-b'),
          conversation('conv-c'),
        ]);
      });
      const conversations = useConversationStore.getState().conversations;
      const saved = conversations.find(({ id }) => id === 'conv-a');
      if (event === 'deleted') expect(saved).toBeUndefined();
      else expect(saved?.revision).toBe('r3');
      // Unrelated records discovered by the refresh are still adopted.
      expect(conversations.some(({ id }) => id === 'conv-c')).toBe(true);
      act(() => root.unmount());
    },
  );

  it('keeps a long-running job tracked when the page loads', async () => {
    // The job status outlives its last update by an hour, so a running job
    // can be older than that. useAsyncChat owns this record.
    const jobs = [
      {
        jobId: 'job-long',
        conversationId: 'conv-a',
        userId: 'alice',
        timestamp: Date.now() - 2 * 60 * 60 * 1000,
      },
    ];
    localStorage.setItem('asyncJobs_alice', JSON.stringify(jobs));
    const root = await renderHome();

    expect(JSON.parse(localStorage.getItem('asyncJobs_alice')!)).toEqual(jobs);
    act(() => root.unmount());
  });
});
