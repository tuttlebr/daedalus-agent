import { useQuery } from '@tanstack/react-query';

import { queryKeys } from './keys';

import type { MilvusCollectionMetadata } from '@/server/milvusMetadata';

interface MilvusCollectionsResponse {
  writableCollections?: MilvusCollectionMetadata[];
}

async function fetchMilvusCollections(): Promise<MilvusCollectionMetadata[]> {
  const res = await fetch('/api/milvus/collections', {
    credentials: 'include',
  });
  if (!res.ok) return [];
  const data = (await res.json()) as MilvusCollectionsResponse;
  return data.writableCollections ?? [];
}

export function useMilvusCollections(enabled = true) {
  return useQuery({
    queryKey: queryKeys.milvus.collections,
    queryFn: fetchMilvusCollections,
    enabled,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
