export const SHARED_MILVUS_COLLECTIONS = [
  'kubernetes',
  'mentalhealth',
  'nvidia',
  'semianalysis',
  'vetpartner',
] as const;

export type MilvusCollectionScope = 'shared' | 'user';

export interface MilvusCollectionProvenance {
  uploader: string;
  source: string;
  targetCollection: string;
  requestedCollection: string;
  collectionScope: MilvusCollectionScope;
  databaseName: string;
  timestamp: string;
}

export interface MilvusCollectionTarget {
  collectionName: string;
  collectionScope: MilvusCollectionScope;
  provenance: MilvusCollectionProvenance;
}

interface ResolveMilvusCollectionTargetOptions {
  targetCollection?: string;
  username: string;
  requestedScope?: string;
  source: string;
  now?: () => Date;
}

const SHARED_COLLECTION_SET = new Set<string>(SHARED_MILVUS_COLLECTIONS);

export function isSharedMilvusCollection(collectionName: string): boolean {
  return SHARED_COLLECTION_SET.has(collectionName.trim().toLowerCase());
}

export function classifyMilvusCollectionScope(
  collectionName: string,
): MilvusCollectionScope {
  return isSharedMilvusCollection(collectionName) ? 'shared' : 'user';
}

export function resolveMilvusCollectionTarget({
  targetCollection,
  username,
  requestedScope,
  source,
  now = () => new Date(),
}: ResolveMilvusCollectionTargetOptions): MilvusCollectionTarget {
  const requestedCollection = targetCollection?.trim() || username;
  const collectionScope = classifyMilvusCollectionScope(requestedCollection);
  const normalizedRequestedScope = requestedScope?.trim().toLowerCase();

  if (
    normalizedRequestedScope &&
    normalizedRequestedScope !== collectionScope
  ) {
    throw new Error(
      `Collection scope "${normalizedRequestedScope}" does not match ` +
        `"${requestedCollection}" (${collectionScope}).`,
    );
  }

  return {
    collectionName: requestedCollection,
    collectionScope,
    provenance: {
      uploader: username,
      source,
      targetCollection: requestedCollection,
      requestedCollection,
      collectionScope,
      databaseName: 'default',
      timestamp: now().toISOString(),
    },
  };
}

