'use client';

import { useCallback, useEffect, useState, useRef } from 'react';

import { GetServerSideProps } from 'next';
import Head from 'next/head';

import {
  useKeyboardShortcuts,
  commonShortcuts,
} from '@/hooks/useKeyboardShortcuts';
import {
  AppVisualViewportContext,
  useVisualViewportKeyboard,
} from '@/hooks/useVisualViewportKeyboard';
import { useWebSocket } from '@/hooks/useWebSocket';

import { apiGet } from '@/utils/app/api';
import { cleanConversationHistory } from '@/utils/app/clean';
import {
  cachedSelectedConversationId,
  loadSelectedConversationId,
  persistSelectedConversation,
  rememberSelectedConversation,
  saveConversation,
} from '@/utils/app/conversation';
import {
  conversationRevision,
  withConversationRevision,
} from '@/utils/app/conversationRevision';
import { getWorkflowName } from '@/utils/app/helper';
import { getUserSessionItem, setUserSessionItem } from '@/utils/app/storage';

import { Conversation, DEFAULT_CONVERSATION_TITLE } from '@/types/chat';

import { ProtectedRoute } from '@/components/auth';
import { AutonomyDashboard } from '@/components/autonomy';
import { ChatView } from '@/components/chat/ChatView';
import { ConnectionsView } from '@/components/connections';
import { ImagePanel } from '@/components/images';
import { AppShell, ViewTabs } from '@/components/layout';
import { MemoryCenter } from '@/components/memory';
import { BottomNav } from '@/components/mobile/BottomNav';
import { Sidebar } from '@/components/sidebar/Sidebar';

import { branding } from '@/generated/branding';
import { useConversationStore, useUISettingsStore } from '@/state';
import { useImageChatDraftStore } from '@/state/imageChatDraftStore';
import { useImagePanelStore } from '@/state/imagePanelStore';
import { v4 as uuidv4 } from 'uuid';

function newConversation(): Conversation {
  return {
    id: uuidv4(),
    name: DEFAULT_CONVERSATION_TITLE,
    messages: [],
    folderId: null,
    updatedAt: Date.now(),
  };
}

/**
 * Replace this tab's copy with a server record. A streaming conversation is
 * left alone: this tab is the authority on its messages until the turn ends.
 */
function adoptServerConversation(conversation: Conversation) {
  const store = useConversationStore.getState();
  if (store.streamingConversationIds.has(conversation.id)) return;
  const [cleaned] = cleanConversationHistory([
    withConversationRevision(conversation),
  ]);
  store.addConversation(cleaned);
}

const Home = () => {
  const workflow = getWorkflowName() || 'Daedalus';
  const visualViewport = useVisualViewportKeyboard();

  // Keyboard shortcuts
  const toggleChatbar = useUISettingsStore((s) => s.toggleChatbar);
  useKeyboardShortcuts({
    shortcuts: [
      commonShortcuts.toggleSidebar(() => toggleChatbar()),
      commonShortcuts.newItem(() => {
        const newConv = newConversation();
        useConversationStore.getState().addConversation(newConv);
        useConversationStore.getState().selectConversation(newConv.id);
        void persistSelectedConversation(newConv.id);
        void saveConversation(newConv).catch(() => undefined);
      }),
    ],
  });

  // Read conversations from the store when handling sync events. Subscribing
  // here would re-render the whole app shell on every streamed flush.
  const setConversations = useConversationStore((s) => s.setConversations);
  const selectedConversationId = useConversationStore(
    (s) => s.selectedConversationId,
  );
  const selectConversation = useConversationStore((s) => s.selectConversation);
  const addConversation = useConversationStore((s) => s.addConversation);
  const deleteConversationFromStore = useConversationStore(
    (s) => s.deleteConversation,
  );

  const selectedIdRef = useRef(selectedConversationId);
  selectedIdRef.current = selectedConversationId;
  const pendingConversationReadsRef = useRef(new Map<string, symbol>());
  const pendingHistoryReadsRef = useRef(new Map<number, Set<string>>());
  const historyReadGenerationRef = useRef(0);
  const successfulHistoryReadGenerationRef = useRef(0);
  const pendingHistoryRefreshRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const pendingReads = pendingConversationReadsRef.current;
    const pendingHistoryReads = pendingHistoryReadsRef.current;
    return () => {
      pendingReads.clear();
      pendingHistoryReads.clear();
      pendingHistoryRefreshRef.current = null;
    };
  }, []);

  const readConversationHistory = useCallback(async (allowCached = false) => {
    const changed = new Set<string>();
    const generation = ++historyReadGenerationRef.current;
    pendingHistoryReadsRef.current.set(generation, changed);
    const superseded = () =>
      !pendingHistoryReadsRef.current.has(generation) ||
      (generation !== historyReadGenerationRef.current &&
        (!allowCached ||
          successfulHistoryReadGenerationRef.current > generation));
    try {
      let history: Conversation[] | undefined;
      try {
        history = await apiGet<Conversation[]>(
          '/api/session/conversationHistory',
        );
      } catch (error) {
        if (!allowCached) throw error;
      }
      // The initial snapshot remains a fallback while a replacement is pending
      // or fails. Only a successful newer read makes that snapshot obsolete.
      if (superseded()) return undefined;
      if (!Array.isArray(history) && allowCached) {
        const cached = getUserSessionItem('conversationHistory');
        if (cached) history = JSON.parse(cached);
      }
      if (!Array.isArray(history)) return history;
      successfulHistoryReadGenerationRef.current = generation;
      // Events delivered during the request are newer than either its server
      // snapshot or the cache used if the initial request failed.
      return [
        ...history.filter((conversation) => !changed.has(conversation.id)),
        ...useConversationStore
          .getState()
          .conversations.filter((conversation) => changed.has(conversation.id)),
      ];
    } catch (error) {
      // A superseded initial request must not restore an older cached history.
      if (superseded()) return undefined;
      throw error;
    } finally {
      pendingHistoryReadsRef.current.delete(generation);
    }
  }, []);

  // Cross-device sync via WebSocket + Redis pub/sub
  const refreshConversationList = useCallback(() => {
    // Skip refresh while any conversation is streaming — the store guard
    // would preserve streaming conversations anyway, but this avoids the
    // unnecessary network round-trip.
    if (useConversationStore.getState().streamingConversationIds.size > 0) {
      return;
    }

    const refresh = (async () => {
      try {
        const serverConversations = await readConversationHistory();
        if (Array.isArray(serverConversations)) {
          const cleaned = cleanConversationHistory(serverConversations);
          setConversations(cleaned);
          setUserSessionItem('conversationHistory', JSON.stringify(cleaned));
        }
      } catch (error) {
        console.error('Failed to refresh conversation list:', error);
      }
    })().finally(() => {
      if (pendingHistoryRefreshRef.current === refresh) {
        pendingHistoryRefreshRef.current = null;
      }
    });
    pendingHistoryRefreshRef.current = refresh;
    return refresh;
  }, [readConversationHistory, setConversations]);

  useWebSocket({
    enabled: true,
    onConversationUpdated: useCallback(
      (event: {
        conversationId?: string;
        revision?: string;
        conversation?: Conversation;
      }) => {
        const conversationId = event.conversationId || event.conversation?.id;
        if (!conversationId) return;
        for (const changed of pendingHistoryReadsRef.current.values()) {
          changed.add(conversationId);
        }
        // A later event supersedes an HTTP read started by an earlier one,
        // including when the new record is already local or is streaming.
        pendingConversationReadsRef.current.delete(conversationId);
        const store = useConversationStore.getState();
        // Never overwrite a conversation that is actively streaming —
        // the frontend is the authority on its messages during streaming.
        if (store.streamingConversationIds.has(conversationId)) return;
        const current = store.conversations.find(
          (conversation) => conversation.id === conversationId,
        );
        const incoming = event.conversation
          ? conversationRevision(event.conversation)
          : event.revision;
        // Already this revision, for example this tab's own save.
        if (current?.revision && current.revision === incoming) return;
        if (event.conversation) {
          // Worker finalization includes the record it saved.
          adoptServerConversation({
            ...event.conversation,
            id: conversationId,
          });
          return;
        }
        // Browser saves announce only the id and revision.
        const read = Symbol();
        pendingConversationReadsRef.current.set(conversationId, read);
        void apiGet<Conversation>(
          `/api/conversations/${encodeURIComponent(conversationId)}`,
        )
          .then((server) => {
            if (
              pendingConversationReadsRef.current.get(conversationId) ===
                read &&
              server &&
              Array.isArray(server.messages)
            ) {
              adoptServerConversation({ ...server, id: conversationId });
            }
          })
          .catch((error) => {
            console.warn('Failed to load an updated conversation', error);
          })
          .finally(() => {
            if (
              pendingConversationReadsRef.current.get(conversationId) === read
            ) {
              pendingConversationReadsRef.current.delete(conversationId);
            }
          });
      },
      [],
    ),
    onConversationDeleted: useCallback(
      (conversationId: string) => {
        for (const changed of pendingHistoryReadsRef.current.values()) {
          changed.add(conversationId);
        }
        pendingConversationReadsRef.current.delete(conversationId);
        deleteConversationFromStore(conversationId);
        if (selectedIdRef.current === conversationId) {
          const remaining = useConversationStore.getState().conversations;
          const next = remaining[remaining.length - 1];
          if (next) {
            selectConversation(next.id);
          } else {
            const newConv = newConversation();
            addConversation(newConv);
            selectConversation(newConv.id);
          }
        }
      },
      [deleteConversationFromStore, selectConversation, addConversation],
    ),
    onConnected: useCallback(() => {
      refreshConversationList();
    }, [refreshConversationList]),
  });

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshConversationList();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshConversationList]);

  // Initial data load
  useEffect(() => {
    let disposed = false;
    const savedWidth = getUserSessionItem('chatbarWidth');
    if (savedWidth) {
      const parsed = parseInt(savedWidth, 10);
      if (!isNaN(parsed) && parsed >= 200 && parsed <= 500) {
        useUISettingsStore.getState().setChatbarWidth(parsed);
      }
    }

    const fetchConversations = async () => {
      const serverConversations = await readConversationHistory(true);
      if (disposed || serverConversations === undefined) return;
      if (Array.isArray(serverConversations)) {
        const cleaned = cleanConversationHistory(serverConversations);
        useConversationStore.getState().setConversations(cleaned);
        setUserSessionItem('conversationHistory', JSON.stringify(cleaned));
      }
    };

    // Open the saved selection only when history still contains it. It may
    // name a conversation deleted here or on another device; selecting that
    // id would leave the composer without a conversation to send to.
    const restoreSelection = async () => {
      if (disposed) return;
      const serverSelection = await loadSelectedConversationId();
      // A reconnect may supersede the initial history request. Wait until its
      // replacement is applied before deciding whether the saved id was deleted.
      while (!disposed && pendingHistoryRefreshRef.current) {
        await pendingHistoryRefreshRef.current;
      }
      if (disposed) return;
      const store = useConversationStore.getState();
      const selected = [
        serverSelection,
        cachedSelectedConversationId(),
        // A conversation opened while history loaded.
        store.selectedConversationId,
      ].find(
        (id) =>
          id &&
          store.conversations.some((conversation) => conversation.id === id),
      );
      if (selected) {
        store.selectConversation(selected);
      } else {
        const newConv = newConversation();
        store.addConversation(newConv);
        store.selectConversation(newConv.id);
      }
    };

    // Selection is never saved as a side effect of saving a conversation (a
    // background chat finishing must not change what a reload opens). This
    // tab remembers each selection; an explicit choice (a conversation picked
    // or created) is also saved on the server where the user made it.
    let unsubscribeSelection = () => {};
    void fetchConversations()
      .catch((error) => {
        console.error('Failed to load conversation history', error);
      })
      .then(restoreSelection)
      .catch((error) => {
        console.error('Failed to restore the selected conversation', error);
      })
      .finally(() => {
        if (disposed) return;
        const remember = (id: string | null) => {
          if (id) rememberSelectedConversation(id);
        };
        remember(useConversationStore.getState().selectedConversationId);
        unsubscribeSelection = useConversationStore.subscribe(
          (state) => state.selectedConversationId,
          remember,
        );
      });
    return () => {
      disposed = true;
      unsubscribeSelection();
    };
  }, [readConversationHistory]);

  return (
    <ProtectedRoute>
      <Head>
        <title>{workflow}</title>
        <meta name="description" content={workflow} />
        <meta name="format-detection" content="telephone=no" />
        <link rel="icon" href={branding.assets['/favicon.png']} />
      </Head>

      <AppVisualViewportContext.Provider value={visualViewport}>
        <main
          className="app-viewport flex min-h-0 flex-col overflow-hidden bg-dark-bg-primary text-sm text-dark-text-primary"
          id="main-content"
          tabIndex={-1}
          data-keyboard-open={visualViewport.keyboardOpen ? 'true' : 'false'}
          data-viewport-shifted={
            visualViewport.top !== null && Math.abs(visualViewport.top) > 0.5
              ? 'true'
              : 'false'
          }
          style={{
            height: visualViewport.height ?? undefined,
            top: visualViewport.top ?? undefined,
          }}
        >
          <AppShell
            sidebar={<Sidebar />}
            bottomNav={<BottomNav keyboardOpen={visualViewport.keyboardOpen} />}
          >
            <div className="flex h-full w-full min-w-0 flex-col">
              <ViewTabs />
              <div className="flex-1 min-h-0 w-full overflow-hidden">
                <ActiveView />
              </div>
            </div>
          </AppShell>
        </main>
      </AppVisualViewportContext.Provider>
    </ProtectedRoute>
  );
};

export default Home;

const APP_VIEWS = [
  'chat',
  'create',
  'autonomy',
  'memory',
  'connections',
] as const;

function ActiveView() {
  const activeView = useUISettingsStore((s) => s.activeView);
  const [visited, setVisited] = useState<string[]>([activeView]);
  useEffect(() => {
    setVisited((views) =>
      views.includes(activeView) ? views : [...views, activeView],
    );
  }, [activeView]);
  return (
    <>
      {APP_VIEWS.map((view) => (
        <section
          key={view}
          id={`view-panel-${view}`}
          role="tabpanel"
          aria-label={view.charAt(0).toUpperCase() + view.slice(1)}
          hidden={activeView !== view}
          className="h-full min-w-0"
        >
          {(visited.includes(view) || activeView === view) && (
            <ActiveViewContent view={view} />
          )}
        </section>
      ))}
    </>
  );
}

function ActiveViewContent({
  view: activeView,
}: {
  view: (typeof APP_VIEWS)[number];
}) {
  if (activeView === 'create') {
    return (
      <ImagePanel
        onSendToChat={(imageId) => {
          const image = useImagePanelStore
            .getState()
            .gallery.find((item) => item.imageId === imageId);
          if (!image) return;
          useImageChatDraftStore.getState().queue(image);
          useUISettingsStore.getState().setActiveView('chat');
        }}
      />
    );
  }
  if (activeView === 'autonomy') {
    return <AutonomyDashboard />;
  }
  if (activeView === 'connections') {
    return <ConnectionsView />;
  }
  if (activeView === 'memory') {
    return <MemoryCenter />;
  }
  return <ChatView />;
}

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    props: {
      defaultModelId: process.env.DEFAULT_MODEL || '',
    },
  };
};
