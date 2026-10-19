import type { NextApiRequest, NextApiResponse } from 'next';

import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';
import { sessionKey, jsonGet, jsonSetWithExpiry } from '@/server/session/redis';

// The selection is an id pointer; conversation content is saved separately.
// Tabs loaded before that change still send the whole conversation they just
// saved through /api/conversations/:id, and treat a rejection as a failed save.
// Accept the same body size as that route and keep only the id.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

const MAX_ID_LENGTH = 512;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  getOrSetSessionId(req, res); // Side effect: ensures session cookie is set
  const userId = session.username;
  // Store selected conversation at user level for cross-device persistence
  const key = sessionKey(['user', userId, 'selectedConversation']);

  if (req.method === 'GET') {
    try {
      // Older records hold a copy of the conversation; nothing refreshes it
      // any more. Clients read only its id.
      const data = await jsonGet(key);
      if (!data) return res.status(200).json(null);
      return res.status(200).json(data);
    } catch (e) {
      return res
        .status(500)
        .json({ error: 'Failed to load selectedConversation' });
    }
  }

  if (req.method === 'PUT') {
    const id = req.body?.id;
    if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) {
      return res.status(400).json({ error: 'Expected a conversation id' });
    }
    try {
      // Deletion and history clearing remove this pointer when it names the
      // deleted conversation (server/session/conversationDeletion.ts).
      await jsonSetWithExpiry(key, { id }, 60 * 60 * 24 * 7);
      return res.status(204).end();
    } catch (err) {
      console.error('Failed to save selectedConversation to Redis', err);
      // Return error status so frontend knows the save failed
      return res
        .status(500)
        .json({ error: 'Failed to save the selected conversation' });
    }
  }

  res.setHeader('Allow', ['GET', 'PUT']);
  return res.status(405).end('Method Not Allowed');
}
