import type { NextApiRequest, NextApiResponse } from 'next';
import { getSession } from '@/utils/auth/session';
import { publishConversationUpdate, publishSyncEvent } from '@/utils/sync/publish';
import { Conversation } from '@/types/chat';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};

/**
 * Notify other sessions/devices about conversation changes via Redis pub/sub.
 * Accepts:
 *   - type: 'conversation_updated' | 'conversation_deleted' | 'conversation_list_changed'
 *   - conversationId: string (required for conversation_updated/deleted)
 *   - conversation: Conversation (optional, for conversation_updated)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = session.username;
  if (!userId) {
    return res.status(400).json({ error: 'Invalid user' });
  }

  const { type, conversationId, conversation } = req.body;

  try {
    switch (type) {
      case 'conversation_updated':
        if (conversation) {
          await publishConversationUpdate(userId, conversation as Conversation);
        }
        break;

      case 'conversation_deleted':
      case 'conversation_list_changed':
        await publishSyncEvent(userId, {
          type: type as 'conversation_updated',
          timestamp: Date.now(),
          data: { conversationId },
        });
        break;

      default:
        return res.status(400).json({ error: `Unknown event type: ${type}` });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to publish sync notification:', error);
    return res.status(500).json({ error: 'Failed to publish notification' });
  }
}
