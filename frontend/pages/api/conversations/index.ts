import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, jsonMGet, sessionKey } from '../session/redis';
import { getSession } from '@/utils/auth/session';

/**
 * Endpoint to get all conversations for the authenticated user.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getSession(req, res);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const redis = getRedis();
    const userConversationsKey = sessionKey(['user', session.username, 'conversations']);

    // Fetch all conversation IDs from the user's set
    const conversationIds = await redis.smembers(userConversationsKey);

    if (!conversationIds || conversationIds.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch all conversation data in a single MGET call
    const conversationKeys = conversationIds.map(id => sessionKey(['conversation', id]));
    const conversations = await jsonMGet(conversationKeys, '$');

    // Filter out any null conversations and add the id to the conversation object
    const validConversations = conversations
      .map((conv, index) => {
        if (conv) {
          return {
            ...conv,
            id: conversationIds[index],
          };
        }
        return null;
      })
      .filter(Boolean);

    return res.status(200).json(validConversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
}
