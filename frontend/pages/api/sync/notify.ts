import type { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';
import { publishConversationUpdate } from '@/utils/sync/publish';

// The notification names a conversation; receivers fetch its record.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb',
    },
  },
};

const MAX_ID_LENGTH = 512;

function boundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

/**
 * Notify the user's other sessions that a conversation was saved.
 * Accepts `{ type: 'conversation_updated', conversationId, revision? }`.
 * The event carries only the id and committed revision: a receiver that does
 * not already hold that revision reads the record itself.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
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

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected a notification object' });
  }
  const { type, conversationId, revision } = body as Record<string, unknown>;
  if (type !== 'conversation_updated') {
    return res.status(400).json({ error: `Unknown event type: ${type}` });
  }
  if (!boundedString(conversationId)) {
    return res.status(400).json({ error: 'Invalid conversation ID' });
  }
  if (revision !== undefined && !boundedString(revision)) {
    return res.status(400).json({ error: 'Invalid revision' });
  }

  try {
    await publishConversationUpdate(userId, conversationId, revision);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to publish sync notification:', error);
    return res.status(500).json({ error: 'Failed to publish notification' });
  }
}
