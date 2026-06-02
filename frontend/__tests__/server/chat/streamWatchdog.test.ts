import { sweepStreamJobs } from '@/server/chat/streamWatchdog';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  jsonGet: vi.fn(),
  smembers: vi.fn(),
  srem: vi.fn(),
  finalizeError: vi.fn(),
  withRedisLock: vi.fn(),
  isTerminalJobStatus: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: mocks.getRedis,
  jsonGet: mocks.jsonGet,
  sessionKey: (parts: Array<string | undefined | null>) =>
    parts.filter(Boolean).join(':'),
}));

vi.mock('@/server/chat/finalization', () => ({
  finalizeError: mocks.finalizeError,
}));

vi.mock('@/server/chat/jobState', () => ({
  finalizerLockKey: (jobId: string) => `async-job-finalizer-lock:${jobId}`,
  isTerminalJobStatus: mocks.isTerminalJobStatus,
  withRedisLock: mocks.withRedisLock,
}));

const STALE_MS = 15 * 60 * 1000 + 1000; // just past STREAM_JOB_STALE_TIMEOUT_MS

describe('streamWatchdog.sweepStreamJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedis.mockReturnValue({
      smembers: mocks.smembers,
      srem: mocks.srem,
    });
    mocks.isTerminalJobStatus.mockImplementation(
      (s: string) => s === 'completed' || s === 'error',
    );
    mocks.withRedisLock.mockImplementation(
      async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
    );
  });

  it('finalizes a stale, non-terminal stream job and drops it from the index', async () => {
    mocks.smembers.mockResolvedValue(['job-stale']);
    const status = {
      jobId: 'job-stale',
      status: 'streaming',
      createdAt: 0,
      updatedAt: Date.now() - STALE_MS,
    };
    const request = {
      jobId: 'job-stale',
      userId: 'u',
      executionMode: 'stream',
    };
    mocks.jsonGet
      .mockResolvedValueOnce(status) // initial status read
      .mockResolvedValueOnce(request) // request read
      .mockResolvedValueOnce(status); // re-check inside the lock

    await sweepStreamJobs();

    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-stale',
      request,
      expect.any(String),
    );
    expect(mocks.srem).toHaveBeenCalledWith('async-stream-jobs', 'job-stale');
  });

  it('drops an already finalized/terminal job without finalizing again', async () => {
    mocks.smembers.mockResolvedValue(['job-done']);
    mocks.jsonGet.mockResolvedValueOnce({
      status: 'completed',
      finalizedAt: 123,
      updatedAt: 0,
    });

    await sweepStreamJobs();

    expect(mocks.finalizeError).not.toHaveBeenCalled();
    expect(mocks.srem).toHaveBeenCalledWith('async-stream-jobs', 'job-done');
  });

  it('leaves a recently-updated job alone', async () => {
    mocks.smembers.mockResolvedValue(['job-fresh']);
    mocks.jsonGet.mockResolvedValueOnce({
      status: 'streaming',
      updatedAt: Date.now(),
    });

    await sweepStreamJobs();

    expect(mocks.finalizeError).not.toHaveBeenCalled();
    expect(mocks.srem).not.toHaveBeenCalled();
  });

  it('drops a stale job whose request record is missing', async () => {
    mocks.smembers.mockResolvedValue(['job-orphan']);
    mocks.jsonGet
      .mockResolvedValueOnce({
        status: 'streaming',
        updatedAt: Date.now() - STALE_MS,
      })
      .mockResolvedValueOnce(null);

    await sweepStreamJobs();

    expect(mocks.finalizeError).not.toHaveBeenCalled();
    expect(mocks.srem).toHaveBeenCalledWith('async-stream-jobs', 'job-orphan');
  });
});
