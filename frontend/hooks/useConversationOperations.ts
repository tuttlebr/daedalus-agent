import { saveConversation, saveConversations, updateConversation} from '@/utils/app/conversation';
import { v4 as uuidv4 } from 'uuid';
import { setUserSessionItem } from '@/utils/app/storage';
import { Conversation } from '@/types/chat';
import { ActionType } from '@/hooks/useCreateReducer';
import { HomeInitialState } from '@/pages/api/home/home.state';

interface UseConversationOperationsParams {
  conversations: Conversation[];
  dispatch: React.Dispatch<ActionType<HomeInitialState>>;
  t: (key: string) => string;
  appConfig: Record<string, unknown>;
}

export const useConversationOperations = ({ conversations, dispatch, t, appConfig }: UseConversationOperationsParams) => {
  const handleSelectConversation = (conversation: Conversation) => {
    dispatch({
      field: 'selectedConversation',
      value: conversation,
    });

    // updating the session id based on the selected conversation
    // Use user-specific storage key to prevent data leakage between users
    setUserSessionItem('sessionId', conversation?.id);
    saveConversation(conversation);
  };

  const handleNewConversation = () => {
    const lastConversation = conversations[conversations.length - 1];

    const newConversation = {
      id: uuidv4(),
      name: t('New Conversation'),
      messages: [],
      folderId: null,
    };

    // setting new the session id for new chat conversation
    // Use user-specific storage key to prevent data leakage between users
    setUserSessionItem('sessionId', newConversation.id);
    const updatedConversations = [...conversations, newConversation];

    dispatch({ field: 'selectedConversation', value: newConversation });
    dispatch({ field: 'conversations', value: updatedConversations });

    saveConversations(updatedConversations);

    dispatch({ field: 'loading', value: false });
  };

  const handleUpdateConversation = (conversation: Conversation, data: { key: string; value: any }) => {
    const updatedConversation = {
      ...conversation,
      [data.key]: data.value,
    };

    const { single, all } = updateConversation(updatedConversation, conversations);

    dispatch({ field: 'selectedConversation', value: single });
    dispatch({ field: 'conversations', value: all });

    saveConversations(all);
  };

  return { handleSelectConversation, handleNewConversation, handleUpdateConversation };
};
