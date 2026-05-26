import type { NextApiRequest, NextApiResponse } from 'next';

import { listFeed } from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end('Method Not Allowed');
  }

  return res.status(200).json(await listFeed(session.username));
}
