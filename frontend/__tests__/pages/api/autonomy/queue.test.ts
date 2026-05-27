import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock('@/server/autonomy/store', () => ({
  listQueuedRequests: vi.fn(),
}));

import handler from '@/pages/api/autonomy/queue';
import { listQueuedRequests } from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

function createMockReqRes(method: string) {
  const req = { method } as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as NextApiResponse & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
  return { req, res };
}

describe('autonomy queue API handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      username: 'testuser',
    } as Awaited<ReturnType<typeof requireAuthenticatedUser>>);
  });

  it('returns queued requests for the authenticated user', async () => {
    const queued = [
      {
        id: 'request_1',
        trigger: 'manual',
        prompt: 'Check updates',
        requestedBy: 'ui',
        createdAt: 123,
        position: 1,
      },
    ];
    vi.mocked(listQueuedRequests).mockResolvedValue(queued);
    const { req, res } = createMockReqRes('GET');

    await handler(req, res);

    expect(listQueuedRequests).toHaveBeenCalledWith('testuser');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(queued);
  });

  it('rejects unsupported methods', async () => {
    const { req, res } = createMockReqRes('POST');

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
