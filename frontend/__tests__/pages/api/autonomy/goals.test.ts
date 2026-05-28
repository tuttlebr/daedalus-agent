import type { NextApiRequest, NextApiResponse } from 'next';

import type { AutonomyGoal } from '@/types/autonomy';

import handler from '@/pages/api/autonomy/goals';

import { createGoal, listGoals, saveGoals } from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock('@/server/autonomy/store', () => ({
  createGoal: vi.fn(),
  listGoals: vi.fn(),
  nowMs: vi.fn(() => 12345),
  saveGoals: vi.fn(),
}));

function createMockReqRes(
  method: string,
  query: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
) {
  const req = { method, query, body } as NextApiRequest;
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

function goal(id: string, title: string): AutonomyGoal {
  return {
    id,
    title,
    description: '',
    status: 'active',
    priority: 3,
    createdAt: 1,
    updatedAt: 1,
    lastRunAt: null,
  };
}

describe('autonomy goals API handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      username: 'testuser',
    } as Awaited<ReturnType<typeof requireAuthenticatedUser>>);
  });

  it('removes a goal from the persisted goal list', async () => {
    const keep = goal('goal_keep', 'Keep watching releases');
    const remove = goal('goal_remove', 'Remove me');
    vi.mocked(listGoals).mockResolvedValue([keep, remove]);
    const { req, res } = createMockReqRes('DELETE', { id: remove.id });

    await handler(req, res);

    expect(saveGoals).toHaveBeenCalledWith('testuser', [keep]);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('accepts delete ids from the request body', async () => {
    const keep = goal('goal_keep', 'Keep watching releases');
    const remove = goal('goal_remove', 'Remove me');
    vi.mocked(listGoals).mockResolvedValue([keep, remove]);
    const { req, res } = createMockReqRes('DELETE', {}, { id: remove.id });

    await handler(req, res);

    expect(saveGoals).toHaveBeenCalledWith('testuser', [keep]);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('returns 400 when deleting without a goal id', async () => {
    const { req, res } = createMockReqRes('DELETE');

    await handler(req, res);

    expect(saveGoals).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'id is required' });
  });

  it('creates goals through the shared autonomy store', async () => {
    const created = goal('goal_created', 'Track releases');
    vi.mocked(createGoal).mockResolvedValue(created);
    const { req, res } = createMockReqRes(
      'POST',
      {},
      {
        title: created.title,
        description: '',
      },
    );

    await handler(req, res);

    expect(createGoal).toHaveBeenCalledWith('testuser', {
      title: created.title,
      description: '',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(created);
  });
});
