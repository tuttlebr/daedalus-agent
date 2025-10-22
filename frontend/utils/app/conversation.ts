import { Conversation } from '@/types/chat';
import toast from 'react-hot-toast';
import { apiGet, apiPut } from '@/utils/app/api';
import { restoreMessageImages, cleanMessagesForStorage, stripBase64Content } from './imageHandler';
import { getUserSessionItem, setUserSessionItem, removeUserSessionItem } from './storage';

export const updateConversation = (
  updatedConversation: Conversation,
  allConversations: Conversation[],
) => {
  const updatedConversations = allConversations.map((c) => {
    if (c.id === updatedConversation.id) {
      return updatedConversation;
    }

    return c;
  });

  saveConversation(updatedConversation);
  saveConversations(updatedConversations);

  return {
    single: updatedConversation,
    all: updatedConversations,
  };
};

export const saveConversation = async (conversation: Conversation) => {
  try {
    // Clean messages to remove base64 content before storing
    let cleanedConversation = {
      ...conversation,
      messages: cleanMessagesForStorage(conversation.messages),
    };

    // Aggressively strip any remaining base64 content as a safety measure
    cleanedConversation = stripBase64Content(cleanedConversation);

    // Use user-specific storage key to prevent data leakage between users
    setUserSessionItem('selectedConversation', JSON.stringify(cleanedConversation));
    await apiPut(`/api/conversations/${conversation.id}`, cleanedConversation);
  } catch (error) {
    console.log('Failed to persist conversation to server', error);
    toast.error('Failed to save conversation.');
  }
};

export const saveConversations = async (conversations: Conversation[]) => {
  try {
    // Clean all conversations to remove base64 content before storing
    let cleanedConversations = conversations.map(conversation => ({
      ...conversation,
      messages: cleanMessagesForStorage(conversation.messages),
    }));

    // Aggressively strip any remaining base64 content as a safety measure
    cleanedConversations = stripBase64Content(cleanedConversations);

    // Use user-specific storage key to prevent data leakage between users
    setUserSessionItem('conversationHistory', JSON.stringify(cleanedConversations));
    await apiPut('/api/session/conversationHistory', cleanedConversations);
  } catch (error) {
    console.log('Failed to persist conversations to server', error);
    toast.error('Failed to save conversations.');
  }
};

export const loadConversation = async (): Promise<Conversation | null> => {
  try {
    let conversation = await apiGet<Conversation | null>('/api/session/selectedConversation');
    if (conversation) {
      // Strip any base64 content that might have been stored
      const cleanedConversation = stripBase64Content(conversation);
      if (cleanedConversation && cleanedConversation.messages) {
        // Restore image references in loaded messages
        cleanedConversation.messages = restoreMessageImages(cleanedConversation.messages);
      }
      return cleanedConversation;
    }
    return conversation;
  } catch (e) {
    return null;
  }
};

export const loadConversations = async (): Promise<Conversation[]> => {
  try {
    let conversations = await apiGet<Conversation[]>('/api/session/conversationHistory');
    // Strip any base64 content and restore image references in all loaded conversations
    conversations = stripBase64Content(conversations);
    return conversations.map(conv => {
      if (conv.messages) {
        conv.messages = restoreMessageImages(conv.messages);
      }
      return conv;
    });
  } catch (e) {
    return [];
  }
};
