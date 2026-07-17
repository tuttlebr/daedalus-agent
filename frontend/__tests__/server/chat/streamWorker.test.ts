import {
  processStreamQueueEntry,
  type StreamWorkerOptions,
} from '@/server/chat/streamWorker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, any>(),
  acquireStreamLease: vi.fn(),
  acknowledgeStreamQueueEntry: vi.fn(),
  hasBackendRequestStarted: vi.fn(),
  loadStreamQueuePayload: vi.fn(),
  markBackendRequestStarted: vi.fn(),
  releaseStreamLease: vi.fn(),
  renewStreamLease: vi.fn(),
  selectStreamBackendBaseUrl: vi.fn(),
  startBackgroundDocumentIngest: vi.fn(),
  startBackgroundStreamReader: vi.fn(),
  releaseConversationJobGuard: vi.fn(),
  finalizeError: vi.fn(),
  resumePendingFinalization: vi.fn(),
}));

vi.mock('@/server/chat/conversationJobGuard', () => ({
  releaseConversationJobGuard: mocks.releaseConversationJobGuard,
}));

vi.mock('@/server/chat/streamQueue', () => ({
  acknowledgeDuplicateStreamEntry: vi.fn(),
  acknowledgeStreamQueueEntry: mocks.acknowledgeStreamQueueEntry,
  acquireStreamLease: mocks.acquireStreamLease,
  claimStaleStreamJobs: vi.fn(),
  ensureStreamConsumerGroup: vi.fn(),
  hasBackendRequestStarted: mocks.hasBackendRequestStarted,
  loadStreamQueuePayload: mocks.loadStreamQueuePayload,
  markBackendRequestStarted: mocks.markBackendRequestStarted,
  readNewStreamJobs: vi.fn(),
  releaseStreamLease: mocks.releaseStreamLease,
  renewStreamLease: mocks.renewStreamLease,
}));

vi.mock('@/server/chat/backendSelection', () => ({
  selectStreamBackendBaseUrl: mocks.selectStreamBackendBaseUrl,
}));

vi.mock('@/server/chat/documentIngest', () => ({
  startBackgroundDocumentIngest: mocks.startBackgroundDocumentIngest,
}));

vi.mock('@/server/chat/streamReader', () => ({
  startBackgroundStreamReader: mocks.startBackgroundStreamReader,
}));

vi.mock('@/server/chat/finalization', () => ({
  finalizeError: mocks.finalizeError,
  resumePendingFinalization: mocks.resumePendingFinalization,
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => ({ duplicate: vi.fn() })),
  jsonGet: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
  jsonSetWithExpiry: vi.fn(async (key: string, value: any) => {
    mocks.store.set(key, value);
  }),
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

const options: StreamWorkerOptions = {
  concurrency: 2,
  leaseTtlMs: 30000,
  heartbeatMs: 10000,
  cancellationPollMs: 1000,
  reclaimIdleMs: 45000,
  reclaimScanMs: 10000,
  readBlockMs: 1000,
  drainTimeoutMs: 45000,
  healthMaxAgeMs: 30000,
};

const entry = {
  entryId: '1-0',
  jobId: 'job-1',
  reclaimed: false,
};

function seedRunningJob(): void {
  mocks.store.set('daedalus:async-job-request:job-1', {
    jobId: 'job-1',
    executionMode: 'stream',
    natBaseUrl: 'http://backend:8000',
    natSessionId: 'session-1',
    messages: [{ role: 'user', content: 'hello' }],
    additionalProps: {},
    userId: 'testuser',
    conversationId: 'conv-1',
  });
  mocks.store.set('daedalus:async-job-status:job-1', {
    jobId: 'job-1',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  });
}

describe('durable stream worker entry processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    seedRunningJob();
    mocks.acquireStreamLease.mockResolvedValue(true);
    mocks.acknowledgeStreamQueueEntry.mockResolvedValue(undefined);
    mocks.hasBackendRequestStarted.mockResolvedValue(false);
    mocks.loadStreamQueuePayload.mockResolvedValue({
      messagesForNat: [{ role: 'user', content: 'trusted message' }],
      verifiedUsername: 'testuser',
    });
    mocks.markBackendRequestStarted.mockResolvedValue(true);
    mocks.releaseStreamLease.mockResolvedValue(true);
    mocks.releaseConversationJobGuard.mockResolvedValue(true);
    mocks.renewStreamLease.mockResolvedValue(true);
    mocks.selectStreamBackendBaseUrl.mockResolvedValue(
      'http://backend-new:8000',
    );
    mocks.finalizeError.mockImplementation(async (jobId: string) => {
      const key = `daedalus:async-job-status:${jobId}`;
      const current = mocks.store.get(key);
      mocks.store.set(key, {
        ...current,
        status: 'error',
        error: 'worker error',
        finalizedAt: 2,
      });
    });
    mocks.resumePendingFinalization.mockResolvedValue('completed');
    mocks.startBackgroundStreamReader.mockImplementation(
      async (jobId: string, ...args: any[]) => {
        await args[3].beforeBackendRequest();
        const key = `daedalus:async-job-status:${jobId}`;
        const current = mocks.store.get(key);
        mocks.store.set(key, {
          ...current,
          status: 'completed',
          fullResponse: 'done',
          finalizedAt: 2,
        });
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks backend execution under the owner lease and acknowledges one terminal result', async () => {
    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-1'),
    ).resolves.toBe('completed');

    expect(mocks.markBackendRequestStarted).toHaveBeenCalledWith(
      'job-1',
      'owner-1',
    );
    expect(mocks.startBackgroundStreamReader).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
    expect(mocks.releaseStreamLease).toHaveBeenCalledWith('job-1', 'owner-1');
  });

  it('releases the conversation guard after acknowledging an OAuth handoff', async () => {
    mocks.startBackgroundStreamReader.mockImplementation(
      async (jobId: string, ...args: any[]) => {
        await args[3].beforeBackendRequest();
        const key = `daedalus:async-job-status:${jobId}`;
        const current = mocks.store.get(key);
        mocks.store.set(key, {
          ...current,
          status: 'oauth_required',
          authUrl: 'https://example.test/oauth',
        });
      },
    );

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-oauth'),
    ).resolves.toBe('oauth_required');

    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
    expect(mocks.releaseConversationJobGuard).toHaveBeenCalledWith(
      'testuser',
      'conv-1',
      'job-1',
    );
    expect(
      mocks.acknowledgeStreamQueueEntry.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.releaseConversationJobGuard.mock.invocationCallOrder[0],
    );
  });

  it('resumes a journaled terminal job before acknowledging its queue entry', async () => {
    mocks.store.set('daedalus:async-job-status:job-1', {
      jobId: 'job-1',
      status: 'completed',
      finalizedAt: 2,
    });
    mocks.store.delete('daedalus:async-job-request:job-1');

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-resume'),
    ).resolves.toBe('completed');

    expect(mocks.resumePendingFinalization).toHaveBeenCalledWith('job-1');
    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
  });

  it('leaves the queue entry pending when terminal side effects are still owned elsewhere', async () => {
    mocks.store.set('daedalus:async-job-status:job-1', {
      jobId: 'job-1',
      status: 'error',
      finalizedAt: 2,
    });
    mocks.resumePendingFinalization.mockResolvedValue('pending');

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-pending'),
    ).resolves.toBe('finalization_pending');

    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
  });

  it('briefly waits for another finalizer before deferring queue acknowledgement', async () => {
    mocks.store.set('daedalus:async-job-status:job-1', {
      jobId: 'job-1',
      status: 'error',
      finalizedAt: 2,
    });
    mocks.resumePendingFinalization
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('completed');

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-settled'),
    ).resolves.toBe('completed');

    expect(mocks.resumePendingFinalization).toHaveBeenCalledTimes(2);
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
  });

  it('does not acknowledge a terminal job when side-effect recovery fails', async () => {
    mocks.store.set('daedalus:async-job-status:job-1', {
      jobId: 'job-1',
      status: 'completed',
      finalizedAt: 2,
    });
    mocks.resumePendingFinalization.mockRejectedValue(
      new Error('Redis write failed'),
    );

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-retry'),
    ).resolves.toBe('finalization_pending');

    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
  });

  it('fails a reclaimed started request without replaying backend effects', async () => {
    mocks.hasBackendRequestStarted.mockResolvedValue(true);
    const reclaimed = { ...entry, reclaimed: true };

    await expect(
      processStreamQueueEntry(reclaimed, options, undefined, 'owner-2'),
    ).resolves.toBe('recovered_as_error');

    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      expect.stringContaining('was not replayed'),
    );
    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(reclaimed);
  });

  it('safely reclaims a job that never began backend execution', async () => {
    const reclaimed = { ...entry, reclaimed: true };

    await expect(
      processStreamQueueEntry(reclaimed, options, undefined, 'owner-3'),
    ).resolves.toBe('completed');

    expect(mocks.selectStreamBackendBaseUrl).toHaveBeenCalledTimes(1);
    expect(mocks.startBackgroundStreamReader).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ natBaseUrl: 'http://backend-new:8000' }),
      expect.any(Array),
      'testuser',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not execute or acknowledge an entry whose lease is owned elsewhere', async () => {
    mocks.acquireStreamLease.mockResolvedValue(false);

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-other'),
    ).resolves.toBe('busy');

    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
    expect(mocks.releaseStreamLease).not.toHaveBeenCalled();
  });

  it('finalizes and acknowledges a queued job canceled before execution', async () => {
    mocks.store.set('daedalus:async-job-abort:job-1', true);

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-canceled'),
    ).resolves.toBe('completed');

    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      'Job canceled by user',
    );
    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
  });

  it('observes cross-process cancellation while backend execution is active', async () => {
    vi.useFakeTimers();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    mocks.startBackgroundStreamReader.mockImplementation(
      async (...args: any[]) => {
        const control = args[4];
        await control.beforeBackendRequest();
        markStarted?.();
        await new Promise<void>((resolve) => {
          control.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        throw control.signal.reason;
      },
    );

    const promise = processStreamQueueEntry(
      entry,
      { ...options, cancellationPollMs: 10 },
      undefined,
      'owner-canceled-active',
    );
    await started;
    mocks.store.set('daedalus:async-job-abort:job-1', true);
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toBe('interrupted');
    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
    expect(mocks.finalizeError).not.toHaveBeenCalled();
  });

  it('aborts without replay or acknowledgement when the visibility lease is lost', async () => {
    vi.useFakeTimers();
    mocks.renewStreamLease.mockResolvedValue(false);
    mocks.startBackgroundStreamReader.mockImplementation(
      async (...args: any[]) => {
        const control = args[4];
        await control.beforeBackendRequest();
        await new Promise<void>((resolve) => {
          control.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        throw control.signal.reason;
      },
    );

    const promise = processStreamQueueEntry(
      entry,
      { ...options, heartbeatMs: 10 },
      undefined,
      'owner-lost',
    );
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toBe('interrupted');
    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
    expect(mocks.finalizeError).not.toHaveBeenCalled();
  });
});
