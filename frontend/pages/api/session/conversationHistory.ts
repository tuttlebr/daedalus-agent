import type { NextApiRequest, NextApiResponse } from 'next';

import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import { deleteConversationForUser } from '@/server/session/conversationDeletion';
import {
  listConversationHistoryForUser,
  mergeConversationHistoryForUser,
} from '@/server/session/conversationHistory';
import { jsonGet, sessionKey } from '@/server/session/redis';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb', // Match global limit for consistency
    },
  },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  getOrSetSessionId(req, res); // Side effect: ensures session cookie is set
  const userId = session.username;

  if (req.method === 'GET') {
    try {
      return res.status(200).json(await listConversationHistoryForUser(userId));
    } catch (e) {
      return res
        .status(500)
        .json({ error: 'Failed to load conversationHistory' });
    }
  }

  if (req.method === 'PUT') {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Expected a conversation array' });
    }
    try {
      await mergeConversationHistoryForUser(userId, req.body);
      return res.status(204).end();
    } catch (error) {
      console.error('Failed to save conversationHistory to Redis', error);
      return res
        .status(500)
        .json({ error: 'Failed to save conversation history' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const history = await listConversationHistoryForUser(userId);
      const selected = await jsonGet(
        sessionKey(['user', userId, 'selectedConversation']),
      );
      const ids = new Set(
        [...history, selected]
          .map((conversation) => conversation?.id)
          .filter(Boolean),
      );
      for (const id of ids) {
        await deleteConversationForUser(userId, id);
      }

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('Error deleting conversationHistory from Redis', e);
      return res
        .status(500)
        .json({ error: 'Failed to delete conversation history' });
    }
  }

  res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
  return res.status(405).end('Method Not Allowed');
}
