import type { NextApiRequest, NextApiResponse } from 'next';

import {
  cancelQueuedRequest,
  listQueuedRequests,
} from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;

  if (req.method === 'GET') {
    return res.status(200).json(await listQueuedRequests(userId));
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'A queued request id is required.' });
    }
    const cancelled = await cancelQueuedRequest(userId, id);
    if (!cancelled) {
      // Already dequeued by the worker, or never existed. Both are terminal
      // from the caller's point of view.
      return res.status(404).json({ error: 'Queued request not found.' });
    }
    return res.status(200).json({ id: id.trim(), cancelled: true });
  }

  res.setHeader('Allow', ['GET', 'DELETE']);
  return res.status(405).end('Method Not Allowed');
}
