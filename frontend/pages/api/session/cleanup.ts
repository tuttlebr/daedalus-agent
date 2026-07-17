import { NextApiRequest, NextApiResponse } from 'next';

import { cleanupSessionDocuments } from './documentStorage';
import { cleanupSessionImages } from './imageStorage';

import {
  getOrSetSessionId,
  requireAuthenticatedUser,
} from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await requireAuthenticatedUser(req, res);
    if (!session) return;

    const sessionId = getOrSetSessionId(req, res);
    const userId = session.username;

    const [imagesDeleted, documentsDeleted] = await Promise.all([
      cleanupSessionImages(sessionId, userId),
      cleanupSessionDocuments(sessionId, userId),
    ]);

    // Clear session storage
    // Note: Session cleanup is handled by the auth system

    return res.status(200).json({
      message: 'Session cleaned up successfully',
      imagesDeleted,
      documentsDeleted,
    });
  } catch (error) {
    console.error('Error cleaning up session:', error);
    return res.status(500).json({ error: 'Failed to cleanup session' });
  }
}
