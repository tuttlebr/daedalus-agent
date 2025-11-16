'use client'
import { useEffect, useRef, useState } from 'react';

import { GetServerSideProps } from 'next';
import { useTranslation } from 'next-i18next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Head from 'next/head';

import { useCreateReducer } from '@/hooks/useCreateReducer';
import { getUserSessionItem, setUserSessionItem } from '@/utils/app/storage';


import {
  cleanConversationHistory,
  cleanSelectedConversation,
} from '@/utils/app/clean';
import {
  saveConversation,
  saveConversations,
  updateConversation,
} from '@/utils/app/conversation';
import { saveFolders } from '@/utils/app/folders';
import { getSettings } from '@/utils/app/settings';

import { Conversation } from '@/types/chat';
import { KeyValuePair } from '@/types/data';
import { FolderInterface, FolderType } from '@/types/folder';

import { Chat } from '@/components/Chat/Chat';
import { Chatbar } from '@/components/Chatbar/Chatbar';
import { ProtectedRoute } from '@/components/Auth/ProtectedRoute';
import { MemoryWarning } from '@/components/MemoryWarning';

import HomeContext from './home.context';
import { HomeInitialState, initialState } from './home.state';

import { v4 as uuidv4 } from 'uuid';
import { getWorkflowName } from '@/utils/app/helper';
import { apiGet } from '@/utils/app/api';

const Home = (props: any) => {
  const { t } = useTranslation('chat');

  const contextValue = useCreateReducer<HomeInitialState>({
    initialState,
  });

  let workflow = 'Daedalus';

  const {
    state: {
      lightMode,
      folders,
      conversations,
      selectedConversation,
      showChatbar,
      useDeepThinker,
      // showVoiceRecorder, // COMMENTED OUT - Voice recording disabled
    },
    dispatch,
  } = contextValue;

  const stopConversationRef = useRef<boolean>(false);
  const [quickActionHandlers, setQuickActionHandlers] = useState<{
    onAttachFile?: () => void;
    onTakePhoto?: () => void;
  }>({});

  const handleSelectConversation = (conversation: Conversation) => {
    dispatch({
      field: 'selectedConversation',
      value: conversation,
    });

    saveConversation(conversation);
  };

  // FOLDER OPERATIONS  --------------------------------------------

  const handleCreateFolder = (name: string, type: FolderType) => {
    const newFolder: FolderInterface = {
      id: uuidv4(),
      name,
      type,
    };

    const updatedFolders = [...folders, newFolder];

    dispatch({ field: 'folders', value: updatedFolders });
    saveFolders(updatedFolders);
  };

  const handleDeleteFolder = (folderId: string) => {
    const updatedFolders = folders.filter((f) => f.id !== folderId);
    dispatch({ field: 'folders', value: updatedFolders });
    saveFolders(updatedFolders);

    const updatedConversations: Conversation[] = conversations.map((c) => {
      if (c.folderId === folderId) {
        return {
          ...c,
          folderId: null,
        };
      }

      return c;
    });

    dispatch({ field: 'conversations', value: updatedConversations });
    saveConversations(updatedConversations);;
  };

  const handleUpdateFolder = (folderId: string, name: string) => {
    const updatedFolders = folders.map((f) => {
      if (f.id === folderId) {
        return {
          ...f,
          name,
        };
      }

      return f;
    });

    dispatch({ field: 'folders', value: updatedFolders });

    saveFolders(updatedFolders);
  };

  // CONVERSATION OPERATIONS  --------------------------------------------

  const handleNewConversation = () => {
    const lastConversation = conversations[conversations.length - 1];

    const newConversation: Conversation = {
      id: uuidv4(),
      name: t('New Conversation'),
      messages: [],
      folderId: null,
    };

    const updatedConversations = [...conversations, newConversation];

    dispatch({ field: 'selectedConversation', value: newConversation });
    dispatch({ field: 'conversations', value: updatedConversations });

    saveConversation(newConversation);
    saveConversations(updatedConversations);

    dispatch({ field: 'loading', value: false });
  };

  const handleUpdateConversation = (
    conversation: Conversation,
    data: KeyValuePair,
  ) => {
    const updatedConversation = {
      ...conversation,
      [data.key]: data.value,
    };

    const { single, all } = updateConversation(
      updatedConversation,
      conversations,
    );

    dispatch({ field: 'selectedConversation', value: single });
    dispatch({ field: 'conversations', value: all });
  };

  // EFFECTS  --------------------------------------------

  useEffect(() => {
    workflow = getWorkflowName()
    const settings = getSettings();
    if (settings.theme) {
      dispatch({
        field: 'lightMode',
        value: settings.theme,
      });
    }

    // Use user-specific storage keys to prevent data leakage between users
    const showChatbar = getUserSessionItem('showChatbar');
    if (showChatbar !== null) {
      dispatch({ field: 'showChatbar', value: showChatbar === 'true' });
    } else {
      const prefersSidebar = typeof window !== 'undefined'
        ? window.matchMedia('(min-width: 768px)').matches
        : false;
      dispatch({ field: 'showChatbar', value: prefersSidebar });
      setUserSessionItem('showChatbar', prefersSidebar ? 'true' : 'false');
    }

    const chatHistory = getUserSessionItem('chatHistory');
    if (chatHistory !== null) {
      dispatch({ field: 'chatHistory', value: chatHistory === 'true' });
    } else {
      // If no sessionStorage value, use the default from initialState (true)
      dispatch({ field: 'chatHistory', value: true });
      setUserSessionItem('chatHistory', 'true');
    }

    const enableBackgroundProcessing = getUserSessionItem('enableBackgroundProcessing');
    if (enableBackgroundProcessing !== null) {
      dispatch({ field: 'enableBackgroundProcessing', value: enableBackgroundProcessing === 'true' });
    } else {
      // Default to true to enable background processing by default
      dispatch({ field: 'enableBackgroundProcessing', value: true });
      setUserSessionItem('enableBackgroundProcessing', 'true');
    }

    const folders = getUserSessionItem('folders');
    if (folders) {
      dispatch({ field: 'folders', value: JSON.parse(folders) });
    }

    const fetchConversations = async () => {
      try {
        const serverConversations = await apiGet('/api/conversations');
        if (Array.isArray(serverConversations)) {
          const cleanedServerConversations = cleanConversationHistory(serverConversations);
          dispatch({ field: 'conversations', value: cleanedServerConversations });
          setUserSessionItem('conversationHistory', JSON.stringify(cleanedServerConversations));
        } else {
            // This case might happen if server returns something other than an array, but not an error.
            // Fallback to local.
            const localConversationHistory = getUserSessionItem('conversationHistory');
            if (localConversationHistory) {
              dispatch({ field: 'conversations', value: JSON.parse(localConversationHistory) });
            }
        }
      } catch (error) {
        console.error('Error fetching conversations, falling back to local storage:', error);
        // Fallback to local conversations if server fetch fails
        const localConversationHistory = getUserSessionItem('conversationHistory');
        if (localConversationHistory) {
          dispatch({ field: 'conversations', value: JSON.parse(localConversationHistory) });
        }
      }
    };

    fetchConversations();

    const selectedConversation = getUserSessionItem('selectedConversation');
    if (selectedConversation) {
      const parsedSelectedConversation: Conversation =
        JSON.parse(selectedConversation);
      const cleanedSelectedConversation = cleanSelectedConversation(
        parsedSelectedConversation,
      );

      dispatch({
        field: 'selectedConversation',
        value: cleanedSelectedConversation,
      });
    } else {
      const lastConversation = conversations[conversations.length - 1];
      dispatch({
        field: 'selectedConversation',
        value: {
          id: uuidv4(),
          name: t('New Conversation'),
          messages: [],
          folderId: null,
        },
      });
    }
  }, [dispatch, t]);

  return (
    <ProtectedRoute>
      <HomeContext.Provider
        value={{
          ...contextValue,
          handleNewConversation,
          handleCreateFolder,
          handleDeleteFolder,
          handleUpdateFolder,
          handleSelectConversation,
          handleUpdateConversation,
          quickActionHandlers: {
            onAttachFile: () => {
              if (quickActionHandlers.onAttachFile) {
                quickActionHandlers.onAttachFile();
              } else {
                console.warn('Attach file handler not available');
              }
            },
            onTakePhoto: () => {
              if (quickActionHandlers.onTakePhoto) {
                quickActionHandlers.onTakePhoto();
              } else {
                console.warn('Take photo handler not available');
              }
            },
            onToggleDeepThought: () => {
              dispatch({ field: 'useDeepThinker', value: !useDeepThinker });
            },
            __setHandlers: (handlers: any) => {
              setQuickActionHandlers((prevHandlers: any) => ({ ...prevHandlers, ...handlers }));
            },
          } as any,
        }}
      >
        <Head>
          <title>{workflow}</title>
          <meta name="description" content={workflow} />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          />
          <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
          <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
          <link rel="icon" href="/favicon.png" />
        </Head>
        {selectedConversation && (
          <main
            className={`relative flex min-h-[100dvh] w-full flex-col overflow-hidden text-sm text-neutral-900 transition-colors dark:text-white ${lightMode}`}
            style={{
              height: '100dvh',
              backgroundColor:
                lightMode === 'dark'
                  ? 'var(--color-dark-bg-primary)'
                  : 'var(--color-bg-secondary)',
            }}
          >
            {/* Mobile Layout */}
            <div className="relative flex flex-1 flex-col overflow-hidden md:hidden">
              <Chat />

              {/* Slide-over chatbar for mobile */}
              {showChatbar && (
                <>
                  <div
                    className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity md:hidden"
                    role="presentation"
                    onClick={() => dispatch({ field: 'showChatbar', value: false })}
                  />

                  <aside
                    className="fixed inset-y-0 left-0 z-50 flex w-4/5 max-w-sm flex-col bg-dark-bg-secondary/95 px-2 py-4 text-white shadow-2xl backdrop-blur-xl dark:bg-dark-bg-secondary md:hidden"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Conversation menu"
                  >
                    <Chatbar />
                  </aside>
                </>
              )}
            </div>

            {/* Desktop Layout */}
            <div className="hidden h-full min-h-0 overflow-hidden md:grid md:flex-1 md:grid-cols-[auto,1fr]">
              <aside
                className={`relative h-full overflow-hidden border-r border-white/5 transition-[max-width,opacity] duration-300 ease-out ${showChatbar ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                style={{
                  maxWidth: showChatbar ? 'clamp(16rem, 22vw, 22rem)' : 0,
                  width: showChatbar ? 'clamp(16rem, 22vw, 22rem)' : 0,
                }}
                aria-hidden={!showChatbar}
              >
                <Chatbar />
              </aside>
              <section className="flex min-w-0 flex-col">
                <Chat />
              </section>
            </div>
          </main>
        )}
        <MemoryWarning />
      </HomeContext.Provider>
    </ProtectedRoute>
  );
};
export default Home;

export const getServerSideProps: GetServerSideProps = async ({ locale }) => {
  const defaultModelId =
    process.env.DEFAULT_MODEL || '';

  return {
    props: {
      defaultModelId,
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
