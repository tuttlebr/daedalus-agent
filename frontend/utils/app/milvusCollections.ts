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
  privateCollectionName?: string;
  databaseName?: string;
  source: string;
  now?: () => Date;
}

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

export function resolveMilvusCollectionTarget({
  targetCollection,
  username,
  requestedScope,
  privateCollectionName,
  databaseName = 'default',
  source,
  now = () => new Date(),
}: ResolveMilvusCollectionTargetOptions): MilvusCollectionTarget {
  const authoritativePrivateCollection =
    privateCollectionName?.trim() || username.trim();
  const suppliedCollection = targetCollection?.trim() || '';
  const requestedCollection =
    !suppliedCollection || suppliedCollection === username.trim()
      ? authoritativePrivateCollection
      : suppliedCollection;
  const collectionScope: MilvusCollectionScope = 'user';
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

  if (requestedCollection !== authoritativePrivateCollection) {
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
      databaseName,
      timestamp: now().toISOString(),
    },
  };
}
