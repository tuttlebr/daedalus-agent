import handler from '@/pages/api/session/conversationHistory';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOrSetSessionId: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => ({ del: mocks.redisDel })),
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

describe('session/conversationHistory replay sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'testuser' });
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
  });

  it('sanitizes replayed assistant prefixes on GET and writes back cleaned data', async () => {
    const prior = 'Daily summary for May 13, 2026.';
    const next = 'The namespace is healthy.';
    const conversations = [
      {
        id: 'conv-1',
        name: 'Test',
        folderId: null,
        messages: [
          { role: 'user', content: 'daily summary' },
          { role: 'assistant', content: prior },
          { role: 'user', content: 'namespace?' },
          { role: 'assistant', content: `${prior}\n\n${next}` },
        ],
      },
    ];
    mocks.jsonGet.mockResolvedValue(conversations);

    const { req, res } = createMockReqRes('GET');
    await handler(req, res);

    const sanitized = [
      {
        ...conversations[0],
        messages: [
          conversations[0].messages[0],
          conversations[0].messages[1],
          conversations[0].messages[2],
          { role: 'assistant', content: next },
        ],
      },
    ];
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(sanitized);
    expect(mocks.jsonSetWithExpiry).toHaveBeenCalledWith(
      'daedalus:user:testuser:conversationHistory',
      sanitized,
      60 * 60 * 24 * 7,
    );
  });
});
