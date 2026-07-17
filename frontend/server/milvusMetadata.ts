import { buildBackendUrl, getBackendHost } from '@/utils/app/backendApi';
import { withInternalBackendAuth } from '@/utils/server/backendAuth';

export interface MilvusCollectionMetadata {
  name: string;
  displayName: string;
  scope: 'user' | 'shared';
  exists: boolean;
  readable: boolean;
  writable: boolean;
}

export interface MilvusMetadataResponse {
  databaseName: string;
  userCollection: MilvusCollectionMetadata;
  sharedCollections: MilvusCollectionMetadata[];
  writableCollections: MilvusCollectionMetadata[];
}

const METADATA_TIMEOUT_MS = 5_000;

function isCollectionMetadata(
  value: unknown,
): value is MilvusCollectionMetadata {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.name === 'string' &&
    typeof item.displayName === 'string' &&
    (item.scope === 'user' || item.scope === 'shared') &&
    typeof item.exists === 'boolean' &&
    typeof item.readable === 'boolean' &&
    typeof item.writable === 'boolean'
  );
}

function parseMetadata(value: unknown): MilvusMetadataResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('Backend collection metadata response is invalid');
  }
  const data = value as Record<string, unknown>;
  if (
    typeof data.databaseName !== 'string' ||
    !isCollectionMetadata(data.userCollection) ||
    !Array.isArray(data.sharedCollections) ||
    !data.sharedCollections.every(isCollectionMetadata) ||
    !Array.isArray(data.writableCollections) ||
    !data.writableCollections.every(isCollectionMetadata) ||
    data.userCollection.scope !== 'user' ||
    !data.userCollection.writable ||
    data.writableCollections.some(
      (collection) => collection.scope !== 'user' || !collection.writable,
    )
  ) {
    throw new Error('Backend collection metadata response is invalid');
  }
  return data as unknown as MilvusMetadataResponse;
}

export async function getMilvusMetadata(
  username: string,
): Promise<MilvusMetadataResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const url = buildBackendUrl({
      backendHost: getBackendHost(),
      pathOverride: '/v1/metadata/collections',
    });
    const response = await fetch(url, {
      method: 'GET',
      headers: withInternalBackendAuth({
        Accept: 'application/json',
        'x-user-id': username,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Backend collection metadata returned ${response.status}`,
      );
    }
    return parseMetadata(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
