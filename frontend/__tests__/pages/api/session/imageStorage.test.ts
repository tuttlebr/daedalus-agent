import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonGet: vi.fn(),
  jsonDel: vi.fn(),
  sadd: vi.fn(),
  expire: vi.fn(),
  decodeHeic: vi.fn(),
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

vi.mock('heic-decode', () => ({
  default: mocks.decodeHeic,
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
    mocks.getRedis.mockReturnValue({
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
    expect(savedImage.editMimeType).toBe('image/jpeg');
    expect(editBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(editMetadata.orientation).toBeUndefined();
    expect([editMetadata.width, editMetadata.height]).toEqual([3, 4]);
  });
});
