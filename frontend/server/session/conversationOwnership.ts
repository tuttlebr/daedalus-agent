import { getRedis, sessionKey } from '@/server/session/redis';

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
  const userConversationsKey = sessionKey(['user', username, 'conversations']);
  return (
    (await getRedis().sismember(userConversationsKey, conversationId)) === 1
  );
}
