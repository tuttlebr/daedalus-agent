'use client'
import { useCallback, useEffect, useRef, useState } from 'react';

import { GetServerSideProps } from 'next';
import { useTranslation } from 'next-i18next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Head from 'next/head';

import { useCreateReducer } from '@/hooks/useCreateReducer';
import { useWebSocket } from '@/hooks/useWebSocket';
import { getUserSessionItem, setUserSessionItem } from '@/utils/app/storage';


import {
  cleanConversationHistory,
  cleanSelectedConversation,
} from '@/utils/app/clean';
import {
  saveConversation,
  saveConversations,
  updateConversation,
  loadConversation,
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
      chatbarWidth,
      // showVoiceRecorder, // COMMENTED OUT - Voice recording disabled
    },
    dispatch,
  } = contextValue;

  const stopConversationRef = useRef<boolean>(false);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const selectedConversationRef = useRef(selectedConversation);
  selectedConversationRef.current = selectedConversation;
  const [quickActionHandlers, setQuickActionHandlers] = useState<{
    onAttachFile?: () => void;
    onTakePhoto?: () => void;
  }>({});

  // Sidebar resize logic
  const isResizing = useRef(false);
  const chatbarWidthRef = useRef(chatbarWidth);
  chatbarWidthRef.current = chatbarWidth;

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(Math.max(e.clientX, 200), 500);
      dispatch({ field: 'chatbarWidth', value: newWidth });
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      setUserSessionItem('chatbarWidth', String(chatbarWidthRef.current));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [dispatch]);

  const handleSelectConversation = (conversation: Conversation) => {
    // Save the CURRENT conversation before switching to preserve any in-progress state
    if (selectedConversation && selectedConversation.id !== conversation.id) {
      saveConversation(selectedConversation);
      // Also update the conversations list with the current state
      const updatedConversations = conversations.map((c) =>
        c.id === selectedConversation.id ? selectedConversation : c
      );
      saveConversations(updatedConversations);
    }

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
    // Save the CURRENT conversation before creating a new one to preserve any in-progress state
    if (selectedConversation) {
      saveConversation(selectedConversation);
      // Update the conversations list with the current state before adding the new one
      const updatedExistingConversations = conversations.map((c) =>
        c.id === selectedConversation.id ? selectedConversation : c
      );
      dispatch({ field: 'conversations', value: updatedExistingConversations });
      saveConversations(updatedExistingConversations);
    }

    const lastConversation = conversations[conversations.length - 1];

    const newConversation: Conversation = {
      id: uuidv4(),
      name: t('New Conversation'),
      messages: [],
      folderId: null,
    };

    const updatedConversations = selectedConversation
      ? [...conversations.map((c) => c.id === selectedConversation.id ? selectedConversation : c), newConversation]
      : [...conversations, newConversation];

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

  // CROSS-DEVICE SYNC  -----------------------------------------------

  const refreshConversationList = useCallback(async () => {
    try {
      const serverConversations = await apiGet<Conversation[]>('/api/session/conversationHistory');
      if (Array.isArray(serverConversations)) {
        const cleaned = cleanConversationHistory(serverConversations);
        dispatch({ field: 'conversations', value: cleaned });
        setUserSessionItem('conversationHistory', JSON.stringify(cleaned));
      }
    } catch (error) {
      console.error('Failed to refresh conversation list:', error);
    }
  }, [dispatch]);

  // Real-time sync via WebSocket + Redis pub/sub for cross-device updates
  useWebSocket({
    enabled: true,
    onConversationUpdated: useCallback((conversation: Conversation) => {
      // Only apply update if it came from a different session (different conversation state)
      const current = conversationsRef.current.find((c) => c.id === conversation.id);
      const isSelectedOnThisDevice = selectedConversationRef.current?.id === conversation.id;

      // Update the conversation list
      if (current) {
        const updatedConversations = conversationsRef.current.map((c) =>
          c.id === conversation.id ? conversation : c
        );
        dispatch({ field: 'conversations', value: updatedConversations });
      } else {
        // New conversation from another device
        dispatch({ field: 'conversations', value: [...conversationsRef.current, conversation] });
      }

      // If we're viewing this conversation, update it
      if (isSelectedOnThisDevice) {
        dispatch({ field: 'selectedConversation', value: conversation });
      }
    }, [dispatch]),
    onConversationDeleted: useCallback((conversationId: string) => {
      const updated = conversationsRef.current.filter((c) => c.id !== conversationId);
      dispatch({ field: 'conversations', value: updated });

      // If the deleted conversation is currently selected, clear selection
      if (selectedConversationRef.current?.id === conversationId) {
        const next = updated[updated.length - 1];
        dispatch({
          field: 'selectedConversation',
          value: next ?? { id: uuidv4(), name: t('New Conversation'), messages: [], folderId: null },
        });
      }
    }, [dispatch, t]),
    onConversationListChanged: useCallback(() => {
      refreshConversationList();
    }, [refreshConversationList]),
    onConnected: useCallback(() => {
      // On reconnect, refresh the full conversation list to catch anything missed
      refreshConversationList();
    }, [refreshConversationList]),
  });

  // Refresh conversation list when the page becomes visible (user switches back to this tab/device)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshConversationList();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshConversationList]);

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
    if (showChatbar !== null) {
      dispatch({ field: 'showChatbar', value: showChatbar === 'true' });
    } else {
      // If no sessionStorage value, use the default from initialState (false)
      dispatch({ field: 'showChatbar', value: false });
      setUserSessionItem('showChatbar', 'false');
    }

    const savedChatbarWidth = getUserSessionItem('chatbarWidth');
    if (savedChatbarWidth !== null) {
      const parsed = parseInt(savedChatbarWidth, 10);
      if (!isNaN(parsed) && parsed >= 200 && parsed <= 500) {
        dispatch({ field: 'chatbarWidth', value: parsed });
      }
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
        // Use session-based conversationHistory endpoint for Redis persistence
        const serverConversations = await apiGet('/api/session/conversationHistory');
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

    // Load selected conversation from Redis (with localStorage fallback)
    const loadSelectedConversation = async () => {
      try {
        const serverConversation = await loadConversation();
        if (serverConversation) {
          const cleanedSelectedConversation = cleanSelectedConversation(serverConversation);
          dispatch({
            field: 'selectedConversation',
            value: cleanedSelectedConversation,
          });
        } else {
          // Fallback to local storage
          const localSelectedConversation = getUserSessionItem('selectedConversation');
          if (localSelectedConversation) {
            const parsedSelectedConversation: Conversation =
              JSON.parse(localSelectedConversation);
            const cleanedSelectedConversation = cleanSelectedConversation(
              parsedSelectedConversation,
            );
            dispatch({
              field: 'selectedConversation',
              value: cleanedSelectedConversation,
            });
          } else {
            // No existing conversation, create a new one
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
        }
      } catch (error) {
        console.error('Error loading selected conversation:', error);
        // Fallback to local storage on error
        const localSelectedConversation = getUserSessionItem('selectedConversation');
        if (localSelectedConversation) {
          const parsedSelectedConversation: Conversation =
            JSON.parse(localSelectedConversation);
          const cleanedSelectedConversation = cleanSelectedConversation(
            parsedSelectedConversation,
          );
          dispatch({
            field: 'selectedConversation',
            value: cleanedSelectedConversation,
          });
        }
      }
    };

    loadSelectedConversation();
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
            className={`flex h-screen w-screen flex-col text-sm text-white dark:text-white ${lightMode}`}
          >
            {/* Mobile Layout */}
            <div className="relative flex flex-col h-full md:hidden">
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
                className="flex-shrink-0 overflow-hidden"
                style={{ width: showChatbar ? `${chatbarWidth}px` : '0px', transition: isResizing.current ? 'none' : 'width 0.3s' }}
                data-sidebar-desktop={showChatbar ? 'open' : 'collapsed'}
              >
                <Chatbar />
              </div>
              {showChatbar && (
                <div
                  className="w-1 flex-shrink-0 cursor-col-resize hover:bg-nvidia-green/30 active:bg-nvidia-green/50 transition-colors duration-150"
                  onMouseDown={handleResizeMouseDown}
                />
              )}
              <div className="flex flex-1 min-w-0 overflow-hidden">
                <Chat />
              </div>
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
