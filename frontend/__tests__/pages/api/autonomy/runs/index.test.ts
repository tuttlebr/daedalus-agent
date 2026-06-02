import handler from '@/pages/api/autonomy/runs/index';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class QueueFullError extends Error {
    maxDepth: number;
    constructor(maxDepth: number) {
      super(`full ${maxDepth}`);
      this.name = 'QueueFullError';
      this.maxDepth = maxDepth;
    }
  }
  return {
    enqueueRun: vi.fn(),
    listRuns: vi.fn(),
    QueueFullError,
    enforceRateLimit: vi.fn(),
    ruleFromEnv: vi.fn(() => ({ name: 'x', limit: 30, windowSeconds: 60 })),
    requireAuthenticatedUser: vi.fn(),
  };
});

vi.mock('@/server/autonomy/store', () => ({
  enqueueRun: mocks.enqueueRun,
  listRuns: mocks.listRuns,
  QueueFullError: mocks.QueueFullError,
}));

vi.mock('@/server/rateLimit', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  ruleFromEnv: mocks.ruleFromEnv,
}));

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
}));

function make(method: string, body?: unknown) {
  const req = { method, body, query: {}, headers: {} } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    end: vi.fn().mockReturnThis(),
  } as any;
  return { req, res };
}

describe('/api/autonomy/runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedUser.mockResolvedValue({ username: 'alice' });
    mocks.enforceRateLimit.mockResolvedValue(true);
  });

  it('enqueues with the depth cap enforced and returns 202', async () => {
    mocks.enqueueRun.mockResolvedValue({ id: 'request_1', queuedAt: 1 });
    const { req, res } = make('POST', { prompt: 'go' });

    await handler(req, res);

    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      'alice',
      { prompt: 'go' },
      { enforceDepthCap: true },
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ id: 'request_1', queuedAt: 1 });
  });

  it('returns 429 with Retry-After when the queue is full', async () => {
    mocks.enqueueRun.mockRejectedValue(new mocks.QueueFullError(100));
    const { req, res } = make('POST', {});

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('does not enqueue when the request is rate limited', async () => {
    mocks.enforceRateLimit.mockResolvedValue(false);
    const { req, res } = make('POST', {});

    await handler(req, res);

    expect(mocks.enqueueRun).not.toHaveBeenCalled();
  });

  it('rethrows non-QueueFull errors (surfaced as 500 by the framework)', async () => {
    mocks.enqueueRun.mockRejectedValue(new Error('boom'));
    const { req, res } = make('POST', {});

    await expect(handler(req, res)).rejects.toThrow('boom');
  });

  it('lists runs on GET', async () => {
    mocks.listRuns.mockResolvedValue([{ id: 'r1' }]);
    const { req, res } = make('GET');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([{ id: 'r1' }]);
  });
});
