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
  loadConversation,
  loadConversations,
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
import { IconMenu2, IconX } from '@tabler/icons-react';
import { ProtectedRoute } from '@/components/Auth/ProtectedRoute';

import HomeContext from './home.context';
import { HomeInitialState, initialState } from './home.state';

import { v4 as uuidv4 } from 'uuid';
import { getWorkflowName } from '@/utils/app/helper';

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
      showVoiceRecorder,
    },
    dispatch,
  } = contextValue;

  const stopConversationRef = useRef<boolean>(false);
  const [quickActionHandlers, setQuickActionHandlers] = useState<{
    onAttachFile?: () => void;
    onTakePhoto?: () => void;
    onStartVoice?: () => void;
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
    if (window.innerWidth < 640) {
      dispatch({ field: 'showChatbar', value: false });
    }
  }, [selectedConversation, dispatch]);

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
    if (showChatbar) {
      dispatch({ field: 'showChatbar', value: showChatbar === 'true' });
    }

    const chatHistory = getUserSessionItem('chatHistory');
    if (chatHistory !== null) {
      dispatch({ field: 'chatHistory', value: chatHistory === 'true' });
    } else {
      // If no sessionStorage value, use the default from initialState (true)
      dispatch({ field: 'chatHistory', value: true });
      setUserSessionItem('chatHistory', 'true');
    }

    const folders = getUserSessionItem('folders');
    if (folders) {
      dispatch({ field: 'folders', value: JSON.parse(folders) });
    }

    const conversationHistory = getUserSessionItem('conversationHistory');
    if (conversationHistory) {
      const parsedConversationHistory: Conversation[] =
        JSON.parse(conversationHistory);
      const cleanedConversationHistory = cleanConversationHistory(
        parsedConversationHistory,
      );

      dispatch({ field: 'conversations', value: cleanedConversationHistory });
    }

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

    const hydrateFromServer = async () => {
      try {
        const [serverConversations, serverSelectedConversation] = await Promise.all([
          loadConversations(),
          loadConversation(),
        ]);

        if (Array.isArray(serverConversations) && serverConversations.length > 0) {
          const cleanedConversationHistory = cleanConversationHistory(serverConversations);
          dispatch({ field: 'conversations', value: cleanedConversationHistory });
          // Use user-specific storage key to prevent data leakage between users
          setUserSessionItem('conversationHistory', JSON.stringify(cleanedConversationHistory));
        }

        if (serverSelectedConversation) {
          const cleanedSelectedConversation = cleanSelectedConversation(serverSelectedConversation);
          dispatch({ field: 'selectedConversation', value: cleanedSelectedConversation });
          // Use user-specific storage key to prevent data leakage between users
          setUserSessionItem('selectedConversation', JSON.stringify(cleanedSelectedConversation));
        }
      } catch (error) {
        console.log('error hydrating conversations from server', error);
      }
    };

    hydrateFromServer();
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
            onStartVoice: () => {
              if (quickActionHandlers.onStartVoice) {
                quickActionHandlers.onStartVoice();
              } else {
                console.warn('Start voice handler not available');
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
            className={`flex h-screen w-screen flex-col text-sm text-white dark:text-white ${lightMode}`}
          >
            {/* Mobile Layout */}
            <div className="relative flex flex-col h-full md:hidden">
              {/* Menu button - positioned absolutely over chat */}
              <div className="absolute top-4 left-4 z-50 safe-top">
                <button
                  type="button"
                  onClick={() => dispatch({ field: 'showChatbar', value: !showChatbar })}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white shadow-md backdrop-blur transition-colors duration-200 hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green"
                  aria-label={showChatbar ? 'Close menu' : 'Open menu'}
                >
                  {showChatbar ? <IconX size={22} /> : <IconMenu2 size={22} />}
                </button>
              </div>

              {/* Main chat container - full height with proper spacing */}
              <div className="flex-1 overflow-hidden">
                <Chat />
              </div>

              {/* Slide-over chatbar for mobile */}
              {showChatbar && (
                <>
                  {/* Backdrop overlay */}
                  <div 
                    className="fixed inset-0 bg-black/50 z-40 md:hidden"
                    onClick={() => dispatch({ field: 'showChatbar', value: false })}
                  />
                  {/* Sidebar panel */}
                  <div
                    className="fixed left-0 top-0 bottom-0 w-4/5 max-w-sm z-50 transform transition-transform duration-300 ease-in-out translate-x-0"
                  >
                    <div className="relative h-full bg-dark-bg-secondary safe-top safe-bottom">
                      <Chatbar />
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Desktop Layout */}
            <div className="hidden md:flex h-full overflow-hidden">
              <div
                className={`transition-all duration-300 flex-shrink-0 ${showChatbar ? 'w-[260px]' : 'w-0'}`}
                data-sidebar-desktop={showChatbar ? 'open' : 'collapsed'}
              >
                <Chatbar />
              </div>
              <div className="flex flex-1 min-w-0 overflow-hidden">
                <Chat />
              </div>
            </div>
          </main>
        )}
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
