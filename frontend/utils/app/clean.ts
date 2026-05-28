import { Conversation } from '@/types/chat';

import { sanitizeConversationAssistantReplays } from './conversationReplay';
import { cleanMessagesForStorage, restoreMessageImages } from './imageHandler';

export const cleanSelectedConversation = (conversation: Conversation) => {
  const cleanedMessages = cleanMessagesForStorage(conversation.messages || []);

  return sanitizeConversationAssistantReplays({
    ...conversation,
    folderId: conversation.folderId || null,
    messages: cleanedMessages,
  });
};

export const cleanConversationHistory = (
  history: Conversation[],
): Conversation[] => {
  if (!Array.isArray(history)) {
    console.warn('history is not an array. Returning an empty array.');
    return [];
  }

  return history
    .map((conversation) => cleanSelectedConversation(conversation))
    .map((conversation) => ({
      ...conversation,
      messages: restoreMessageImages(conversation.messages || []),
    }))
    .map((conversation) => sanitizeConversationAssistantReplays(conversation));
};
