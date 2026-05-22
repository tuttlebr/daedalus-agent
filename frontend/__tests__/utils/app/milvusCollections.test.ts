import { describe, expect, it } from 'vitest';

import {
  classifyMilvusCollectionScope,
  resolveMilvusCollectionTarget,
} from '@/utils/app/milvusCollections';

describe('milvus collection policy helpers', () => {
  it('classifies allow-listed domain collections as shared', () => {
    expect(classifyMilvusCollectionScope('nvidia')).toBe('shared');
    expect(classifyMilvusCollectionScope('vetpartner')).toBe('shared');
  });

  it('classifies arbitrary collections as user-scoped', () => {
    expect(classifyMilvusCollectionScope('project-notes')).toBe('user');
  });

  it('records provenance for shared collection ingestion targets', () => {
    const target = resolveMilvusCollectionTarget({
      targetCollection: 'nvidia',
      username: 'alice',
      requestedScope: 'shared',
      source: 'test',
      now: () => new Date('2026-05-21T12:00:00.000Z'),
    });

    expect(target).toEqual({
      collectionName: 'nvidia',
      collectionScope: 'shared',
      provenance: {
        uploader: 'alice',
        source: 'test',
        targetCollection: 'nvidia',
        requestedCollection: 'nvidia',
        collectionScope: 'shared',
        databaseName: 'default',
        timestamp: '2026-05-21T12:00:00.000Z',
      },
    });
  });

  it('rejects accidental shared-target scope mismatches', () => {
    expect(() => resolveMilvusCollectionTarget({
      targetCollection: 'nvidia',
      username: 'alice',
      requestedScope: 'user',
      source: 'test',
    })).toThrow('does not match');
  });
});

