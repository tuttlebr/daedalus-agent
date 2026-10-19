import { config as conversationRouteConfig } from '@/pages/api/conversations/[id]';
import handler, { config } from '@/pages/api/session/selectedConversation';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOrSetSessionId: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  jsonGet: mocks.jsonGet,
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
}));

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  getOrSetSessionId: mocks.getOrSetSessionId,
}));

function createMockReqRes(method: string, body: any = {}) {
  const req = { method, body } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

describe('session/selectedConversation assistant content preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'testuser' });
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
  });

  it('preserves repeated assistant text on GET without rewriting stored history', async () => {
    const prior = 'Daily summary for May 13, 2026.';
    const next = 'The namespace is healthy.';
    const conversation = {
      id: 'conv-1',
      name: 'Test',
      folderId: null,
      messages: [
        { role: 'user', content: 'daily summary' },
        { role: 'assistant', content: prior },
        { role: 'user', content: 'namespace?' },
        { role: 'assistant', content: `${prior}\n\n${next}` },
      ],
    };
    // Compare with a copy so an in-place rewrite of the stored object fails.
    const expected = structuredClone(conversation);
    mocks.jsonGet.mockResolvedValue(conversation);

    const { req, res } = createMockReqRes('GET');
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expected);
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('stores the selection as an id pointer, even from a full copy', async () => {
    const { req, res } = createMockReqRes('PUT', {
      id: 'conv-2',
      name: 'Older clients send the whole conversation',
      messages: [{ role: 'user', content: 'not stored here' }],
    });
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(mocks.jsonSetWithExpiry).toHaveBeenCalledExactlyOnceWith(
      'daedalus:user:testuser:selectedConversation',
      { id: 'conv-2' },
      60 * 60 * 24 * 7,
    );
  });

  // A tab loaded before the id pointer awaits this PUT with the conversation
  // it just saved; rejecting a body the save route accepted fails its save.
  it('accepts any body the conversation save route accepts', () => {
    expect(config.api.bodyParser.sizeLimit).toBe(
      conversationRouteConfig.api.bodyParser.sizeLimit,
    );
  });

  it.each([null, {}, { id: '' }, { id: 7 }, { id: 'x'.repeat(513) }])(
    'rejects a selection without a usable id: %j',
    async (body) => {
      const { req, res } = createMockReqRes('PUT', body);
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
    },
  );
});
