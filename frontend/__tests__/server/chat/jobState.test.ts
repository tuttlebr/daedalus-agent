import {
  claimTerminalJobStatus,
  updateJobStatus,
} from '@/server/chat/jobState';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, any>(),
  locked: false,
  publisher: { publish: vi.fn().mockResolvedValue(undefined) },
  jsonSetWithExpiry: vi.fn(),
  redis: {
    get: vi.fn(async (key: string) => {
      const value = mocks.store.get(key);
      return value === undefined ? null : JSON.stringify(value);
    }),
    set: vi.fn(async () => {
      if (mocks.locked) return null;
      mocks.locked = true;
      return 'OK';
    }),
    eval: vi.fn(async (...args: any[]) => {
      const script = args[0] as string;
      if (script.includes('CLAIM_TERMINAL_FINALIZATION')) {
        const key = args[2] as string;
        const journalKey = args[3] as string;
        const current = mocks.store.get(key);
        if (
          !current ||
          current.finalizedAt !== undefined ||
          current.status === 'completed' ||
          current.status === 'error'
        ) {
          return null;
        }
        const updates = JSON.parse(args[4] as string);
        const removals = JSON.parse(args[5] as string) as string[];
        const terminal = { ...current, ...updates };
        for (const field of removals) delete terminal[field];
        const journal = {
          ...JSON.parse(args[7] as string),
          terminalStatus: terminal,
        };
        mocks.store.set(key, terminal);
        mocks.store.set(journalKey, journal);
        return JSON.stringify({ status: terminal, journal });
      }

      mocks.locked = false;
      return 1;
    }),
  },
}));

vi.mock('@/server/session/redis', () => ({
  getPublisher: vi.fn(() => mocks.publisher),
  getRedis: vi.fn(() => mocks.redis),
  jsonGet: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
}));

vi.mock('@/utils/logger', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

describe('terminal job state', () => {
  const journal = (
    jobId: string,
    outcome: 'completed' | 'error',
    finalizedAt = 3,
  ) => ({
    version: 1 as const,
    state: 'pending' as const,
    jobId,
    finalizationId: `${jobId}-${outcome}`,
    outcome,
    userId: 'testuser',
    finalizedAt,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.locked = false;
    mocks.jsonSetWithExpiry.mockImplementation(
      async (key: string, value: any) => {
        mocks.store.set(key, value);
      },
    );
  });

  it('allows only the first concurrent terminal outcome', async () => {
    const statusKey = 'daedalus:async-job-status:job-1';
    mocks.store.set(statusKey, {
      jobId: 'job-1',
      status: 'streaming',
      partialResponse: 'partial',
      createdAt: 1,
      updatedAt: 2,
    });

    const [successClaimed, cancelClaimed] = await Promise.all([
      claimTerminalJobStatus(
        'job-1',
        {
          status: 'completed',
          fullResponse: 'done',
          updatedAt: 3,
          finalizedAt: 3,
        },
        journal('job-1', 'completed'),
      ),
      claimTerminalJobStatus(
        'job-1',
        {
          status: 'error',
          error: 'Job canceled by user',
          updatedAt: 4,
          finalizedAt: 4,
        },
        journal('job-1', 'error', 4),
      ),
    ]);

    expect([successClaimed, cancelClaimed].filter(Boolean)).toHaveLength(1);
    const stored = mocks.store.get(statusKey);
    expect(stored.finalizedAt).toBeDefined();
    expect(['completed', 'error']).toContain(stored.status);
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
    expect(
      mocks.redis.eval.mock.calls.filter(([script]) =>
        String(script).includes('CLAIM_TERMINAL_FINALIZATION'),
      ),
    ).toHaveLength(2);
    expect(mocks.publisher.publish).not.toHaveBeenCalled();
    expect(mocks.store.get('daedalus:async-job-finalization:job-1')).toEqual(
      expect.objectContaining({
        jobId: 'job-1',
        outcome: stored.status,
        terminalStatus: stored,
      }),
    );
  });

  it('rejects terminal writes through the nonterminal update helper', async () => {
    await expect(
      updateJobStatus('job-1', {
        status: 'error',
        finalizedAt: 3,
      }),
    ).rejects.toThrow('must use claimTerminalJobStatus');
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });

  it('removes undefined transient fields inside the atomic transition', async () => {
    const statusKey = 'daedalus:async-job-status:job-cleanup';
    mocks.store.set(statusKey, {
      jobId: 'job-cleanup',
      status: 'oauth_required',
      authUrl: 'https://identity.example/authorize',
      oauthState: 'state-1',
      error: 'transient',
      createdAt: 1,
      updatedAt: 2,
    });

    await expect(
      claimTerminalJobStatus(
        'job-cleanup',
        {
          status: 'completed',
          fullResponse: 'done',
          authUrl: undefined,
          oauthState: undefined,
          error: undefined,
          updatedAt: 3,
          finalizedAt: 3,
        },
        journal('job-cleanup', 'completed'),
      ),
    ).resolves.toBe(true);

    expect(mocks.store.get(statusKey)).toEqual({
      jobId: 'job-cleanup',
      status: 'completed',
      fullResponse: 'done',
      createdAt: 1,
      updatedAt: 3,
      finalizedAt: 3,
    });
  });

  it('does not create terminal state for a missing job', async () => {
    await expect(
      claimTerminalJobStatus(
        'missing',
        {
          status: 'error',
          error: 'missing',
          updatedAt: 3,
          finalizedAt: 3,
        },
        journal('missing', 'error'),
      ),
    ).resolves.toBe(false);
    expect(mocks.jsonSetWithExpiry).not.toHaveBeenCalled();
  });
});
