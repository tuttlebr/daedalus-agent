import { getMilvusMetadata } from '@/server/milvusMetadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

const metadata = {
  databaseName: 'default',
  userCollection: {
    name: 'user_uploads_alice_hash',
    displayName: 'My documents',
    scope: 'user',
    exists: true,
    readable: true,
    writable: true,
  },
  sharedCollections: [
    {
      name: 'nvidia',
      displayName: 'nvidia',
      scope: 'shared',
      exists: true,
      readable: true,
      writable: false,
    },
  ],
  writableCollections: [
    {
      name: 'user_uploads_alice_hash',
      displayName: 'My documents',
      scope: 'user',
      exists: true,
      readable: true,
      writable: true,
    },
  ],
};

describe('Milvus metadata backend client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DAEDALUS_INTERNAL_API_TOKEN;
    delete process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.BACKEND_HOST;
  });

  it('authenticates the request and accepts the scoped metadata schema', async () => {
    process.env.BACKEND_HOST = 'backend';
    process.env.DAEDALUS_INTERNAL_API_TOKEN = 'internal-token';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(metadata),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getMilvusMetadata('alice')).resolves.toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend:8000/v1/metadata/collections',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-user-id': 'alice',
          'x-daedalus-internal-token': 'internal-token',
        },
      }),
    );
  });

  it('rejects a backend response that marks a shared collection writable', async () => {
    const invalid = {
      ...metadata,
      writableCollections: [
        {
          ...metadata.sharedCollections[0],
          writable: true,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(invalid),
      }),
    );

    await expect(getMilvusMetadata('alice')).rejects.toThrow(
      'metadata response is invalid',
    );
  });

  it.each([
    {
      ...metadata,
      sharedCollections: [{ ...metadata.sharedCollections[0], writable: true }],
    },
    {
      ...metadata,
      writableCollections: [
        { ...metadata.userCollection, name: 'another-user' },
      ],
    },
  ])(
    'rejects collection permissions inconsistent with the private owner',
    async (invalid) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid))),
      );

      await expect(getMilvusMetadata('alice')).rejects.toThrow(
        'metadata response is invalid',
      );
    },
  );

  it('releases an unread error body instead of holding its connection', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // A slow diagnostic body that never finishes on its own.
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { status: 502 })),
    );

    await expect(getMilvusMetadata('alice')).rejects.toThrow(
      'metadata returned 502',
    );
    expect(cancelled).toBe(true);
  });

  it('fails closed when the backend metadata endpoint is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(getMilvusMetadata('alice')).rejects.toThrow(
      'metadata returned 503',
    );
  });
});
