import {
  enqueueAllActiveGoals,
  enqueueRun,
  isAllActiveGoalsRunRequest,
  NoActiveGoalsError,
  normalizeImportedGoals,
  QueueFullError,
  sanitizeConfigPatch,
} from '@/server/autonomy/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  llen: vi.fn(),
  lpush: vi.fn(),
  jsonGet: vi.fn(),
  jsonSet: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  sessionKey: (parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  jsonGet: mocks.jsonGet,
  jsonSet: mocks.jsonSet,
}));

vi.mock('@/utils/sync/publish', () => ({
  publishSyncEvent: vi.fn().mockResolvedValue(undefined),
}));

describe('autonomy store config sanitization', () => {
  it('whitelists and clamps source policy fields', () => {
    expect(
      sanitizeConfigPatch({
        sourcePolicy: {
          enabledSources: ['curated_domains', 'missing'] as any,
          disabledSources: ['google_search'],
          maxResearchToolCalls: 99,
          requirePlanApproval: true,
          notes: 'Stay on primary sources.',
        },
      }),
    ).toEqual({
      sourcePolicy: {
        enabledSources: ['curated_domains'],
        disabledSources: ['google_search'],
        maxResearchToolCalls: 20,
        requirePlanApproval: true,
        notes: 'Stay on primary sources.',
      },
    });
  });

  it('drops empty source policy patches', () => {
    expect(
      sanitizeConfigPatch({
        sourcePolicy: {
          enabledSources: ['not-a-source'] as any,
        },
      }),
    ).toEqual({});
  });
});

describe('normalizeImportedGoals', () => {
  it('normalizes bulk goal uploads and preserves safe ids and tags', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

    const goals = normalizeImportedGoals(
      [
        {
          id: 'goal:nvidia-strategy',
          title: 'NVIDIA Strategic Signals',
          description: 'Monitor material NVIDIA strategy signals.',
          status: 'active',
          priority: 1,
          tags: ['goal:nvidia-strategy', 'goal:nvidia-strategy', ''],
          unexpected: 'ignored',
        },
        {
          title: '',
          description: 'invalid',
        },
      ],
      [],
    );

    expect(goals).toEqual([
      {
        id: 'goal_nvidia-strategy',
        title: 'NVIDIA Strategic Signals',
        description: 'Monitor material NVIDIA strategy signals.',
        status: 'active',
        priority: 1,
        tags: ['goal:nvidia-strategy'],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        lastRunAt: null,
      },
    ]);

    vi.spyOn(Date, 'now').mockRestore();
  });
});

describe('autonomy enqueueRun depth cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedis.mockReturnValue({ llen: mocks.llen, lpush: mocks.lpush });
    mocks.lpush.mockResolvedValue(1);
    mocks.jsonGet.mockResolvedValue([]);
  });

  it('throws QueueFullError when at capacity and the cap is enforced (API path)', async () => {
    mocks.llen.mockResolvedValue(100); // >= default AUTONOMY_MAX_QUEUE_DEPTH

    await expect(
      enqueueRun('user-a', { prompt: 'go' }, { enforceDepthCap: true }),
    ).rejects.toBeInstanceOf(QueueFullError);
    expect(mocks.lpush).not.toHaveBeenCalled();
  });

  it('does NOT enforce the cap for internal re-enqueue (no options)', async () => {
    mocks.llen.mockResolvedValue(100);

    const result = await enqueueRun('user-a', { prompt: 'continue' });

    expect(mocks.llen).not.toHaveBeenCalled();
    expect(mocks.lpush).toHaveBeenCalledTimes(1);
    expect(result.id).toMatch(/^request_/);
  });

  it('enqueues normally when under capacity with the cap enforced', async () => {
    mocks.llen.mockResolvedValue(5);

    await enqueueRun('user-a', { prompt: 'go' }, { enforceDepthCap: true });

    expect(mocks.lpush).toHaveBeenCalledTimes(1);
  });
});

describe('autonomy run-all-active-goals enqueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedis.mockReturnValue({ llen: mocks.llen, lpush: mocks.lpush });
    mocks.lpush.mockResolvedValue(1);
    mocks.llen.mockResolvedValue(0);
  });

  it('recognizes narrow positive manual aliases unless negated', () => {
    expect(isAllActiveGoalsRunRequest({ prompt: 'run all goals' })).toBe(true);
    expect(
      isAllActiveGoalsRunRequest({ prompt: 'run every active goal' }),
    ).toBe(true);
    expect(isAllActiveGoalsRunRequest({ prompt: "don't run all goals" })).toBe(
      false,
    );
    expect(
      isAllActiveGoalsRunRequest({
        trigger: 'scheduled',
        prompt: 'run all goals',
      }),
    ).toBe(false);
  });

  it('enqueues one scoped request per active goal in priority order', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mocks.jsonGet.mockResolvedValue([
      {
        id: 'goal_late',
        title: 'Later',
        description: '',
        status: 'active',
        priority: 5,
      },
      {
        id: 'goal_paused',
        title: 'Paused',
        description: '',
        status: 'paused',
        priority: 0,
      },
      {
        id: 'goal_high',
        title: 'High',
        description: '',
        status: 'active',
        priority: 1,
      },
      {
        id: 'goal_tie_a',
        title: 'Tie A',
        description: '',
        status: 'active',
        priority: 2,
      },
      {
        id: 'goal_tie_b',
        title: 'Tie B',
        description: '',
        status: 'active',
        priority: 2,
      },
    ]);

    const result = await enqueueAllActiveGoals(
      'user-a',
      { prompt: 'operator note' },
      { enforceDepthCap: true },
    );

    const [, ...serialized] = mocks.lpush.mock.calls[0];
    const payloads = serialized.map((raw) => JSON.parse(raw));
    expect(payloads.map((request) => request.goalId)).toEqual([
      'goal_high',
      'goal_tie_a',
      'goal_tie_b',
      'goal_late',
    ]);
    expect(payloads.every((request) => request.trigger === 'goal')).toBe(true);
    expect(
      payloads.every((request) => request.prompt === 'operator note'),
    ).toBe(true);
    expect(result).toEqual({
      queued: 4,
      requests: payloads.map((request) => ({
        id: request.id,
        goalId: request.goalId,
        queuedAt: 1700000000000,
      })),
    });

    vi.spyOn(Date, 'now').mockRestore();
  });

  it('returns no-active-goals as an explicit error without enqueueing', async () => {
    mocks.jsonGet.mockResolvedValue([
      { id: 'goal_done', title: 'Done', status: 'completed', priority: 1 },
    ]);

    await expect(enqueueAllActiveGoals('user-a')).rejects.toBeInstanceOf(
      NoActiveGoalsError,
    );
    expect(mocks.lpush).not.toHaveBeenCalled();
  });

  it('checks queue capacity before enqueueing any batch request', async () => {
    mocks.jsonGet.mockResolvedValue([
      { id: 'goal_a', title: 'A', status: 'active', priority: 1 },
      { id: 'goal_b', title: 'B', status: 'active', priority: 2 },
    ]);
    mocks.llen.mockResolvedValue(99);

    await expect(
      enqueueAllActiveGoals('user-a', {}, { enforceDepthCap: true }),
    ).rejects.toBeInstanceOf(QueueFullError);
    expect(mocks.lpush).not.toHaveBeenCalled();
  });
});
