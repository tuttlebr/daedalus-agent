import handler from '@/pages/api/images/history';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const jsonGet = vi.fn();
const jsonSetWithExpiry = vi.fn();
const jsonDel = vi.fn();
const getOrSetSessionId = vi.fn();
const getUserId = vi.fn();

vi.mock('@/pages/api/session/_utils', () => ({
  getOrSetSessionId,
  getUserId,
}));

vi.mock('@/pages/api/session/redis', () => ({
  jsonGet,
  jsonSetWithExpiry,
  jsonDel,
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

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
    getOrSetSessionId.mockReturnValue('session-1');
    getUserId.mockResolvedValue('testuser');
    jsonGet.mockResolvedValue([]);
    jsonSetWithExpiry.mockResolvedValue(undefined);
    jsonDel.mockResolvedValue(undefined);
  });

  it('returns stored history for the current user', async () => {
    const stored = [entry()];
    jsonGet.mockResolvedValue(stored);
    const { req, res } = createMockReqRes('GET');

    await handler(req, res);

    expect(jsonGet).toHaveBeenCalledWith('user:testuser:imagePanelHistory');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ history: stored });
  });

  it('stores a valid entry and clamps history to 50 entries', async () => {
    const existing = Array.from({ length: 50 }, (_, index) =>
      entry(`hist-${index}`),
    );
    jsonGet.mockResolvedValue(existing);
    const nextEntry = entry('new-entry');
    const { req, res } = createMockReqRes('POST', { entry: nextEntry });

    await handler(req, res);

    const savedHistory = jsonSetWithExpiry.mock.calls[0][1];
    expect(savedHistory).toHaveLength(50);
    expect(savedHistory[0]).toEqual(nextEntry);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects malformed entries', async () => {
    const { req, res } = createMockReqRes('POST', {
      entry: { ...entry(), outputImageIds: [] },
    });

    await handler(req, res);

    expect(jsonSetWithExpiry).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid image history entry',
    });
  });

  describe('DELETE', () => {
    it('removes one entry by id and persists the remaining list', async () => {
      const stored = [entry('hist-1'), entry('hist-2'), entry('hist-3')];
      jsonGet.mockResolvedValue(stored);
      const { req, res } = createMockReqRes('DELETE', {}, { id: 'hist-2' });

      await handler(req, res);

      expect(jsonSetWithExpiry).toHaveBeenCalledTimes(1);
      const savedKey = jsonSetWithExpiry.mock.calls[0][0];
      const savedHistory = jsonSetWithExpiry.mock.calls[0][1];
      expect(savedKey).toBe('user:testuser:imagePanelHistory');
      expect(savedHistory).toHaveLength(2);
      expect(savedHistory.map((e: any) => e.id)).toEqual(['hist-1', 'hist-3']);
      expect(jsonDel).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: savedHistory });
    });

    it('clears all history when all=1', async () => {
      const stored = [entry('hist-1'), entry('hist-2')];
      jsonGet.mockResolvedValue(stored);
      const { req, res } = createMockReqRes('DELETE', {}, { all: '1' });

      await handler(req, res);

      expect(jsonDel).toHaveBeenCalledTimes(1);
      expect(jsonDel).toHaveBeenCalledWith('user:testuser:imagePanelHistory');
      expect(jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: [] });
    });

    it('returns the unchanged list when the id is missing from history', async () => {
      const stored = [entry('hist-1'), entry('hist-2')];
      jsonGet.mockResolvedValue(stored);
      const { req, res } = createMockReqRes('DELETE', {}, { id: 'nope' });

      await handler(req, res);

      expect(jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(jsonDel).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: stored });
    });

    it('returns 400 when neither id nor all is provided', async () => {
      const { req, res } = createMockReqRes('DELETE', {}, {});

      await handler(req, res);

      expect(jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(jsonDel).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing id or all=1',
      });
    });

    it('uses jsonDel when removing the last remaining entry', async () => {
      jsonGet.mockResolvedValue([entry('only')]);
      const { req, res } = createMockReqRes('DELETE', {}, { id: 'only' });

      await handler(req, res);

      expect(jsonDel).toHaveBeenCalledTimes(1);
      expect(jsonDel).toHaveBeenCalledWith('user:testuser:imagePanelHistory');
      expect(jsonSetWithExpiry).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ history: [] });
    });
  });
});
