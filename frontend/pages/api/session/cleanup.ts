import { NextApiRequest, NextApiResponse } from 'next';
import { getOrSetSessionId, getUserId } from './_utils';
import { cleanupSessionImages } from './imageStorage';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionId = getOrSetSessionId(req, res);
    const userId = await getUserId(req, res);

    // Cleanup all images associated with this session and user
    const deletedCount = await cleanupSessionImages(sessionId, userId);

    // Clear session storage
    // Note: Session cleanup is handled by the auth system

    return res.status(200).json({
      message: 'Session cleaned up successfully',
      imagesDeleted: deletedCount
    });
  } catch (error) {
    console.error('Error cleaning up session:', error);
    return res.status(500).json({ error: 'Failed to cleanup session' });
  }
}
