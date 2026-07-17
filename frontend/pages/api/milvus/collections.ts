import { NextApiRequest, NextApiResponse } from 'next';

import { getMilvusMetadata } from '@/server/milvusMetadata';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate once, before the try, so the catch never re-auths a
  // possibly-already-responded request (which could double-send) and never
  // masks a real failure behind a silent 200 fallback (F-018).
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const username = session.username;

  try {
    const metadata = await getMilvusMetadata(username);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(metadata);
  } catch (error) {
    console.error('Error fetching collections:', error);
    return res
      .status(503)
      .json({ error: 'Collection metadata is unavailable' });
  }
}
