import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoredRecord = Record<string, unknown> | { legacyString: string };

const mocks = vi.hoisted(() => ({
  records: new Map<string, any>(),
  // Every JSONPath requested from Redis, so tests can see what was read.
  readPaths: [] as string[],
  getStorageSessionId: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
}));

/** The subset of RedisJSON/Lua behavior the generated-image helper uses. */
function fakeRedis() {
  return {
    eval: vi.fn(
      async (script: string, _keys: number, key: string, ...argv: string[]) => {
        const record = mocks.records.get(key);
        if (script.includes('JSON.SET')) {
          if (!record || 'legacyString' in record) return null;
          if (record.thumbnail !== undefined) return null;
          record.thumbnail = JSON.parse(argv[0]);
          return 'OK';
        }
        if (!record) return null;
        if ('legacyString' in record) return ['string', record.legacyString];
        const paths = ['$.userId', '$.user', '$.sessionId', ...argv];
        mocks.readPaths.push(...paths);
        const fields = Object.fromEntries(
          paths.map((path) => {
            const value = record[path.slice(2)];
            return [path, value === undefined ? [] : [value]];
          }),
        );
        const length =
          typeof record.data === 'string' ? record.data.length : undefined;
        return ['json', JSON.stringify(fields), length ?? 0];
      },
    ),
    call: vi.fn(async (command: string, key: string, path: string) => {
      expect(command).toBe('JSON.GET');
      mocks.readPaths.push(path);
      const record = mocks.records.get(key);
      return record ? JSON.stringify([record[path.slice(2)]]) : null;
    }),
  };
}

vi.mock('@/server/session/redis', () => {
  const client = fakeRedis();
  return { getRedis: () => client };
});

vi.mock('@/server/session/_utils', () => ({
  getStorageSessionId: mocks.getStorageSessionId,
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  })),
}));

function createMockReqRes(id = 'abc-123', query: Record<string, string> = {}) {
  const req = {
    method: 'GET',
    query: { id, ...query },
    headers: {},
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

function store(record: StoredRecord, id = 'abc-123') {
  mocks.records.set(`generated:image:${id}`, record);
}

async function loadHandler(legacyPublic = 'true') {
  vi.resetModules();
  process.env.GENERATED_IMAGE_LEGACY_PUBLIC = legacyPublic;
  return (await import('@/pages/api/generated-image/[id]')).default;
}

describe('/api/generated-image/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.records.clear();
    mocks.readPaths.length = 0;
    mocks.getStorageSessionId.mockReturnValue('session-1');
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'testuser' });
    store({
      data: Buffer.from('full').toString('base64'),
      mimeType: 'image/png',
      userId: 'testuser',
      sessionId: 'session-1',
    });
  });

  it('serves owned images with private cache headers', async () => {
    const handler = await loadHandler('false');
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=86400, immutable',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('full'));
  });

  it('persists the first thumbnail so later views never read or resize the original', async () => {
    const handler = await loadHandler('false');
    const sharp = vi.mocked((await import('sharp')).default);

    const first = createMockReqRes('abc-123', { thumbnail: 'true' });
    await handler(first.req, first.res);

    expect(first.res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'image/jpeg',
    );
    expect(first.res.setHeader).toHaveBeenCalledWith('ETag', '"abc-123-thumb"');
    expect(first.res.send).toHaveBeenCalledWith(Buffer.from('thumb'));
    expect(sharp).toHaveBeenCalledOnce();
    expect(mocks.records.get('generated:image:abc-123').thumbnail).toBe(
      Buffer.from('thumb').toString('base64'),
    );

    mocks.readPaths.length = 0;
    const later = createMockReqRes('abc-123', { thumbnail: '1' });
    await handler(later.req, later.res);

    expect(later.res.status).toHaveBeenCalledWith(200);
    expect(later.res.send).toHaveBeenCalledWith(Buffer.from('thumb'));
    expect(mocks.readPaths).not.toContain('$.data');
    expect(sharp).toHaveBeenCalledOnce();
  });

  it('falls back to the original when a thumbnail cannot be encoded', async () => {
    const handler = await loadHandler('false');
    const sharp = vi.mocked((await import('sharp')).default);
    sharp.mockImplementationOnce(() => {
      throw new Error('unsupported image');
    });
    const fallback = createMockReqRes('abc-123', { thumbnail: '1' });

    await handler(fallback.req, fallback.res);

    expect(fallback.res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'image/png',
    );
    expect(fallback.res.send).toHaveBeenCalledWith(Buffer.from('full'));
    expect(
      mocks.records.get('generated:image:abc-123').thumbnail,
    ).toBeUndefined();
  });

  it('serves legacy plain-string records without persisting a thumbnail', async () => {
    const handler = await loadHandler('false');
    store({
      legacyString: JSON.stringify({
        data: Buffer.from('legacy').toString('base64'),
        mimeType: 'image/webp',
        userId: 'testuser',
      }),
    });

    const full = createMockReqRes();
    await handler(full.req, full.res);
    const thumb = createMockReqRes('abc-123', { thumbnail: 'true' });
    await handler(thumb.req, thumb.res);

    expect(full.res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'image/webp',
    );
    expect(full.res.send).toHaveBeenCalledWith(Buffer.from('legacy'));
    expect(thumb.res.send).toHaveBeenCalledWith(Buffer.from('thumb'));
    expect('thumbnail' in mocks.records.get('generated:image:abc-123')).toBe(
      false,
    );
  });

  it('returns 404 for a missing record or one without image bytes', async () => {
    const handler = await loadHandler('false');
    const missing = createMockReqRes('def-456');
    await handler(missing.req, missing.res);
    store({ mimeType: 'image/png', userId: 'testuser' });
    const empty = createMockReqRes();
    await handler(empty.req, empty.res);

    expect(missing.res.status).toHaveBeenCalledWith(404);
    expect(empty.res.status).toHaveBeenCalledWith(404);
  });

  it('does not read or render another user image', async () => {
    const handler = await loadHandler('false');
    store({
      data: Buffer.from('full').toString('base64'),
      mimeType: 'image/png',
      userId: 'another-user',
    });
    const { req, res } = createMockReqRes('abc-123', { thumbnail: 'true' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((await import('sharp')).default).not.toHaveBeenCalled();
    expect(mocks.readPaths).not.toContain('$.data');
    expect(
      mocks.records.get('generated:image:abc-123').thumbnail,
    ).toBeUndefined();
  });

  it('returns the original image as an attachment when requested', async () => {
    const handler = await loadHandler('false');
    const { req, res } = createMockReqRes('abc-123', { download: '1' });

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="daedalus-abc-123.png"',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('full'));
  });

  it('rejects unowned images when legacy public access is disabled', async () => {
    const handler = await loadHandler('false');
    store({
      data: Buffer.from('full').toString('base64'),
      mimeType: 'image/png',
    });
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('preserves signed original bytes when download and thumbnail are both requested', async () => {
    const handler = await loadHandler('false');
    const { req, res } = createMockReqRes('abc-123', {
      download: '1',
      thumbnail: 'true',
    });
    const original = Buffer.from('original image with embedded C2PA manifest');
    store({
      data: original.toString('base64'),
      mimeType: 'image/webp',
      userId: 'testuser',
      thumbnail: Buffer.from('cached thumb').toString('base64'),
    });

    await handler(req, res);

    expect(res.send).toHaveBeenCalledWith(original);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/webp');
    const sharp = (await import('sharp')).default;
    expect(sharp).not.toHaveBeenCalled();
  });

  it('does not fall back to a matching session when another user owns the image', async () => {
    const handler = await loadHandler('false');
    store({
      data: Buffer.from('full').toString('base64'),
      mimeType: 'image/png',
      userId: 'another-user',
      sessionId: 'session-1',
    });
    const { req, res } = createMockReqRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('authorizes legacy owner and session-scoped records', async () => {
    const handler = await loadHandler('false');
    store({ data: 'AA==', user: 'testuser' }, 'aaa-1');
    store({ data: 'AA==', sessionId: 'session-1' }, 'aaa-2');
    store(
      { data: 'AA==', user: 'another-user', sessionId: 'session-1' },
      'aaa-3',
    );

    const responses = [];
    for (const id of ['aaa-1', 'aaa-2', 'aaa-3']) {
      const { req, res } = createMockReqRes(id);
      await handler(req, res);
      responses.push(res.status.mock.calls[0][0]);
    }

    expect(responses).toEqual([200, 200, 403]);
  });
});
