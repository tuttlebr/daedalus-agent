import handler from '@/pages/api/session/videoStorage';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  sadd: vi.fn(),
  expire: vi.fn(),
}));

vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: async () => true,
  ruleFromEnv: () => ({ name: 'video-upload', limit: 60, windowSeconds: 60 }),
}));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: async () => ({ username: 'alice' }),
  getStorageSessionId: () => 'session-1',
}));
vi.mock('@/server/session/redis', () => ({
  getRedis: () => ({ sadd: mocks.sadd, expire: mocks.expire }),
  jsonGet: mocks.jsonGet,
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  sessionKey: (parts: string[]) => parts.join(':'),
}));

describe('/api/session/videoStorage uploads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores a well-formed upload', async () => {
    const mp4 = Buffer.from('000000186674797069736f6d00000000', 'hex');
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await handler(
      {
        method: 'POST',
        query: {},
        body: {
          base64Data: mp4.toString('base64'),
          filename: '旅行🙂.mp4',
          mimeType: 'video/mp4',
        },
      } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const [key, record] = mocks.jsonSetWithExpiry.mock.calls[0];
    // The backend's visual-media tool reads exactly this user-scoped key.
    expect(key).toBe(`user:alice:video:${record.id}`);
    expect(record).toMatchObject({
      filename: '旅行🙂.mp4',
      mimeType: 'video/mp4',
      userId: 'alice',
    });
    // No reader exists for per-user or per-session video index sets.
    expect(mocks.sadd).not.toHaveBeenCalled();
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-string filename', { filename: 42 }],
    ['a lone-surrogate filename', { filename: '\ud800clip.mp4' }],
    ['a control character in the filename', { filename: 'clip\r\n.mp4' }],
    ['a non-string MIME type', { mimeType: 7 }],
    ['non-string video data', { base64Data: { bytes: 'AAAA' } }],
  ])('rejects %s with 400 before storing it', async (_label, override) => {
    const mp4 = Buffer.from('000000186674797069736f6d00000000', 'hex');
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      await handler(
        {
          method: 'POST',
          query: {},
          body: {
            base64Data: mp4.toString('base64'),
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            ...override,
          },
        } as any,
        res,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });
});

describe('/api/session/videoStorage reads', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['GET', 'DELETE'])(
    'offers no %s endpoint for stored videos',
    async (method) => {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
      } as any;

      await handler({ method, query: { videoId: 'video-1' } } as any, res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
      expect(mocks.jsonGet).not.toHaveBeenCalled();
    },
  );
});
