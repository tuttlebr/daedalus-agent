import {
  MilvusCollectionOwnershipError,
  resolveMilvusCollectionTarget,
} from '@/utils/app/milvusCollections';

import { describe, expect, it } from 'vitest';

describe('milvus collection policy helpers', () => {
  it('uses the backend-authoritative hashed private collection', () => {
    const target = resolveMilvusCollectionTarget({
      targetCollection: 'user_uploads_alice_0123456789abcdef',
      username: 'alice',
      privateCollectionName: 'user_uploads_alice_0123456789abcdef',
      databaseName: 'tenant-data',
      requestedScope: 'user',
      source: 'test',
      now: () => new Date('2026-05-21T12:00:00.000Z'),
    });

    expect(target).toEqual({
      collectionName: 'user_uploads_alice_0123456789abcdef',
      collectionScope: 'user',
      provenance: {
        uploader: 'alice',
        source: 'test',
        targetCollection: 'user_uploads_alice_0123456789abcdef',
        requestedCollection: 'user_uploads_alice_0123456789abcdef',
        collectionScope: 'user',
        databaseName: 'tenant-data',
        timestamp: '2026-05-21T12:00:00.000Z',
      },
    });
  });

  it('rejects shared collection writes even when the client asks for shared', () => {
    expect(() =>
      resolveMilvusCollectionTarget({
        targetCollection: 'nvidia',
        username: 'alice',
        privateCollectionName: 'user_uploads_alice_hash',
        requestedScope: 'shared',
        source: 'test',
      }),
    ).toThrow('does not match');
  });

  it('maps a legacy username target to the authoritative private name', () => {
    const target = resolveMilvusCollectionTarget({
      targetCollection: 'alice',
      username: 'alice',
      privateCollectionName: 'user_uploads_alice_hash',
      source: 'test',
    });
    expect(target.collectionName).toBe('user_uploads_alice_hash');
    expect(target.collectionScope).toBe('user');
  });

  it('defaults to the authoritative private collection', () => {
    const target = resolveMilvusCollectionTarget({
      username: 'alice',
      privateCollectionName: 'user_uploads_alice_hash',
      source: 'test',
    });
    expect(target.collectionName).toBe('user_uploads_alice_hash');
    expect(target.collectionScope).toBe('user');
  });

  it('rejects ingesting into another user`s collection (F-001 IDOR)', () => {
    expect(() =>
      resolveMilvusCollectionTarget({
        targetCollection: 'bob',
        username: 'alice',
        privateCollectionName: 'user_uploads_alice_hash',
        source: 'test',
      }),
    ).toThrow(MilvusCollectionOwnershipError);
  });

  it('rejects an arbitrary user-scoped collection name', () => {
    expect(() =>
      resolveMilvusCollectionTarget({
        targetCollection: 'project-notes',
        username: 'alice',
        privateCollectionName: 'user_uploads_alice_hash',
        source: 'test',
      }),
    ).toThrow(MilvusCollectionOwnershipError);
  });
});
