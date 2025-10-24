import { Conversation, Message } from '@/types/chat';
import toast from 'react-hot-toast';
import { apiGet, apiPut } from '@/utils/app/api';
import { restoreMessageImages, cleanMessagesForStorage, stripBase64Content } from './imageHandler';
import { getUserSessionItem, setUserSessionItem, removeUserSessionItem } from './storage';

// Memory optimization constants
const MAX_MESSAGES_IN_MEMORY = 50; // Keep only last 50 messages in memory
const MAX_CONVERSATIONS_IN_MEMORY = 5; // Keep only 5 most recent conversations
const MESSAGE_BATCH_SIZE = 20; // Load messages in batches of 20

// WeakMap for temporary data to allow garbage collection
const conversationCache = new WeakMap<Conversation, any>();

export const updateConversation = (
  updatedConversation: Conversation,
  allConversations: Conversation[],
) => {
  // Limit messages in the conversation
  const limitedConversation = {
    ...updatedConversation,
    messages: updatedConversation.messages.slice(-MAX_MESSAGES_IN_MEMORY)
  };

  const updatedConversations = allConversations.map((c) => {
    if (c.id === limitedConversation.id) {
      return limitedConversation;
    }
    return c;
  });

  saveConversation(limitedConversation);
  saveConversations(updatedConversations);

  return {
    single: limitedConversation,
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
    // toast.error('Failed to save conversation.');
  }
};

export const saveConversations = (conversations: Conversation[]) => {
  try {
    // Sort by most recent and limit number of conversations
    const recentConversations = conversations
      .sort((a, b) => {
        // Sort by last message timestamp or conversation id
        const aTime = a.messages[a.messages.length - 1]?.id || a.id;
        const bTime = b.messages[b.messages.length - 1]?.id || b.id;
        return bTime.localeCompare(aTime);
      })
      .slice(0, MAX_CONVERSATIONS_IN_MEMORY);

    // Clean all conversations to remove base64 content before storing
    let cleanedConversations = recentConversations.map(conversation => ({
      ...conversation,
      messages: cleanMessagesForStorage(conversation.messages.slice(-MAX_MESSAGES_IN_MEMORY)),
    }));

    // Aggressively strip any remaining base64 content as a safety measure
    cleanedConversations = stripBase64Content(cleanedConversations);

    // Use user-specific storage key to prevent data leakage between users
    setUserSessionItem('conversationHistory', JSON.stringify(cleanedConversations));
  } catch (error) {
    console.log('Failed to persist conversations to server', error);
    // toast.error('Failed to save conversations.');
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

// Cleanup function for old messages and conversations
export const cleanupOldConversations = (conversations: Conversation[]): Conversation[] => {
  return conversations
    .sort((a, b) => {
      const aTime = a.messages[a.messages.length - 1]?.id || a.id;
      const bTime = b.messages[b.messages.length - 1]?.id || b.id;
      return bTime.localeCompare(aTime);
    })
    .slice(0, MAX_CONVERSATIONS_IN_MEMORY)
    .map(conversation => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES_IN_MEMORY)
    }));
};

// Function to load messages in batches (for pagination)
export const loadMessageBatch = async (
  conversationId: string,
  offset: number = 0,
  limit: number = MESSAGE_BATCH_SIZE
): Promise<Message[]> => {
  try {
    // This would require a backend endpoint to support pagination
    // For now, return empty array as placeholder
    console.log(`Loading messages for conversation ${conversationId}, offset: ${offset}, limit: ${limit}`);
    return [];
  } catch (error) {
    console.error('Failed to load message batch:', error);
    return [];
  }
};
