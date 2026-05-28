import type { NextApiRequest, NextApiResponse } from 'next';

import { enqueueRun, listRuns } from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;

  if (req.method === 'GET') {
    return res.status(200).json(await listRuns(userId));
  }

  if (req.method === 'POST') {
    return res.status(202).json(await enqueueRun(userId, req.body || {}));
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end('Method Not Allowed');
}
