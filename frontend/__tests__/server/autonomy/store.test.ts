import {
  enqueueAllActiveGoals,
  enqueueRun,
  isAllActiveGoalsRunRequest,
  NoActiveGoalsError,
  normalizeImportedGoals,
  QueueFullError,
  sanitizeConfigPatch,
  updateApproval,
} from '@/server/autonomy/store';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  llen: vi.fn(),
  lpush: vi.fn(),
  get: vi.fn(),
  setex: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
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

describe('autonomy approval credential boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setex.mockResolvedValue('OK');
    mocks.set.mockResolvedValue('OK');
    mocks.eval.mockImplementation(async (...args: any[]) => {
      const script = String(args[0] || '');
      if (script.includes('approval marker key has incompatible type')) {
        return [1, args[7]];
      }
      return 1;
    });
    mocks.lpush.mockResolvedValue(1);
    mocks.getRedis.mockReturnValue({
      llen: mocks.llen,
      lpush: mocks.lpush,
      get: mocks.get,
      setex: mocks.setex,
      set: mocks.set,
      eval: mocks.eval,
    });
  });

  it('mints an exact credential only while resolving a pending approval', async () => {
    const canonicalArguments =
      '{"name":"api","namespace":"production","replicas":3}';
    const argumentsSha256 = createHash('sha256')
      .update(canonicalArguments)
      .digest('hex');
    let approvals: any[] = [
      {
        id: 'approval-1',
        runId: 'run-1',
        status: 'pending',
        action: 'Scale API',
        reason: 'operator request',
        actionType: 'mcp_mutation',
        target: 'production/api',
        serverName: 'k8s_mcp_server',
        toolName: 'scale_deployment',
        approvalRequestId: 'pending-1',
        argumentsPreview: canonicalArguments,
        argumentsSha256,
        risk: 'medium',
        createdAt: 1,
      },
    ];
    mocks.jsonGet.mockImplementation(async (key: string) => {
      if (key.endsWith(':approvals')) return approvals;
      return [];
    });
    mocks.jsonSet.mockImplementation(
      async (key: string, _path: string, value: unknown) => {
        if (key.endsWith(':approvals')) approvals = value as any[];
      },
    );
    const pendingIntent = JSON.stringify({
      request_id: 'pending-1',
      user_id: 'alice',
      action_type: 'mcp_mutation',
      action: 'Scale API',
      reason: 'operator request',
      target: 'production/api',
      server_name: 'k8s_mcp_server',
      tool_name: 'scale_deployment',
      canonical_arguments: canonicalArguments,
      arguments_preview: canonicalArguments,
      arguments_sha256: argumentsSha256,
    });
    let resolutionMarker = '';
    mocks.get.mockImplementation(async (key: string) =>
      key.includes('approval-resolution:')
        ? resolutionMarker || null
        : pendingIntent,
    );
    mocks.eval.mockImplementation(async (...args: any[]) => {
      const script = String(args[0] || '');
      if (!script.includes('approval marker key has incompatible type'))
        return 1;
      if (resolutionMarker) return [0, resolutionMarker];
      resolutionMarker = args[7];
      const resolvedApproval = JSON.parse(args[14]);
      approvals = approvals.map((approval) =>
        approval.id === resolvedApproval.id ? resolvedApproval : approval,
      );
      return [1, resolutionMarker];
    });

    const resolved = await updateApproval('alice', 'approval-1', 'approved');

    expect(resolved?.status).toBe('approved');
    expect(resolved).not.toHaveProperty('approvalToken');
    expect(mocks.setex).not.toHaveBeenCalled();
    const commitCall = mocks.eval.mock.calls.find(([script]) =>
      String(script).includes('approval marker key has incompatible type'),
    )!;
    const executionKey = commitCall[3];
    const rawExecution = commitCall[8];
    expect(executionKey).toMatch(/^autonomy:alice:approval-execution:request_/);
    expect(JSON.parse(rawExecution)).toMatchObject({
      approvalId: 'approval-1',
      actionType: 'mcp_mutation',
      serverName: 'k8s_mcp_server',
      toolName: 'scale_deployment',
      canonicalArguments,
      argumentsSha256,
    });
    expect(commitCall[5]).toMatch(/^approval-pending:/);
    expect(commitCall[12]).toBe('1');
    const queued = commitCall[9] as string;
    expect(queued).not.toContain('approval_token');
    expect(queued).not.toContain(canonicalArguments);
    expect(JSON.parse(queued)).toMatchObject({
      trigger: 'approval',
      approvalId: 'approval-1',
      actionType: 'mcp_mutation',
    });

    await updateApproval('alice', 'approval-1', 'approved');
    const commitCalls = mocks.eval.mock.calls.filter(([script]) =>
      String(script).includes('approval marker key has incompatible type'),
    );
    expect(commitCalls).toHaveLength(1);
  });

  it('does not mint a credential when an approval is denied', async () => {
    mocks.jsonGet.mockResolvedValue([
      {
        id: 'approval-2',
        runId: 'run-2',
        status: 'pending',
        action: 'Delete',
        reason: 'request',
        actionType: 'delete_memory',
        target: 'alice',
        risk: 'high',
        createdAt: 1,
      },
    ]);

    const resolved = await updateApproval('alice', 'approval-2', 'denied');

    expect(resolved?.status).toBe('denied');
    expect(mocks.setex).not.toHaveBeenCalled();
    expect(mocks.lpush).not.toHaveBeenCalled();
    const commitCall = mocks.eval.mock.calls.find(([script]) =>
      String(script).includes('approval marker key has incompatible type'),
    )!;
    expect(commitCall[8]).toBe('');
    expect(commitCall[9]).toBe('');
  });

  it('fails closed when protected MCP intent integrity does not match', async () => {
    mocks.jsonGet.mockResolvedValue([
      {
        id: 'approval-bad',
        runId: 'run-bad',
        status: 'pending',
        action: 'Scale API',
        reason: 'request',
        actionType: 'mcp_mutation',
        target: 'production/api',
        serverName: 'k8s_mcp_server',
        toolName: 'scale_deployment',
        approvalRequestId: 'pending-bad',
        argumentsSha256: 'a'.repeat(64),
        risk: 'medium',
        createdAt: 1,
      },
    ]);
    mocks.get.mockResolvedValue(
      JSON.stringify({
        request_id: 'pending-bad',
        user_id: 'alice',
        action_type: 'mcp_mutation',
        action: 'Scale API',
        reason: 'request',
        target: 'production/api',
        server_name: 'k8s_mcp_server',
        tool_name: 'scale_deployment',
        canonical_arguments: '{"replicas":30}',
        arguments_preview: '{"replicas":3}',
        arguments_sha256: '0'.repeat(64),
      }),
    );

    await expect(
      updateApproval('alice', 'approval-bad', 'approved'),
    ).rejects.toThrow('integrity validation');
    expect(mocks.setex).not.toHaveBeenCalled();
    expect(mocks.lpush).not.toHaveBeenCalled();
  });

  it('does not enqueue twice when the atomic commit reply is lost', async () => {
    const canonicalArguments = '{"name":"api","replicas":3}';
    const argumentsSha256 = createHash('sha256')
      .update(canonicalArguments)
      .digest('hex');
    let approvals: any[] = [
      {
        id: 'approval-retry',
        runId: 'run-retry',
        status: 'pending',
        action: 'Scale API',
        reason: 'operator request',
        actionType: 'mcp_mutation',
        target: 'production/api',
        serverName: 'k8s_mcp_server',
        toolName: 'scale_deployment',
        approvalRequestId: 'pending-retry',
        argumentsPreview: canonicalArguments,
        argumentsSha256,
        risk: 'medium',
        createdAt: 1,
      },
    ];
    const pendingIntent = JSON.stringify({
      request_id: 'pending-retry',
      user_id: 'alice',
      action_type: 'mcp_mutation',
      action: 'Scale API',
      reason: 'operator request',
      target: 'production/api',
      server_name: 'k8s_mcp_server',
      tool_name: 'scale_deployment',
      canonical_arguments: canonicalArguments,
      arguments_preview: canonicalArguments,
      arguments_sha256: argumentsSha256,
    });
    let resolutionMarker = '';
    let queuedPayload = '';
    let commitCount = 0;
    mocks.jsonGet.mockImplementation(async (key: string) =>
      key.endsWith(':approvals') ? approvals : [],
    );
    mocks.get.mockImplementation(async (key: string) =>
      key.includes('approval-resolution:')
        ? resolutionMarker || null
        : pendingIntent,
    );
    mocks.eval.mockImplementation(async (...args: any[]) => {
      const script = String(args[0] || '');
      if (!script.includes('approval marker key has incompatible type'))
        return 1;
      if (resolutionMarker) return [0, resolutionMarker];
      commitCount += 1;
      resolutionMarker = args[7];
      queuedPayload = args[9];
      const resolvedApproval = JSON.parse(args[14]);
      approvals = approvals.map((approval) =>
        approval.id === resolvedApproval.id ? resolvedApproval : approval,
      );
      throw new Error('Redis reply lost after commit');
    });

    await expect(
      updateApproval('alice', 'approval-retry', 'approved'),
    ).rejects.toThrow('Redis reply lost after commit');
    await expect(
      updateApproval('alice', 'approval-retry', 'approved'),
    ).resolves.toMatchObject({ status: 'approved' });

    expect(commitCount).toBe(1);
    expect(JSON.parse(queuedPayload)).toMatchObject({
      approvalId: 'approval-retry',
    });
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
