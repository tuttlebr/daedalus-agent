import {
  ConversationWriteError,
  readConversationForUser,
} from './conversationStore';

/**
 * Verify that a user owns a conversation.
 *
 * Authorization for direct reads and writes comes from set membership, never
 * from client-supplied history or selection IDs. conversationDeletion.ts checks
 * the same membership atomically with deletion; it also allows users to discard
 * their private history copies without granting access to a shared record.
 */
export async function verifyConversationOwnership(
  username: string,
  conversationId: string,
): Promise<boolean> {
  try {
    await readConversationForUser(username, conversationId);
    return true;
  } catch (error) {
    if (error instanceof ConversationWriteError) return false;
    throw error;
  }
}
