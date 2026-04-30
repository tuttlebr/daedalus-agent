import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSetWithExpiry } from './redis';
import { getOrSetSessionId, requireAuthenticatedUser } from './_utils';
import { stripBase64FromObject, clampConversations } from './sanitize';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb', // Match global limit for consistency
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const redis = getRedis();
  getOrSetSessionId(req, res); // Side effect: ensures session cookie is set
  const userId = session.username;
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
      let incoming = Array.isArray(req.body) ? req.body : [];
      // Strip base64 content before processing
      incoming = stripBase64FromObject(incoming);

      try {
        // Merge with existing history instead of overwriting, so conversations
        // not held in the frontend's limited in-memory list are preserved.
        const existing = await jsonGet(key);
        const existingArray: any[] = Array.isArray(existing) ? existing : [];

        // Build a map of incoming conversations by ID for fast lookup
        const incomingById = new Map<string, any>();
        for (const conv of incoming) {
          if (conv && conv.id) {
            incomingById.set(conv.id, conv);
          }
        }

        // Start with existing conversations, updating any that appear in the incoming set
        const merged: any[] = [];
        const seen = new Set<string>();

        for (const conv of existingArray) {
          if (!conv || !conv.id) continue;
          const updated = incomingById.get(conv.id);
          merged.push(updated ?? conv);
          seen.add(conv.id);
        }

        // Add any new conversations from incoming that weren't already in the list
        for (const conv of incoming) {
          if (conv && conv.id && !seen.has(conv.id)) {
            merged.push(conv);
          }
        }

        const clamped = clampConversations(merged);
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
