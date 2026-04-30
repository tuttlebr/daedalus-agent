import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jsonGet: vi.fn(),
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn(),
  getOrSetSessionId: vi.fn(),
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock('@/pages/api/session/_utils', () => ({
  getOrSetSessionId: mocks.getOrSetSessionId,
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

vi.mock('@/pages/api/session/redis', () => ({
  jsonGet: mocks.jsonGet,
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  jsonDel: mocks.jsonDel,
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

import handler from '@/pages/api/images/history';

function createMockReqRes(
  method: string,
  body: unknown = {},
  query: Record<string, string> = {},
) {
  const req = { method, body, query, headers: {} } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  return { req, res };
}

function entry(id = 'hist-1') {
  return {
    id,
    mode: 'generate',
    prompt: 'a prompt',
    params: { quality: 'medium' },
    inputImages: [],
    maskImage: null,
    outputImageIds: ['abc-123'],
    model: 'test-model',
    createdAt: 1700000000000,
  };
}

describe('/api/images/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrSetSessionId.mockReturnValue('session-1');
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'testuser' });
    mocks.jsonGet.mockResolvedValue([]);
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
    mocks.jsonDel.mockResolvedValue(undefined);
  });

  it('returns stored history for the current user', async () => {
    const stored = [entry()];
    mocks.jsonGet.mockResolvedValue(stored);
    const { req, res } = createMockReqRes('GET');

    await handler(req, res);

    expect(mocks.jsonGet).toHaveBeenCalledWith('user:testuser:imagePanelHistory');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ history: stored });
  });

  it('stores a valid entry and clamps history to 50 entries', async () => {
    const existing = Array.from({ length: 50 }, (_, index) =>
      entry(`hist-${index}`),
    );
    mocks.jsonGet.mockResolvedValue(existing);
    const nextEntry = entry('new-entry');
    const { req, res } = createMockReqRes('POST', { entry: nextEntry });

    await handler(req, res);

    const savedHistory = mocks.jsonSetWithExpiry.mock.calls[0][1];
    expect(savedHistory).toHaveLength(50);
    expect(savedHistory[0]).toEqual(nextEntry);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects malformed entries', async () => {
    const { req, res } = createMockReqRes('POST', {
      entry: { ...entry(), outputImageIds: [] },
    });

    await handler(req, res);

    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid image history entry',
    });
  });

  describe('DELETE', () => {
    it('removes one entry by id and persists the remaining list', async () => {
      const stored = [entry('hist-1'), entry('hist-2'), entry('hist-3')];
      mocks.jsonGet.mockResolvedValue(stored);
      const { req, res } = createMockReqRes('DELETE', {}, { id: 'hist-2' });

      await handler(req, res);

      expect(mocks.jsonSetWithExpiry).toHaveBeenCalledTimes(1);
      const savedKey = mocks.jsonSetWithExpiry.mock.calls[0][0];
      const savedHistory = mocks.jsonSetWithExpiry.mock.calls[0][1];
      expect(savedKey).toBe('user:testuser:imagePanelHistory');
      expect(savedHistory).toHaveLength(2);
      expect(savedHistory.map((e: any) => e.id)).toEqual(['hist-1', 'hist-3']);
      expect(mocks.jsonDel).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: savedHistory });
    });

    it('clears all history when all=1', async () => {
      const stored = [entry('hist-1'), entry('hist-2')];
      mocks.jsonGet.mockResolvedValue(stored);
      const { req, res } = createMockReqRes('DELETE', {}, { all: '1' });

      await handler(req, res);

      expect(mocks.jsonDel).toHaveBeenCalledTimes(1);
      expect(mocks.jsonDel).toHaveBeenCalledWith('user:testuser:imagePanelHistory');
      expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: [] });
    });

    it('returns the unchanged list when the id is missing from history', async () => {
      const stored = [entry('hist-1'), entry('hist-2')];
      mocks.jsonGet.mockResolvedValue(stored);
      const { req, res } = createMockReqRes('DELETE', {}, { id: 'nope' });

      await handler(req, res);

      expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(mocks.jsonDel).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: stored });
    });

    it('returns 400 when neither id nor all is provided', async () => {
      const { req, res } = createMockReqRes('DELETE', {}, {});

      await handler(req, res);

      expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(mocks.jsonDel).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing id or all=1',
      });
    });

    it('uses jsonDel when removing the last remaining entry', async () => {
      mocks.jsonGet.mockResolvedValue([entry('only')]);
      const { req, res } = createMockReqRes('DELETE', {}, { id: 'only' });

      await handler(req, res);

      expect(mocks.jsonDel).toHaveBeenCalledTimes(1);
      expect(mocks.jsonDel).toHaveBeenCalledWith('user:testuser:imagePanelHistory');
      expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: [] });
    });
  });
});
