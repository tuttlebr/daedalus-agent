'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import Head from 'next/head';
import { v4 as uuidv4 } from 'uuid';

import { useWebSocket } from '@/hooks/useWebSocket';
import { useKeyboardShortcuts, commonShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useTheme } from '@/hooks/useTheme';
import { getUserSessionItem, setUserSessionItem } from '@/utils/app/storage';
import { cleanConversationHistory, cleanSelectedConversation } from '@/utils/app/clean';
import { saveConversation, saveConversations, loadConversation } from '@/utils/app/conversation';
import { getWorkflowName } from '@/utils/app/helper';
import { apiGet } from '@/utils/app/api';
import { Conversation } from '@/types/chat';

import { useConversationStore, useUISettingsStore } from '@/state';
import { useAuth } from '@/components/auth';
import { ProtectedRoute } from '@/components/auth';
import { AppShell, ViewTabs } from '@/components/layout';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { BottomNav } from '@/components/mobile/BottomNav';
import { ChatView } from '@/components/chat/ChatView';
import { ImagePanel } from '@/components/images';

const Home = () => {
  const { t } = useTranslation('chat');
  const { user } = useAuth();
  const userId = user?.username || 'anon';
  useTheme();

  const workflow = getWorkflowName() || 'Daedalus';

  // Keyboard shortcuts
  const toggleChatbar = useUISettingsStore((s) => s.toggleChatbar);
  useKeyboardShortcuts({
    shortcuts: [
      commonShortcuts.toggleSidebar(() => toggleChatbar()),
      commonShortcuts.newItem(() => {
        const newConv: Conversation = { id: uuidv4(), name: t('New Conversation'), messages: [], folderId: null, updatedAt: Date.now() };
        useConversationStore.getState().addConversation(newConv);
        useConversationStore.getState().selectConversation(newConv.id);
        saveConversation(newConv);
      }),
    ],
  });

  const conversations = useConversationStore((s) => s.conversations);
  const setConversations = useConversationStore((s) => s.setConversations);
  const selectedConversationId = useConversationStore((s) => s.selectedConversationId);
  const selectConversation = useConversationStore((s) => s.selectConversation);
  const addConversation = useConversationStore((s) => s.addConversation);
  const updateConversationInStore = useConversationStore((s) => s.updateConversation);
  const deleteConversationFromStore = useConversationStore((s) => s.deleteConversation);

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const selectedIdRef = useRef(selectedConversationId);
  selectedIdRef.current = selectedConversationId;

  // Cross-device sync via WebSocket + Redis pub/sub
  const refreshConversationList = useCallback(async () => {
    // Skip refresh while any conversation is streaming — the store guard
    // would preserve streaming conversations anyway, but this avoids the
    // unnecessary network round-trip.
    if (useConversationStore.getState().streamingConversationIds.size > 0) {
      return;
    }

    try {
      const serverConversations = await apiGet<Conversation[]>('/api/session/conversationHistory');
      if (Array.isArray(serverConversations)) {
        const cleaned = cleanConversationHistory(serverConversations);
        setConversations(cleaned);
        setUserSessionItem('conversationHistory', JSON.stringify(cleaned));
      }
    } catch (error) {
      console.error('Failed to refresh conversation list:', error);
    }
  }, [setConversations]);

  useWebSocket({
    enabled: true,
    onConversationUpdated: useCallback((conversation: Conversation) => {
      // Never overwrite a conversation that is actively streaming —
      // the frontend is the authority on its messages during streaming.
      if (useConversationStore.getState().streamingConversationIds.has(conversation.id)) {
        return;
      }

      const current = conversationsRef.current.find((c) => c.id === conversation.id);
      if (current) {
        // Only apply if incoming data is at least as recent as local state
        // to prevent stale sync events from overwriting newer local updates
        // (e.g. auto-naming that happened after the initial save started)
        const incomingTime = conversation.updatedAt || 0;
        const currentTime = current.updatedAt || 0;
        if (incomingTime >= currentTime) {
          updateConversationInStore(conversation.id, conversation);
        }
      } else {
        addConversation(conversation);
      }
    }, [updateConversationInStore, addConversation]),
    onConversationDeleted: useCallback((conversationId: string) => {
      deleteConversationFromStore(conversationId);
      if (selectedIdRef.current === conversationId) {
        const remaining = conversationsRef.current.filter((c) => c.id !== conversationId);
        const next = remaining[remaining.length - 1];
        if (next) {
          selectConversation(next.id);
        } else {
          const newConv: Conversation = { id: uuidv4(), name: t('New Conversation'), messages: [], folderId: null, updatedAt: Date.now() };
          addConversation(newConv);
          selectConversation(newConv.id);
        }
      }
    }, [deleteConversationFromStore, selectConversation, addConversation, t]),
    onConversationListChanged: useCallback(() => { refreshConversationList(); }, [refreshConversationList]),
    onConnected: useCallback(() => { refreshConversationList(); }, [refreshConversationList]),
  });

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshConversationList();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshConversationList]);

  // Clear stale async jobs from previous sessions (prevents 404 polling spam)
  useEffect(() => {
    try {
      const key = `asyncJobs_${userId}`;
      const stored = localStorage.getItem(key);
      if (stored) {
        const jobs = JSON.parse(stored);
        // Clear jobs older than 1 hour
        const fresh = Array.isArray(jobs) ? jobs.filter((j: any) => Date.now() - (j.timestamp || 0) < 3600000) : [];
        if (fresh.length !== jobs.length) {
          localStorage.setItem(key, JSON.stringify(fresh));
        }
      }
    } catch {}
  }, [userId]);

  // Initial data load
  useEffect(() => {
    const folders = getUserSessionItem('folders');
    if (folders) {
      try { useUISettingsStore.getState().setFolders(JSON.parse(folders)); } catch {}
    }

    const savedWidth = getUserSessionItem('chatbarWidth');
    if (savedWidth) {
      const parsed = parseInt(savedWidth, 10);
      if (!isNaN(parsed) && parsed >= 200 && parsed <= 500) {
        useUISettingsStore.getState().setChatbarWidth(parsed);
      }
    }

    const fetchConversations = async () => {
      try {
        const serverConversations = await apiGet('/api/session/conversationHistory');
        if (Array.isArray(serverConversations)) {
          const cleaned = cleanConversationHistory(serverConversations);
          useConversationStore.getState().setConversations(cleaned);
          setUserSessionItem('conversationHistory', JSON.stringify(cleaned));
        } else {
          const local = getUserSessionItem('conversationHistory');
          if (local) useConversationStore.getState().setConversations(JSON.parse(local));
        }
      } catch {
        const local = getUserSessionItem('conversationHistory');
        if (local) useConversationStore.getState().setConversations(JSON.parse(local));
      }
    };

    const loadSelectedConversation = async () => {
      try {
        const serverConv = await loadConversation();
        if (serverConv) {
          const cleaned = cleanSelectedConversation(serverConv);
          useConversationStore.getState().addConversation(cleaned);
          useConversationStore.getState().selectConversation(cleaned.id);
        } else {
          const local = getUserSessionItem('selectedConversation');
          if (local) {
            const parsed = cleanSelectedConversation(JSON.parse(local));
            useConversationStore.getState().selectConversation(parsed.id);
          } else {
            const newConv: Conversation = { id: uuidv4(), name: t('New Conversation'), messages: [], folderId: null, updatedAt: Date.now() };
            useConversationStore.getState().addConversation(newConv);
            useConversationStore.getState().selectConversation(newConv.id);
          }
        }
      } catch {
        const local = getUserSessionItem('selectedConversation');
        if (local) {
          const parsed = cleanSelectedConversation(JSON.parse(local));
          useConversationStore.getState().selectConversation(parsed.id);
        }
      }
    };

    fetchConversations();
    loadSelectedConversation();
  }, [t]);

  useEffect(() => {
    if (window.innerWidth < 768) {
      useUISettingsStore.getState().setShowChatbar(false);
    }
  }, [selectedConversationId]);

  return (
    <ProtectedRoute>
      <Head>
        <title>{workflow}</title>
        <meta name="description" content={workflow} />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <link rel="icon" href="/favicon.png" />
      </Head>

      <main className="flex h-screen w-screen flex-col text-sm text-dark-text-primary bg-dark-bg-primary" id="main-content">
        <AppShell
          sidebar={<Sidebar />}
          bottomNav={<BottomNav />}
        >
          <div className="flex h-full w-full min-w-0 flex-col">
            <ViewTabs />
            <div className="flex-1 min-h-0 w-full overflow-hidden">
              <ActiveView />
            </div>
          </div>
        </AppShell>
      </main>
    </ProtectedRoute>
  );
};

export default Home;

function ActiveView() {
  const activeView = useUISettingsStore((s) => s.activeView);

  if (activeView === 'create') {
    return <ImagePanel />;
  }
  return <ChatView />;
}

import { GetServerSideProps } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

export const getServerSideProps: GetServerSideProps = async ({ locale }) => {
  return {
    props: {
      defaultModelId: process.env.DEFAULT_MODEL || '',
      ...(await serverSideTranslations(locale ?? 'en', [
        'common',
        'chat',
        'sidebar',
        'markdown',
        'promptbar',
        'settings',
      ])),
    },
  };
};
