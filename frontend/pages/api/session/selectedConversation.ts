import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSetWithExpiry } from './redis';
import { getOrSetSessionId, getUserId } from './_utils';

// Utility function to strip base64 content from objects
function stripBase64FromObject(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => stripBase64FromObject(item));
  }

  const cleaned = { ...obj };

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') {
      // Remove base64 image data
      if (value.startsWith('data:image/') || (value.length > 1000 && value.includes('base64'))) {
        cleaned[key] = '';
      }
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = stripBase64FromObject(value);
    }
  }

  return cleaned;
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb', // Match global limit for consistency
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const redis = getRedis();
  const sid = getOrSetSessionId(req, res);
  const userId = await getUserId(req, res);
  // Store selected conversation at user level for cross-device persistence
  const key = sessionKey(['user', userId, 'selectedConversation']);

  if (req.method === 'GET') {
    try {
      const data = await jsonGet(key);
      if (!data) return res.status(200).json(null);
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to load selectedConversation' });
    }
  }

  if (req.method === 'PUT') {
    try {
      let conversation = req.body;

      // Trim messages length to avoid excessive storage
      if (conversation?.messages?.length > 200) {
        conversation.messages = conversation.messages.slice(-200);
      }

      // Aggressively remove any base64 content to prevent storage bloat and LLM context overflow
      conversation = stripBase64FromObject(conversation);

      try {
        await jsonSetWithExpiry(key, conversation, 60 * 60 * 24 * 7);
      } catch (err) {
        console.error('Failed to save selectedConversation to Redis', err);
        // Fall through – respond 204 so UI continues working even if Redis is down
      }
      return res.status(204).end();
    } catch (e) {
      console.error('Error handling PUT /api/session/selectedConversation', e);
      return res.status(204).end();
    }
  }

  res.setHeader('Allow', ['GET', 'PUT']);
  return res.status(405).end('Method Not Allowed');
}
