import { NextApiRequest, NextApiResponse } from 'next';
import { requireAuthenticatedUser } from '../session/_utils';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await requireAuthenticatedUser(req, res);
    if (!session) return;
    const username = session.username;

    // User uploads are private. Curated/shared corpora are exposed through
    // dedicated retriever tools, not as writable upload targets.
    const collections = [username];

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
      collections: [username],
    });
  }
}
