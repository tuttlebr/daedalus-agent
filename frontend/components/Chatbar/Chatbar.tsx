import { useCallback, useContext, useEffect, useRef } from 'react';

import { useTranslation } from 'next-i18next';
import toast from 'react-hot-toast';

import { useCreateReducer } from '@/hooks/useCreateReducer';

import { saveConversation, saveConversations } from '@/utils/app/conversation';
import { deleteConversationFromDB, clearAllConversationsFromDB } from '@/utils/app/conversationPagination';
import { clearConversationIntermediateSteps, clearAllIntermediateSteps } from '@/utils/app/intermediateStepsDB';
import { saveFolders } from '@/utils/app/folders';
import { exportData, importData } from '@/utils/app/importExport';
import { removeUserSessionItem, setUserSessionItem } from '@/utils/app/storage';

import { Conversation } from '@/types/chat';
import { LatestExportFormat, SupportedExportFormats } from '@/types/export';

import HomeContext from '@/pages/api/home/home.context';

import { ChatFolders } from './components/ChatFolders';
import { ChatbarSettings } from './components/ChatbarSettings';
import { Conversations } from './components/Conversations';
import { ConversationSkeleton } from '@/components/UI/Skeleton';

import Sidebar from '../Sidebar';
import ChatbarContext from './Chatbar.context';
import { ChatbarInitialState, initialState } from './Chatbar.state';

import { v4 as uuidv4 } from 'uuid';
import { apiDelete, apiPost } from '@/utils/app/api';
import { useKeyboardShortcuts, commonShortcuts } from '@/hooks/useKeyboardShortcuts';
import { Logger } from '@/utils/logger';

const logger = new Logger('Chatbar');

export const Chatbar = () => {
  const { t } = useTranslation('sidebar');

  const chatBarContextValue = useCreateReducer<ChatbarInitialState>({
    initialState,
  });

  const {
    state: { conversations, showChatbar, folders, loading },
    dispatch: homeDispatch,
    handleCreateFolder,
    handleNewConversation,
    handleUpdateConversation,
  } = useContext(HomeContext);

  const {
    state: { searchTerm, filteredConversations },
    dispatch: chatDispatch,
  } = chatBarContextValue;

  const searchInputRef = useRef<HTMLInputElement>(null);

  useKeyboardShortcuts({
    shortcuts: [
      commonShortcuts.newItem(() => {
        handleNewConversation();
      }),
      commonShortcuts.commandPalette(() => {
        if (!showChatbar) {
          homeDispatch({ field: 'showChatbar', value: true });
        }
        chatDispatch({ field: 'searchTerm', value: '' });
        setTimeout(() => searchInputRef.current?.focus(), 100);
      }),
      commonShortcuts.toggleSidebar(() => {
        handleToggleChatbar();
      }),
    ],
  });

  const handleExportData = () => {
    exportData();
  };

  const handleImportConversations = (data: SupportedExportFormats) => {
    const { history, folders }: LatestExportFormat = importData(data);
    homeDispatch({ field: 'conversations', value: history });
    homeDispatch({
      field: 'selectedConversation',
      value: history[history.length - 1],
    });
    homeDispatch({ field: 'folders', value: folders });
    window.location.reload();
  };

  const handleClearConversations = async () => {
      homeDispatch({
        field: 'selectedConversation',
        value: {
          id: uuidv4(),
          name: t('New Conversation'),
          messages: [],
          folderId: null,
        },
      });

    homeDispatch({ field: 'conversations', value: [] });

    // Use user-specific storage keys to prevent data leakage between users
    removeUserSessionItem('conversationHistory');
    removeUserSessionItem('selectedConversation');

    const updatedFolders = folders.filter((f) => f.type !== 'chat');

    homeDispatch({ field: 'folders', value: updatedFolders });
    saveFolders(updatedFolders);

    // Clear conversations from Redis to prevent them from coming back on reload
    try {
      await apiDelete('/api/session/conversationHistory');
      // Notify other devices that all conversations were cleared
      apiPost('/api/sync/notify', { type: 'conversation_list_changed' }).catch(err => logger.warn('Sync notification failed:', err));
    } catch (error) {
      logger.error('Failed to clear conversation history from Redis:', error);
    }

    // Clear conversations and intermediate steps from IndexedDB
    try {
      await clearAllConversationsFromDB();
      await clearAllIntermediateSteps();
    } catch (error) {
      logger.error('Failed to clear data from IndexedDB:', error);
    }

    // Cleanup images from Redis
    try {
      await fetch('/api/session/cleanup', { method: 'POST' });
    } catch (error) {
      logger.error('Failed to cleanup session images:', error);
    }
  };

  const handleDeleteConversation = async (conversation: Conversation) => {
    try {
      await apiDelete(`/api/conversations/${conversation.id}`);

      const updatedConversations = conversations.filter(
          (c) => c.id !== conversation.id,
      );

      homeDispatch({ field: 'conversations', value: updatedConversations });
      chatDispatch({ field: 'searchTerm', value: '' });

      // Await saveConversations to ensure Redis is updated before any sync operations
      await saveConversations(updatedConversations);

      // Also delete from IndexedDB to prevent messages from coming back
      try {
        await deleteConversationFromDB(conversation.id);
        await clearConversationIntermediateSteps(conversation.id);
      } catch (dbError) {
        logger.error('Failed to delete conversation from IndexedDB:', dbError);
      }

      if (updatedConversations.length > 0) {
        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversations[updatedConversations.length - 1],
        });

        await saveConversation(updatedConversations[updatedConversations.length - 1]);
      } else {
        handleNewConversation();
      }
      toast.success('Conversation deleted successfully');
    } catch (error) {
      logger.error('Failed to delete conversation:', error);
      toast.error('Failed to delete conversation.');
    }
  };

  const handleToggleChatbar = () => {
    homeDispatch({ field: 'showChatbar', value: !showChatbar });
    // Use user-specific storage key to prevent data leakage between users
    setUserSessionItem('showChatbar', JSON.stringify(!showChatbar));
  };

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    if (e.dataTransfer) {
      const conversation = JSON.parse(e.dataTransfer.getData('conversation'));
      handleUpdateConversation(conversation, { key: 'folderId', value: 0 });
      chatDispatch({ field: 'searchTerm', value: '' });
      (e.target as HTMLElement).style.background = 'none';
    }
  };

  useEffect(() => {
    if (searchTerm) {
      chatDispatch({
        field: 'filteredConversations',
        value: conversations.filter((conversation) => {
          const searchable =
            conversation.name.toLocaleLowerCase() +
            ' ' +
            conversation.messages.map((message) => message.content).join(' ');
          return searchable.toLowerCase().includes(searchTerm.toLowerCase());
        }),
      });
    } else {
      chatDispatch({
        field: 'filteredConversations',
        value: conversations,
      });
    }
  }, [searchTerm, conversations, chatDispatch]);

  return (
    <ChatbarContext.Provider
      value={{
        ...chatBarContextValue,
        handleDeleteConversation,
        handleClearConversations,
        handleImportConversations,
        handleExportData,
      }}
    >
      <Sidebar<Conversation>
        side={'left'}
        isOpen={showChatbar}
        addItemButtonTitle={t('New chat')}
        itemComponent={<Conversations conversations={filteredConversations} />}
        folderComponent={<ChatFolders searchTerm={searchTerm} />}
        items={filteredConversations}
        searchTerm={searchTerm}
        handleSearchTerm={(searchTerm: string) =>
          chatDispatch({ field: 'searchTerm', value: searchTerm })
        }
        toggleOpen={handleToggleChatbar}
        handleCreateItem={handleNewConversation}
        handleCreateFolder={() => handleCreateFolder(t('New folder'), 'chat')}
        handleDrop={handleDrop}
        footerComponent={<ChatbarSettings />}
        loading={loading}
        loadingComponent={<ConversationSkeleton count={5} />}
        searchInputRef={searchInputRef}
      />
    </ChatbarContext.Provider>
  );
};
