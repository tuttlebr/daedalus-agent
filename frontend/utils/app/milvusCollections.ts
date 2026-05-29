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

/**
 * Raised when a caller targets a user-scoped collection that is not their own.
 * Callers should surface this as HTTP 403 (it is an authorization failure,
 * distinct from a scope-label mismatch which is a 400).
 */
export class MilvusCollectionOwnershipError extends Error {
  readonly requestedCollection: string;
  readonly username: string;

  constructor(requestedCollection: string, username: string) {
    super(
      `User-scoped collection "${requestedCollection}" is not owned by ` +
        `user "${username}".`,
    );
    this.name = 'MilvusCollectionOwnershipError';
    this.requestedCollection = requestedCollection;
    this.username = username;
  }
}

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

  // SECURITY (IDOR / cross-tenant write): a user-scoped collection must belong
  // to the requesting user. The only valid user collection name is the caller's
  // own username — /api/milvus/collections offers exactly [username, ...shared],
  // so there is no legitimate flow that targets a different user-scoped name.
  // Without this guard an authenticated user could pass another user's name as
  // the ingest target and poison their personal corpus. Shared collections are
  // intentional shared targets and are exempt.
  if (
    collectionScope === 'user' &&
    requestedCollection.trim() !== username.trim()
  ) {
    throw new MilvusCollectionOwnershipError(requestedCollection, username);
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
