import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn(),
  sadd: vi.fn(),
  expire: vi.fn(),
  decodeHeic: vi.fn(),
  // Fake Redis records keyed like production: plain-string legacy values or
  // RedisJSON documents read through JSONPath, with every path read recorded.
  records: new Map<string, { kind: 'json' | 'string'; value: any }>(),
  readPaths: [] as string[][],
}));

async function fakeEval(
  script: string,
  _count: number,
  key: string,
  ...args: string[]
) {
  if (!script.includes('READ_IMAGE_FIELDS')) {
    throw new Error('Unexpected Redis script in image fixture');
  }
  const record = mocks.records.get(key);
  if (!record) return null;
  if (record.kind === 'string') return ['string', JSON.stringify(record.value)];
  mocks.readPaths.push(args);
  return [
    'json',
    JSON.stringify(
      Object.fromEntries(
        args.map((path) => {
          const field = path.replace(/^\$\./, '');
          return [path, field in record.value ? [record.value[field]] : []];
        }),
      ),
    ),
  ];
}

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
  jsonDel: mocks.jsonDel,
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
}));

vi.mock('heic-decode', () => ({
  default: mocks.decodeHeic,
}));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: async () => ({ username: 'alice' }),
  getStorageSessionId: () => 'session-1',
}));

function heicHeader(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

describe('/api/session/imageStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.records.clear();
    mocks.readPaths.length = 0;
    mocks.getRedis.mockReturnValue({
      eval: fakeEval,
      sadd: mocks.sadd,
      expire: mocks.expire,
    });
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
    mocks.sadd.mockResolvedValue(1);
    mocks.expire.mockResolvedValue(1);
    mocks.decodeHeic.mockResolvedValue({
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 255, 255]),
    });
  });

  it('stores uploaded SVG as inert raster pixels rather than same-origin executable markup', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>fetch("/api/auth/me")</script><rect width="8" height="8" fill="red"/></svg>';
    await storeImage(
      'session-1',
      'alice',
      Buffer.from(source).toString('base64'),
      'image/svg+xml',
    );
    const saved = mocks.jsonSetWithExpiry.mock.calls[0][1];
    expect(saved.mimeType).toMatch(/^image\/(png|jpeg)$/);
    const bytes = Buffer.from(saved.data, 'base64');
    expect((await sharp(bytes).metadata()).format).toMatch(/^(png|jpeg)$/);
    expect(bytes.toString()).not.toContain('<script>');
  });

  it('uses a 41 MiB parser ceiling for a 30 MiB base64 image request', async () => {
    const { config } = await import('@/pages/api/session/imageStorage');

    expect(config.api.bodyParser.sizeLimit).toBe('41mb');
  });

  it('rasterizes legacy SVG reads and applies a sandbox CSP without changing owner checks', async () => {
    const handler = (await import('@/pages/api/session/imageStorage')).default;
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script><rect width="8" height="8"/></svg>';
    mocks.records.set('user:alice:image:legacy', {
      kind: 'string',
      value: {
        id: 'legacy',
        sessionId: 'session-1',
        userId: 'alice',
        mimeType: 'image/svg+xml',
        data: Buffer.from(source).toString('base64'),
      },
    });
    const req = { method: 'GET', query: { imageId: 'legacy' } } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      send: vi.fn(),
      json: vi.fn(),
    } as any;
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    expect((await sharp(res.send.mock.calls[0][0]).metadata()).format).toBe(
      'png',
    );
    mocks.records.set('user:alice:image:legacy', {
      kind: 'string',
      value: {
        userId: 'bob',
        sessionId: 'another',
        data: Buffer.from(source).toString('base64'),
        mimeType: 'image/svg+xml',
      },
    });
    res.status.mockClear();
    res.send.mockClear();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).not.toHaveBeenCalled();
  });

  describe('GET reads only the requested view', () => {
    const encoded = (text: string) => Buffer.from(text).toString('base64');
    const heavy = ['data', 'editData', 'vlmData', 'thumbnail'];

    async function get(query: Record<string, string>) {
      const handler = (await import('@/pages/api/session/imageStorage'))
        .default;
      const res = {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        send: vi.fn(),
        json: vi.fn(),
      } as any;
      await handler({ method: 'GET', query } as any, res);
      const requested = mocks.readPaths
        .flat()
        .map((path) => path.replace(/^\$\./, ''));
      return { res, requested };
    }

    beforeEach(() => {
      mocks.records.set('user:alice:image:photo', {
        kind: 'json',
        value: {
          id: 'photo',
          userId: 'alice',
          sessionId: 'session-1',
          mimeType: 'image/jpeg',
          data: encoded('original'),
          editData: encoded('edit'),
          vlmData: encoded('vlm'),
          thumbnail: encoded('thumb'),
          thumbnailMimeType: 'image/jpeg',
          width: 4032,
          height: 3024,
        },
      });
    });

    it('serves a thumbnail without reading the original or derivatives', async () => {
      const { res, requested } = await get({
        imageId: 'photo',
        thumbnail: 'true',
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send.mock.calls[0][0].toString()).toBe('thumb');
      expect(requested.filter((field) => heavy.includes(field))).toEqual([
        'thumbnail',
      ]);
    });

    it('serves the display copy without reading the derivatives', async () => {
      const { res, requested } = await get({ imageId: 'photo' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send.mock.calls[0][0].toString()).toBe('original');
      expect(res.setHeader).toHaveBeenCalledWith('X-Has-Thumbnail', 'true');
      expect(requested.filter((field) => heavy.includes(field))).toEqual([
        'data',
      ]);
    });

    it('falls back to the original when a small image has no thumbnail', async () => {
      const record = mocks.records.get('user:alice:image:photo')!.value;
      delete record.thumbnail;
      delete record.thumbnailMimeType;

      const { res } = await get({ imageId: 'photo', thumbnail: '1' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send.mock.calls[0][0].toString()).toBe('original');
    });

    it('rejects another user before serving any bytes', async () => {
      mocks.records.get('user:alice:image:photo')!.value.userId = 'bob';

      const { res } = await get({ imageId: 'photo', thumbnail: 'true' });

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing image', async () => {
      const { res } = await get({ imageId: 'absent' });

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  it('accepts exactly 30 MiB and rejects the next raw byte', async () => {
    const { MAX_IMAGE_UPLOAD_SIZE_BYTES, assertImageUploadSize } = await import(
      '@/pages/api/session/imageStorage'
    );

    expect(() =>
      assertImageUploadSize(MAX_IMAGE_UPLOAD_SIZE_BYTES),
    ).not.toThrow();
    expect(() =>
      assertImageUploadSize(MAX_IMAGE_UPLOAD_SIZE_BYTES + 1),
    ).toThrow('Image exceeds the 30 MB upload limit');
  });

  it('decodes HEIC pixels into a real single-frame Image API JPEG', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const original = heicHeader();

    const stored = await storeImage(
      'session-1',
      'alice',
      original.toString('base64'),
      'image/heic',
    );

    expect(stored.mimeType).toBe('image/jpeg');
    expect(mocks.decodeHeic).toHaveBeenCalledWith({ buffer: original });

    const savedImage = mocks.jsonSetWithExpiry.mock.calls[0][1];
    const storedBytes = Buffer.from(savedImage.data, 'base64');
    const editBytes = Buffer.from(savedImage.editData, 'base64');
    expect(storedBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(editBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(savedImage).toMatchObject({
      mimeType: 'image/jpeg',
      editMimeType: 'image/jpeg',
      vlmMimeType: 'image/jpeg',
      width: 2,
      height: 1,
      sessionId: 'session-1',
      userId: 'alice',
    });
  });

  it('content-sniffs and decodes HEIC when the MIME type is misleading', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const original = heicHeader();

    const stored = await storeImage(
      'session-1',
      'alice',
      original.toString('base64'),
      'image/png',
    );

    expect(stored.mimeType).toBe('image/jpeg');
    expect(mocks.decodeHeic).toHaveBeenCalledWith({ buffer: original });
  });

  it('fails closed when HEIC pixels cannot be decoded', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.decodeHeic.mockRejectedValue(new Error('invalid HEVC bitstream'));

    try {
      await expect(
        storeImage(
          'session-1',
          'alice',
          heicHeader().toString('base64'),
          'image/heic',
        ),
      ).rejects.toThrow('Unable to decode this HEIC/HEIF image');
    } finally {
      consoleError.mockRestore();
    }
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('trusts decodable JPEG bytes over a stale HEIC MIME label', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const jpeg = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: '#112233',
      },
    })
      .jpeg()
      .toBuffer();

    const stored = await storeImage(
      'session-1',
      'alice',
      jpeg.toString('base64'),
      'image/heic',
    );

    expect(stored.mimeType).toBe('image/jpeg');
    expect(mocks.decodeHeic).not.toHaveBeenCalled();
  });

  it('decodes AVIF with sharp instead of the HEVC-only HEIC decoder', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const avif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#336699' },
    })
      .avif()
      .toBuffer();
    // sharp reports AVIF as an AV1-compressed HEIF container.
    expect(await sharp(avif).metadata()).toMatchObject({
      format: 'heif',
      compression: 'av1',
    });

    const stored = await storeImage(
      'session-1',
      'alice',
      avif.toString('base64'),
      'image/avif',
    );

    expect(mocks.decodeHeic).not.toHaveBeenCalled();
    expect(stored.mimeType).toBe('image/avif');
    const savedImage = mocks.jsonSetWithExpiry.mock.calls[0][1];
    expect(savedImage.data).toBe(avif.toString('base64'));
    expect(savedImage.editMimeType).toBe('image/jpeg');
  });

  it('stores a browser-displayable derivative instead of a client-labelled TIFF original', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const tiff = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#445566' },
    })
      .tiff()
      .toBuffer();

    const stored = await storeImage(
      'session-1',
      'alice',
      tiff.toString('base64'),
      'text/html',
    );

    const savedImage = mocks.jsonSetWithExpiry.mock.calls[0][1];
    expect(stored.mimeType).toMatch(/^image\/(png|jpeg)$/);
    expect(savedImage.mimeType).toBe(stored.mimeType);
    const metadata = await sharp(Buffer.from(savedImage.data, 'base64'))
      .metadata()
      .catch(() => null);
    expect(metadata?.format).toMatch(/^(png|jpeg)$/);
  });

  it.each([
    [{ base64Data: { data: 'abc' } }],
    [{ base64Data: ['abc'] }],
    [{ base64Data: 'aGVsbG8=', mimeType: { type: 'image/png' } }],
  ])('rejects malformed upload fields with 400: %j', async (body) => {
    const handler = (await import('@/pages/api/session/imageStorage')).default;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      await handler({ method: 'POST', query: {}, body } as any, res);
    } finally {
      consoleError.mockRestore();
    }

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('stores a dedicated normalized edit derivative for JPEG uploads', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const original = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 3,
        background: '#336699',
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    await storeImage(
      'session-1',
      'alice',
      original.toString('base64'),
      'image/jpeg',
    );

    const savedImage = mocks.jsonSetWithExpiry.mock.calls[0][1];
    const editBytes = Buffer.from(savedImage.editData, 'base64');
    const editMetadata = await sharp(editBytes).metadata();
    expect(savedImage.data).toBe(original.toString('base64'));
    expect(savedImage.size).toBe(original.length);
    expect(savedImage.editMimeType).toBe('image/jpeg');
    expect(editBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(editMetadata.orientation).toBeUndefined();
    expect([editMetadata.width, editMetadata.height]).toEqual([3, 4]);
  });
});
