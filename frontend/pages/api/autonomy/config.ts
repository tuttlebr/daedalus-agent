import type { NextApiRequest, NextApiResponse } from 'next';

import { getConfig, saveConfig } from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;

  if (req.method === 'GET') {
    return res.status(200).json(await getConfig(userId));
  }

  if (req.method === 'PUT') {
    return res.status(200).json(await saveConfig(userId, req.body || {}));
  }

  res.setHeader('Allow', ['GET', 'PUT']);
  return res.status(405).end('Method Not Allowed');
}
