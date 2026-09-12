// @vitest-environment node
import {
  cancelQueuedRequest,
  cancelRun,
  createGoal,
  enqueueAllActiveGoals,
  enqueueRun,
  getConfig,
  getRun,
  importGoals,
  isAllActiveGoalsRunRequest,
  listEvents,
  listFeed,
  listQueuedRequests,
  listRuns,
  NoActiveGoalsError,
  normalizeImportedGoals,
  QueueFullError,
  sanitizeConfigPatch,
  saveConfig,
} from '@/server/autonomy/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  llen: vi.fn(),
  lpush: vi.fn(),
  lrange: vi.fn(),
  lrem: vi.fn(),
  get: vi.fn(),
  setex: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
  jsonGet: vi.fn(),
  jsonSet: vi.fn(),
  publishSyncEvent: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  sessionKey: (parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  jsonGet: mocks.jsonGet,
  jsonSet: mocks.jsonSet,
}));

vi.mock('@/utils/sync/publish', () => ({
  publishSyncEvent: mocks.publishSyncEvent,
}));

// Unit assertions below cover goal normalization and publication. Atomic
// snapshot conflicts and both Redis types are exercised in goals.integration.
vi.mock('@/server/atomicJson', () => ({
  updateJsonAtomically: vi.fn(
    async (key: string, update: (value: any) => any) => {
      const next = update(await mocks.jsonGet(key));
      if (next !== null) await mocks.jsonSet(key, '$', next);
      return next;
    },
  ),
}));

describe('autonomy store config sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishSyncEvent.mockResolvedValue(undefined);
  });

  it('whitelists and clamps source policy fields', () => {
    expect(
      sanitizeConfigPatch({
        sourcePolicy: {
          enabledSources: ['curated_domains', 'missing'] as any,
          disabledSources: ['perplexity_search'],
          maxResearchToolCalls: 99,
          requirePlanApproval: true,
          notes: 'Stay on primary sources.',
        },
      }),
    ).toEqual({
      sourcePolicy: {
        enabledSources: ['curated_domains'],
        disabledSources: ['perplexity_search'],
        maxResearchToolCalls: 20,
        requirePlanApproval: false,
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

  it('disables plan approval in previously persisted autonomy config', async () => {
    mocks.jsonGet.mockResolvedValue({
      enabled: true,
      sourcePolicy: {
        maxResearchToolCalls: 6,
        requirePlanApproval: true,
      },
    });

    const config = await getConfig('test-user');

    expect(config.sourcePolicy?.requirePlanApproval).toBe(false);
  });

  it('creates and persists the default config when none exists', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mocks.jsonGet.mockResolvedValue(null);

    const config = await getConfig('test-user');

    expect(config).toMatchObject({
      enabled: true,
      userId: 'test-user',
      intervalSeconds: 14_400,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    expect(mocks.jsonSet).toHaveBeenCalledWith(
      'autonomy:test-user:config',
      '$',
      config,
    );
    vi.restoreAllMocks();
  });

  it('persists a sanitized config patch and publishes the result', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mocks.jsonGet.mockResolvedValue(null);

    const config = await saveConfig('test-user', {
      enabled: false,
      mode: 'task_executor',
      runtime: 'dedicated_worker',
      actionPolicy: 'read_memory_only',
      intervalSeconds: 1,
      maxRunsStored: 5000,
      maxFeedItems: 0,
      feedDedupeEnabled: false,
      feedDedupeWindowDays: 365,
    });

    expect(config).toMatchObject({
      enabled: false,
      mode: 'task_executor',
      actionPolicy: 'read_memory_only',
      intervalSeconds: 300,
      maxRunsStored: 1000,
      maxFeedItems: 1,
      feedDedupeEnabled: false,
      feedDedupeWindowDays: 90,
      userId: 'test-user',
    });
    expect(mocks.publishSyncEvent).toHaveBeenCalledWith(
      'test-user',
      expect.objectContaining({
        type: 'autonomy_status',
        data: { config },
      }),
    );
    vi.restoreAllMocks();
  });

  it('drops invalid config shapes and non-finite numeric values', () => {
    expect(sanitizeConfigPatch(null as any)).toEqual({});
    expect(
      sanitizeConfigPatch({
        mode: 'invalid' as any,
        runtime: 'invalid' as any,
        actionPolicy: 'invalid' as any,
        intervalSeconds: Number.NaN,
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

  it('deduplicates ids and supplies safe defaults for incomplete goals', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

    const goals = normalizeImportedGoals(
      [
        { id: 'goal_existing', title: ' First ', priority: 'invalid' },
        { id: 'goal_existing', title: 'Second', status: 'invalid' },
        { id: 12, title: 'Generated', tags: 'invalid' },
        null,
      ],
      [{ id: 'goal_existing' } as any],
    );

    expect(goals).toHaveLength(3);
    expect(goals[0]).toMatchObject({
      id: 'goal_existing_2',
      title: 'First',
      description: '',
      status: 'active',
      priority: 3,
    });
    expect(goals[1].id).toBe('goal_existing_3');
    expect(goals[2].id).toMatch(/^goal_[a-f0-9]{32}$/);
    expect(goals[2]).not.toHaveProperty('tags');
    vi.restoreAllMocks();
  });
});

describe('autonomy goal persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishSyncEvent.mockResolvedValue(undefined);
  });

  it('appends imported goals ahead of existing goals and reports skips', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const existing = {
      id: 'goal_existing',
      title: 'Existing',
      status: 'paused',
      priority: 2,
    };
    mocks.jsonGet.mockResolvedValue([existing]);

    const result = await importGoals(
      'user-a',
      [{ id: 'new', title: 'New' }, { title: '' }],
      'append',
    );

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.goals.map((goal) => goal.id)).toEqual([
      'goal_new',
      'goal_existing',
    ]);
    expect(mocks.jsonSet).toHaveBeenCalledWith(
      'autonomy:user-a:goals',
      '$',
      result.goals,
    );
    expect(mocks.publishSyncEvent).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('creates a goal with trimmed values and stores it first', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mocks.jsonGet.mockResolvedValue([
      { id: 'goal_existing', title: 'Existing' },
    ]);

    const goal = await createGoal('user-a', {
      title: ' New goal ',
      description: ' Details ',
      status: 'paused',
      priority: 1,
    });

    expect(goal).toMatchObject({
      title: 'New goal',
      description: 'Details',
      status: 'paused',
      priority: 1,
    });
    expect(goal.id).toMatch(/^goal_[a-f0-9]{32}$/);
    expect(mocks.jsonSet.mock.calls.at(-1)?.[2]).toEqual([
      goal,
      { id: 'goal_existing', title: 'Existing' },
    ]);
    vi.restoreAllMocks();
  });
});

describe('autonomy queue reads and cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishSyncEvent.mockResolvedValue(undefined);
    mocks.getRedis.mockReturnValue({
      lrange: mocks.lrange,
      lrem: mocks.lrem,
    });
  });

  it('normalizes queued records in display order and ignores corrupt entries', async () => {
    mocks.lrange.mockResolvedValue([
      JSON.stringify({ id: 'new', createdAt: 20, requestedBy: 'worker' }),
      '{not-json',
      JSON.stringify({ trigger: 'goal', goalId: 'goal_a', prompt: 'Run' }),
      'null',
    ]);

    await expect(listQueuedRequests('user-a')).resolves.toEqual([
      {
        id: 'queued_2',
        trigger: 'goal',
        goalId: 'goal_a',
        prompt: 'Run',
        requestedBy: 'unknown',
        createdAt: 0,
        position: 2,
      },
      {
        id: 'new',
        trigger: 'manual',
        goalId: null,
        prompt: '',
        requestedBy: 'worker',
        createdAt: 20,
        position: 4,
      },
    ]);
  });

  it('rejects empty or missing queued request ids without removing data', async () => {
    mocks.lrange.mockResolvedValue(['{bad-json', JSON.stringify({ id: 'a' })]);

    await expect(cancelQueuedRequest('user-a', ' ')).resolves.toBe(false);
    await expect(cancelQueuedRequest('user-a', 'missing')).resolves.toBe(false);
    expect(mocks.lrem).not.toHaveBeenCalled();
  });

  it('reports a dequeue race and publishes successful queue cancellation', async () => {
    const raw = JSON.stringify({ id: 'request_1' });
    mocks.lrange.mockResolvedValue([raw]);
    mocks.lrem.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(cancelQueuedRequest('user-a', 'request_1')).resolves.toBe(
      false,
    );
    await expect(cancelQueuedRequest('user-a', 'request_1')).resolves.toBe(
      true,
    );
    expect(mocks.publishSyncEvent).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ data: { dequeued: 'request_1' } }),
    );
  });
});

describe('autonomy run, event, and feed persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishSyncEvent.mockResolvedValue(undefined);
    mocks.getRedis.mockReturnValue({ set: mocks.set });
    mocks.set.mockResolvedValue('OK');
  });

  it('lists runs, finds a selected run, and returns null when absent', async () => {
    const runs = [{ id: 'run_a' }, { id: 'run_b' }];
    mocks.jsonGet.mockResolvedValue(runs);

    await expect(listRuns('user-a')).resolves.toEqual(runs);
    await expect(getRun('user-a', 'run_b')).resolves.toEqual({ id: 'run_b' });
    await expect(getRun('user-a', 'missing')).resolves.toBeNull();
  });

  it('filters events by run and lists feed items', async () => {
    mocks.jsonGet.mockImplementation(async (key: string) =>
      key.endsWith(':events')
        ? [{ runId: 'run_a' }, { runId: 'run_b' }]
        : [{ id: 'feed_a' }],
    );

    await expect(listEvents('user-a')).resolves.toHaveLength(2);
    await expect(listEvents('user-a', 'run_b')).resolves.toEqual([
      { runId: 'run_b' },
    ]);
    await expect(listFeed('user-a')).resolves.toEqual([{ id: 'feed_a' }]);
  });

  it('marks only cancellable runs and writes a durable cancellation flag', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mocks.jsonGet.mockResolvedValue([
      { id: 'run_a', status: 'running' },
      { id: 'run_b', status: 'completed' },
    ]);

    await cancelRun('user-a', 'run_a');

    expect(mocks.set).toHaveBeenCalledWith(
      'autonomy:user-a:cancel:run_a',
      '1',
      'EX',
      13_800,
    );
    expect(mocks.jsonSet).toHaveBeenCalledWith('autonomy:user-a:runs', '$', [
      {
        id: 'run_a',
        status: 'cancelled',
        updatedAt: 1700000000000,
        completedAt: 1700000000000,
      },
      { id: 'run_b', status: 'completed' },
    ]);
    expect(mocks.publishSyncEvent).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({
        data: { runId: 'run_a', status: 'cancelled' },
      }),
    );
    vi.restoreAllMocks();
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

    await expect(enqueueRun('user-a', { prompt: 'go' })).rejects.toBeInstanceOf(
      QueueFullError,
    );
    expect(mocks.lpush).not.toHaveBeenCalled();
  });

  it('enqueues normally when under capacity with the cap enforced', async () => {
    mocks.llen.mockResolvedValue(5);

    await enqueueRun('user-a', { prompt: 'go' });

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

    const result = await enqueueAllActiveGoals('user-a', {
      prompt: 'operator note',
    });

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

    await expect(enqueueAllActiveGoals('user-a', {})).rejects.toBeInstanceOf(
      QueueFullError,
    );
    expect(mocks.lpush).not.toHaveBeenCalled();
  });
});
