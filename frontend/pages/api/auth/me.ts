import { NextApiRequest, NextApiResponse } from 'next';
import { getSession } from '@/utils/auth/session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getSession(req, res);

    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    return res.status(200).json({
      authenticated: true,
      user: {
        id: session.userId,
        username: session.username,
        name: session.name,
      },
      loginTime: session.loginTime,
      lastActivity: session.lastActivity,
    });
  } catch (error) {
    console.error('Session check error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
