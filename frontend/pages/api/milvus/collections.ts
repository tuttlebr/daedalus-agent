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

    // For now, return a predefined list of collections
    // In production, this should be replaced with a proper backend endpoint
    // that returns structured data instead of natural language
    const collections = [
      username,
      'kubernetes',
      'mentalhealth',
      'nvidia',
      'semianalysis',
      'vetpartner',
    ];

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
      collections: [username, 'nvidia']
    });
  }
}
