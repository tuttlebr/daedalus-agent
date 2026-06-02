import {
  enqueueRun,
  QueueFullError,
  sanitizeConfigPatch,
} from '@/server/autonomy/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  llen: vi.fn(),
  lpush: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  sessionKey: (parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
  jsonGet: vi.fn(),
  jsonSet: vi.fn(),
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

describe('autonomy enqueueRun depth cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedis.mockReturnValue({ llen: mocks.llen, lpush: mocks.lpush });
    mocks.lpush.mockResolvedValue(1);
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
