import handler from '@/pages/api/session/videoStorage';

import { validateHeaderValue } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ jsonGet: vi.fn() }));

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: async () => ({ username: 'alice' }),
  getOrSetSessionId: () => 'session-1',
}));
vi.mock('@/server/session/redis', () => ({
  jsonGet: mocks.jsonGet,
  sessionKey: (parts: string[]) => parts.join(':'),
}));

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
