import type { NextApiRequest, NextApiResponse } from 'next';

import { getRun, listEvents } from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;
  const runId = String(req.query.id || '');

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end('Method Not Allowed');
  }

  const run = await getRun(userId, runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  return res.status(200).json({
    run,
    events: await listEvents(userId, runId),
  });
}
