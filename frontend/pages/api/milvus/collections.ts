import { NextApiRequest, NextApiResponse } from 'next';

import {
  classifyMilvusCollectionScope,
  SHARED_MILVUS_COLLECTIONS,
} from '@/utils/app/milvusCollections';

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
    // This is a lightweight helper for the upload UI. Shared collections are
    // intentional first-class corpora in the same Milvus database as
    // user-scoped collections, but they are explicitly labeled for ingestion
    // policy and audit handling.
    const collections = [username, ...SHARED_MILVUS_COLLECTIONS];

    // Remove duplicates and sort
    const uniqueCollections = Array.from(new Set(collections)).sort();

    res.status(200).json({
      collections: uniqueCollections,
      collectionOptions: uniqueCollections.map((name) => ({
        name,
        scope: classifyMilvusCollectionScope(name),
      })),
      collectionPolicy: {
        databaseName: 'default',
        sharedCollections: SHARED_MILVUS_COLLECTIONS,
        userCollection: username,
      },
    });
  } catch (error) {
    console.error('Error fetching collections:', error);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
}
