import { NextApiRequest, NextApiResponse } from 'next';
import { requireAuthenticatedUser } from '../session/_utils';

const SHARED_UPLOAD_COLLECTIONS = [
  'kubernetes',
  'mentalhealth',
  'nvidia',
  'semianalysis',
  'vetpartner',
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await requireAuthenticatedUser(req, res);
    if (!session) return;
    const username = session.username;

    // This is a lightweight helper for the upload UI. Shared writable targets
    // are allow-listed here and in nat_nv_ingest collection resolution.
    const collections = [username, ...SHARED_UPLOAD_COLLECTIONS];

    // Remove duplicates and sort
    const uniqueCollections = Array.from(new Set(collections)).sort();

    res.status(200).json({ collections: uniqueCollections });
  } catch (error) {
    console.error('Error fetching collections:', error);

    const session = await requireAuthenticatedUser(req, res);
    if (!session) return;
    const username = session.username;

    // Return minimal fallback
    res.status(200).json({
      collections: [username, 'nvidia'],
    });
  }
}
