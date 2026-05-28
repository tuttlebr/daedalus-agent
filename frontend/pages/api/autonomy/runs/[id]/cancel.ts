import type { NextApiRequest, NextApiResponse } from 'next';

import { cancelRun } from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;
  const runId = String(req.query.id || '');

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end('Method Not Allowed');
  }

  await cancelRun(userId, runId);
  return res.status(200).json({ success: true });
}
