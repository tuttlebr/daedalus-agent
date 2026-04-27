import handler from '@/pages/api/images/history';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const jsonGet = vi.fn();
const jsonSetWithExpiry = vi.fn();
const getOrSetSessionId = vi.fn();
const getUserId = vi.fn();

vi.mock('@/pages/api/session/_utils', () => ({
  getOrSetSessionId,
  getUserId,
}));

vi.mock('@/pages/api/session/redis', () => ({
  jsonGet,
  jsonSetWithExpiry,
  sessionKey: vi.fn((parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  ),
}));

function createMockReqRes(method: string, body: unknown = {}) {
  const req = { method, body, headers: {} } as any;
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
});
