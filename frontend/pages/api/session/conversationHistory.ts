import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSetWithExpiry } from './redis';
import { getOrSetSessionId, getUserId } from './_utils';
import { stripBase64FromObject, clampConversations } from './sanitize';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb', // Match global limit for consistency
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const redis = getRedis();
  getOrSetSessionId(req, res); // Side effect: ensures session cookie is set
  const userId = await getUserId(req, res);
  // Store conversations at user level for cross-device persistence
  const key = sessionKey(['user', userId, 'conversationHistory']);

  if (req.method === 'GET') {
    try {
      const data = await jsonGet(key);
      if (!data) return res.status(200).json([]);
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to load conversationHistory' });
    }
  }

  if (req.method === 'PUT') {
    try {
      let body = Array.isArray(req.body) ? req.body : [];
      // Strip base64 content before clamping
      body = stripBase64FromObject(body);
      const clamped = clampConversations(body);
      try {
        await jsonSetWithExpiry(key, clamped, 60 * 60 * 24 * 7);
      } catch (err) {
        console.error('Failed to save conversationHistory to Redis', err);
        // Fall through – respond 204 so UI continues working even if Redis is down
      }
      return res.status(204).end();
    } catch (e) {
      console.error('Error handling PUT /api/session/conversationHistory', e);
      return res.status(204).end();
    }
  }

  if (req.method === 'DELETE') {
    try {
      // Delete the conversationHistory key from Redis
      await redis.del(key);

      // Also clear the selectedConversation for this user
      const selectedConversationKey = sessionKey(['user', userId, 'selectedConversation']);
      await redis.del(selectedConversationKey);

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('Error deleting conversationHistory from Redis', e);
      return res.status(500).json({ error: 'Failed to delete conversation history' });
    }
  }

  res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
  return res.status(405).end('Method Not Allowed');
}
