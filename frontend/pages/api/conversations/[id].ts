import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSetWithExpiry, jsonDel } from '../session/redis';
import { getSession } from '@/utils/auth/session';

/**
 * Verify that a user owns a conversation by checking if the conversation ID
 * exists in the user's conversations set in Redis.
 */
async function verifyConversationOwnership(username: string, conversationId: string): Promise<boolean> {
  const redis = getRedis();
  const userConversationsKey = sessionKey(['user', username, 'conversations']);
  return await redis.sismember(userConversationsKey, conversationId) === 1;
}

/**
 * Endpoint for conversation operations:
 * GET: Get latest conversation state including any async job results.
 * PUT: Save conversation state.
 * DELETE: Delete a conversation.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid conversation ID' });
  }

  const redis = getRedis();
  const conversationKey = sessionKey(['conversation', id]);
  const userConversationsKey = sessionKey(['user', session.username, 'conversations']);

  if (req.method === 'PUT') {
    const updatedData = req.body;

    try {
      // Fetch existing conversation to merge with
      const existingData = await jsonGet(conversationKey);

      // If conversation exists, verify ownership before allowing updates
      if (existingData) {
        const ownsConversation = await verifyConversationOwnership(session.username, id);
        if (!ownsConversation) {
          return res.status(403).json({ error: 'Forbidden: You do not have access to this conversation' });
        }
      }

      const dataToSave = {
        ...existingData,
        ...updatedData,
        updatedAt: updatedData.updatedAt || Date.now(),
      };

      // Save the merged conversation state (expire after 7 days)
      await jsonSetWithExpiry(conversationKey, dataToSave, 60 * 60 * 24 * 7);

      // Add conversation to user's set of conversations (if not already present)
      await redis.sadd(userConversationsKey, id);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error saving conversation:', error);
      return res.status(500).json({ error: 'Failed to save conversation' });
    }
  } else if (req.method === 'DELETE') {
    try {
      // Verify ownership before allowing deletion
      const ownsConversation = await verifyConversationOwnership(session.username, id);
      if (!ownsConversation) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this conversation' });
      }

      // Delete the conversation key
      await jsonDel(conversationKey);

      // Remove the conversation ID from the user's set
      await redis.srem(userConversationsKey, id);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error deleting conversation:', error);
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
  } else if (req.method === 'GET') {
    try {
      // Verify ownership before allowing access
      const ownsConversation = await verifyConversationOwnership(session.username, id);
      if (!ownsConversation) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this conversation' });
      }

      // First check for saved conversation data
      const conversationData = await jsonGet(conversationKey);

      if (conversationData) {
        return res.status(200).json(conversationData);
      }

      // Check for any pending/completed async jobs for this conversation
      const jobKey = sessionKey(['conversation-job', id]);
      const jobData = await jsonGet(jobKey);

      if (jobData && typeof jobData === 'object' && 'messages' in jobData) {
        // Return the full conversation state from the job
        return res.status(200).json({
          conversationId: id,
          messages: jobData.messages,
          status: (jobData as any).status || 'completed',
        });
      }

      // No conversation found, return empty state
      return res.status(404).json({ error: 'Conversation not found' });
    } catch (error) {
      console.error('Error fetching conversation:', error);
      return res.status(500).json({ error: 'Failed to fetch conversation' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
}
