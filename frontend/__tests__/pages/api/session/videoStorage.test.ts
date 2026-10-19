import handler from '@/pages/api/session/videoStorage';

import { validateHeaderValue } from 'node:http';
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
    expect(mocks.jsonSetWithExpiry.mock.calls[0][1]).toMatchObject({
      filename: '旅行🙂.mp4',
      mimeType: 'video/mp4',
      userId: 'alice',
    });
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

describe('/api/session/videoStorage download headers', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['旅行🙂.mp4', 'quote";\r\nInjected: yes.mp4'])(
    'serves a stored video named %s with a valid inline filename',
    async (filename) => {
      const bytes = Buffer.from('stored video');
      mocks.jsonGet.mockResolvedValue({
        id: 'video-1',
        userId: 'alice',
        sessionId: 'session-1',
        data: bytes.toString('base64'),
        mimeType: 'video/mp4',
        filename,
      });
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        send: vi.fn(),
        setHeader: vi.fn(validateHeaderValue),
      } as any;

      await handler(
        { method: 'GET', query: { videoId: 'video-1' } } as any,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(bytes);
      const disposition = res.setHeader.mock.calls.find(
        ([name]: string[]) => name === 'Content-Disposition',
      )?.[1];
      expect(disposition).toMatch(/^inline; filename="[^"\r\n]*"; filename\*=/);
      expect(disposition).toContain(
        `filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
    },
  );
});
