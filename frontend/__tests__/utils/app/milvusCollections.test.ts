import {
  MilvusCollectionOwnershipError,
  classifyMilvusCollectionScope,
  resolveMilvusCollectionTarget,
} from '@/utils/app/milvusCollections';

import { describe, expect, it } from 'vitest';

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
    expect(() =>
      resolveMilvusCollectionTarget({
        targetCollection: 'nvidia',
        username: 'alice',
        requestedScope: 'user',
        source: 'test',
      }),
    ).toThrow('does not match');
  });

  it('defaults a user-scoped target to the caller username', () => {
    const target = resolveMilvusCollectionTarget({
      username: 'alice',
      source: 'test',
    });
    expect(target.collectionName).toBe('alice');
    expect(target.collectionScope).toBe('user');
  });

  it('allows a user to target their own collection', () => {
    const target = resolveMilvusCollectionTarget({
      targetCollection: 'alice',
      username: 'alice',
      source: 'test',
    });
    expect(target.collectionName).toBe('alice');
    expect(target.collectionScope).toBe('user');
  });

  it('rejects ingesting into another user`s collection (F-001 IDOR)', () => {
    expect(() =>
      resolveMilvusCollectionTarget({
        targetCollection: 'bob',
        username: 'alice',
        source: 'test',
      }),
    ).toThrow(MilvusCollectionOwnershipError);
  });

  it('rejects an arbitrary user-scoped collection name', () => {
    expect(() =>
      resolveMilvusCollectionTarget({
        targetCollection: 'project-notes',
        username: 'alice',
        source: 'test',
      }),
    ).toThrow(MilvusCollectionOwnershipError);
  });
});
