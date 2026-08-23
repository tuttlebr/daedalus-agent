import type { NextApiRequest, NextApiResponse } from 'next';

import { getMemoryRetentionHealth } from '@/server/chat/memoryRetention';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end('Method Not Allowed');
  }
  try {
    return res
      .status(200)
      .json(await getMemoryRetentionHealth(session.username));
  } catch {
    return res
      .status(503)
      .json({ error: 'Memory retention status is temporarily unavailable.' });
  }
}
