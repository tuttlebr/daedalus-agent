import { getRedis, sessionKey } from '@/server/session/redis';

/**
 * Verify that a user owns a conversation.
 *
 * This is an authorization primitive: every route that reads or mutates a
 * conversation by id gates on it. It lives here so there is exactly one
 * definition to audit — two copies of an ownership check drift silently, and
 * the drift is only visible as a cross-user data leak.
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
