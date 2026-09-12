import handler from '@/pages/api/session/selectedConversation';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOrSetSessionId: vi.fn(),
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  publishSyncEvent: vi.fn(),
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

vi.mock('@/utils/sync/publish', () => ({
  publishSyncEvent: mocks.publishSyncEvent,
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
    mocks.publishSyncEvent.mockResolvedValue(undefined);
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
    mocks.jsonGet.mockResolvedValue(conversation);

    const { req, res } = createMockReqRes('GET');
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(conversation);
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });
});
