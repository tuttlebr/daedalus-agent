import type { NextApiRequest, NextApiResponse } from 'next';

import { getGoogleWorkspaceConnections } from '@/server/googleWorkspaceConnections';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const connections = await getGoogleWorkspaceConnections(session.username);
    return res.status(200).json({ connections });
  } catch (error) {
    console.error('Failed to load Google Workspace connection state', error);
    return res.status(503).json({
      error: 'Google Workspace connection status is temporarily unavailable',
    });
  }
}
