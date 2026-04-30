import type { NextApiRequest, NextApiResponse } from 'next';
import { sessionKey, jsonGet, jsonSetWithExpiry } from './redis';
import { getOrSetSessionId, requireAuthenticatedUser } from './_utils';
import { stripBase64FromObject } from './sanitize';
import { publishSyncEvent } from '@/utils/sync/publish';

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

  getOrSetSessionId(req, res); // Side effect: ensures session cookie is set
  const userId = session.username;
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

      await jsonSetWithExpiry(key, conversation, 60 * 60 * 24 * 7);

      // Notify other sessions about the selection change
      publishSyncEvent(userId, {
        type: 'selected_conversation_changed',
        timestamp: Date.now(),
        data: { conversationId: conversation?.id },
      }).catch(() => {}); // best-effort

      return res.status(204).end();
    } catch (err) {
      console.error('Failed to save selectedConversation to Redis', err);
      // Return error status so frontend knows the save failed
      return res.status(500).json({ error: 'Failed to save conversation to Redis' });
    }
  }

  res.setHeader('Allow', ['GET', 'PUT']);
  return res.status(405).end('Method Not Allowed');
}
