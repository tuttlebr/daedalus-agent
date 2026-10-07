import handler from '@/pages/api/session/conversationHistory';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOrSetSessionId: vi.fn(),
  list: vi.fn(),
  merge: vi.fn(),
  remove: vi.fn(),
  selected: vi.fn(),
}));

vi.mock('@/server/session/conversationHistory', () => ({
  listConversationHistoryForUser: mocks.list,
  mergeConversationHistoryForUser: mocks.merge,
}));
vi.mock('@/server/session/conversationDeletion', () => ({
  deleteConversationForUser: mocks.remove,
}));
vi.mock('@/server/session/redis', () => ({
  jsonGet: mocks.selected,
  sessionKey: (parts: string[]) => parts.join(':'),
}));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  getOrSetSessionId: mocks.getOrSetSessionId,
}));

function request(method: string, body: any = {}) {
  return {
    req: { method, body } as any,
    res: {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any,
  };
}

describe('session/conversationHistory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'testuser' });
    mocks.list.mockResolvedValue([]);
  });

  it('returns reconciled history scoped to the authenticated user', async () => {
    const history = [{ id: 'saved', messages: [{ content: 'Still here' }] }];
    mocks.list.mockResolvedValue(history);
    const { req, res } = request('GET');
    await handler(req, res);
    expect(mocks.list).toHaveBeenCalledWith('testuser');
    expect(res.json).toHaveBeenCalledWith(history);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('returns an error rather than empty history during a storage outage', async () => {
    mocks.list.mockRejectedValue(new Error('Redis unavailable'));
    const { req, res } = request('GET');
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).not.toHaveBeenCalledWith([]);
  });

  it('acknowledges imports only after the durable merge succeeds', async () => {
    const history = [{ id: 'imported', messages: [] }];
    const { req, res } = request('PUT', history);
    await handler(req, res);
    expect(mocks.merge).toHaveBeenCalledWith('testuser', history);
    expect(res.status).toHaveBeenCalledWith(204);

    mocks.merge.mockRejectedValue(new Error('Redis unavailable'));
    const failed = request('PUT', history);
    await handler(failed.req, failed.res);
    expect(failed.res.status).toHaveBeenCalledWith(500);
  });

  it('rejects a malformed import', async () => {
    const { req, res } = request('PUT', {});
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('clears recovered records through the ownership-aware deletion path', async () => {
    mocks.list.mockResolvedValue([{ id: 'legacy' }, { id: 'recovered' }]);
    const { req, res } = request('DELETE');
    await handler(req, res);
    expect(mocks.remove.mock.calls).toEqual([
      ['testuser', 'legacy'],
      ['testuser', 'recovered'],
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('also clears a selected-only legacy conversation', async () => {
    mocks.selected.mockResolvedValue({ id: 'selected-only' });
    const { req, res } = request('DELETE');
    await handler(req, res);
    expect(mocks.remove).toHaveBeenCalledWith('testuser', 'selected-only');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
