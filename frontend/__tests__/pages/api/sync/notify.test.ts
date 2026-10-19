import handler from '@/pages/api/sync/notify';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@/utils/auth/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/server/session/redis', () => ({
  getPublisher: () => ({ publish: mocks.publish }),
  channels: { userUpdates: (userId: string) => `user:${userId}:updates` },
}));

function request(body: any, method = 'POST') {
  return {
    req: { method, body } as any,
    res: {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any,
  };
}

describe('sync/notify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ username: 'alice' });
    mocks.publish.mockResolvedValue(1);
  });

  it('announces only the conversation id and its committed revision', async () => {
    const { req, res } = request({
      type: 'conversation_updated',
      conversationId: 'conv-1',
      revision: 'r2',
      // An older client also sends the whole conversation; it is not relayed.
      conversation: { id: 'conv-1', messages: ['large history'] },
    });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const [channel, payload] = mocks.publish.mock.calls[0];
    expect(channel).toBe('user:alice:updates');
    expect(JSON.parse(payload)).toEqual({
      type: 'conversation_updated',
      timestamp: expect.any(Number),
      data: { conversationId: 'conv-1', revision: 'r2' },
    });
  });

  it.each([null, undefined, 'text', ['list']])(
    'rejects a %j body with 400 instead of throwing',
    async (body) => {
      const { req, res } = request(body);
      await expect(handler(req, res)).resolves.not.toThrow();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ type: 'conversation_list_changed' }],
    [{ type: 'conversation_updated' }],
    [{ type: 'conversation_updated', conversationId: 'c', revision: 7 }],
  ])('rejects an unsupported notification %j', async (body) => {
    const { req, res } = request(body);
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('reports a failed publication', async () => {
    mocks.publish.mockRejectedValue(new Error('Redis unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = request({
      type: 'conversation_updated',
      conversationId: 'conv-1',
    });
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    error.mockRestore();
  });

  it('requires POST and a session', async () => {
    const wrong = request({}, 'GET');
    await handler(wrong.req, wrong.res);
    expect(wrong.res.status).toHaveBeenCalledWith(405);

    mocks.getSession.mockResolvedValue(null);
    const anonymous = request({
      type: 'conversation_updated',
      conversationId: 'conv-1',
    });
    await handler(anonymous.req, anonymous.res);
    expect(anonymous.res.status).toHaveBeenCalledWith(401);
  });
});
