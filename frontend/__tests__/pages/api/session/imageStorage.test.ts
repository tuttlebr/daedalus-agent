import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonGet: vi.fn(),
  jsonDel: vi.fn(),
  sadd: vi.fn(),
  expire: vi.fn(),
  sharp: vi.fn(),
  chains: [] as Array<Record<string, any>>,
  metadata: { format: 'heif', width: 100, height: 80 },
  pngBuffer: Buffer.from('png image'),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
  jsonGet: mocks.jsonGet,
  jsonDel: mocks.jsonDel,
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
}));

vi.mock('sharp', () => ({
  default: mocks.sharp,
}));

function createSharpChain() {
  const chain = {
    metadata: vi.fn().mockResolvedValue(mocks.metadata),
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    flatten: vi.fn().mockReturnThis(),
    toColorspace: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockImplementation(() => {
      if (chain.png.mock.calls.length > 0) {
        return Promise.resolve(mocks.pngBuffer);
      }
      return Promise.resolve(Buffer.from('normalized jpeg'));
    }),
  };
  mocks.chains.push(chain);
  return chain;
}

describe('/api/session/imageStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chains = [];
    mocks.metadata = { format: 'heif', width: 100, height: 80 };
    mocks.pngBuffer = Buffer.from('png image');
    mocks.getRedis.mockReturnValue({
      sadd: mocks.sadd,
      expire: mocks.expire,
    });
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
    mocks.sadd.mockResolvedValue(1);
    mocks.expire.mockResolvedValue(1);
    mocks.sharp.mockImplementation(() => createSharpChain());
  });

  it('stores HEIC/HEIF uploads as PNG before edit submission can read them', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const originalBase64 = Buffer.from('heic image').toString('base64');

    const stored = await storeImage(
      'session-1',
      'alice',
      originalBase64,
      'image/heic',
    );

    const pngBase64 = mocks.pngBuffer.toString('base64');
    expect(stored.mimeType).toBe('image/png');
    expect(mocks.chains[1].png).toHaveBeenCalled();

    const savedImage = mocks.jsonSetWithExpiry.mock.calls[0][1];
    expect(savedImage).toMatchObject({
      data: pngBase64,
      mimeType: 'image/png',
      vlmData: pngBase64,
      vlmMimeType: 'image/png',
      size: mocks.pngBuffer.length,
      width: 100,
      height: 80,
      sessionId: 'session-1',
      userId: 'alice',
    });
  });

  it('does not store HEIC bytes when the browser sent a misleading MIME type', async () => {
    const { storeImage } = await import('@/pages/api/session/imageStorage');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const heicHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      0x00, 0x00, 0x00, 0x00,
    ]);
    mocks.sharp.mockImplementation(() => ({
      metadata: vi.fn().mockRejectedValue(new Error('unsupported image')),
    }));

    try {
      await expect(
        storeImage(
          'session-1',
          'alice',
          heicHeader.toString('base64'),
          'image/png',
        ),
      ).rejects.toThrow('HEIC/HEIF images must be converted to PNG');
    } finally {
      consoleError.mockRestore();
    }
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });
});
