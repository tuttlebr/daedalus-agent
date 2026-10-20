import {
  StreamWorkerRuntime,
  streamWorkerOptionsFromEnv,
  processStreamQueueEntry,
  type StreamWorkerOptions,
} from '@/server/chat/streamWorker';
import { ApiRouteError } from '@/server/chat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, any>(),
  acquireStreamLeaseSnapshot: vi.fn(),
  // These knobs model parts of the snapshot script: whether the lease is
  // free, whether start evidence exists, and the stored model payload.
  acquireStreamLease: vi.fn(),
  acknowledgeStreamQueueEntry: vi.fn(),
  acknowledgeDuplicateStreamEntry: vi.fn(),
  claimStaleStreamJobs: vi.fn(),
  readNewStreamJobs: vi.fn(),
  readClient: { status: 'ready', disconnect: vi.fn() },
  hasBackendRequestStarted: vi.fn(),
  loadStreamQueuePayload: vi.fn(),
  markBackendRequestStarted: vi.fn(),
  releaseStreamLease: vi.fn(),
  renewStreamLease: vi.fn(),
  selectStreamBackendBaseUrl: vi.fn(),
  startBackgroundDocumentIngest: vi.fn(),
  startBackgroundStreamReader: vi.fn(),
  releaseConversationJobGuard: vi.fn(),
  releaseUserJobGuard: vi.fn(),
  finalizeError: vi.fn(),
  resumePendingFinalization: vi.fn(),
  processDueMemoryRetentions: vi.fn(),
}));

vi.mock('@/server/chat/userJobGuard', () => ({
  userJobGuardKey: (userId: string) => `user-guard:${userId}`,
  releaseUserJobGuard: mocks.releaseUserJobGuard,
}));

vi.mock('@/server/chat/conversationJobGuard', () => ({
  conversationJobGuardKey: (userId: string, conversationId: string) =>
    `guard:${userId}:${conversationId}`,
  releaseConversationJobGuard: mocks.releaseConversationJobGuard,
}));

vi.mock('@/server/chat/streamQueue', () => ({
  acknowledgeDuplicateStreamEntry: mocks.acknowledgeDuplicateStreamEntry,
  acknowledgeStreamQueueEntry: mocks.acknowledgeStreamQueueEntry,
  acquireStreamLeaseSnapshot: mocks.acquireStreamLeaseSnapshot,
  claimStaleStreamJobs: mocks.claimStaleStreamJobs,
  ensureStreamConsumerGroup: vi.fn(),
  markBackendRequestStarted: mocks.markBackendRequestStarted,
  readNewStreamJobs: mocks.readNewStreamJobs,
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
  getRedis: vi.fn(() => ({ duplicate: () => mocks.readClient })),
  jsonGet: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
  jsonSetWithExpiry: vi.fn(async (key: string, value: any) => {
    mocks.store.set(key, value);
  }),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
  streamingStateKey: (userId: string, conversationId: string) =>
    `daedalus:streaming:user:${userId}:conversation:${conversationId}`,
}));

vi.mock('@/server/chat/memoryRetention', () => ({
  processDueMemoryRetentions: mocks.processDueMemoryRetentions,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const stubbed = {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return { ...stubbed, default: stubbed };
});

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
    // Mirrors ACQUIRE_STREAM_LEASE_SNAPSHOT: lease first, then the records;
    // a terminal job reads nothing more, and only a job with no start
    // evidence or stop signal reads its payload.
    mocks.acquireStreamLeaseSnapshot.mockImplementation(
      async (jobId: string) => {
        if (!(await mocks.acquireStreamLease(jobId))) return null;
        const status = mocks.store.get(`daedalus:async-job-status:${jobId}`);
        if (!status)
          return {
            status: null,
            request: null,
            payload: null,
            started: false,
            canceled: false,
          };
        if (
          status.finalizedAt !== undefined ||
          ['completed', 'error'].includes(status.status)
        )
          return {
            status,
            request: null,
            payload: null,
            started: false,
            canceled: false,
          };
        const request =
          mocks.store.get(`daedalus:async-job-request:${jobId}`) ?? null;
        const started = Boolean(await mocks.hasBackendRequestStarted(jobId));
        const canceled = mocks.store.has(`daedalus:async-job-abort:${jobId}`);
        return {
          status,
          request,
          payload:
            request && !started && !canceled
              ? await mocks.loadStreamQueuePayload(jobId)
              : null,
          started,
          canceled,
        };
      },
    );
    mocks.acquireStreamLease.mockResolvedValue(true);
    mocks.acknowledgeStreamQueueEntry.mockResolvedValue(undefined);
    mocks.acknowledgeDuplicateStreamEntry.mockResolvedValue(undefined);
    mocks.hasBackendRequestStarted.mockResolvedValue(false);
    mocks.loadStreamQueuePayload.mockResolvedValue({
      messagesForNat: [{ role: 'user', content: 'trusted message' }],
      verifiedUsername: 'testuser',
    });
    // Mirrors the Redis script: a recorded stop wins over the start marker.
    mocks.markBackendRequestStarted.mockImplementation(async (jobId: string) =>
      mocks.store.has(`daedalus:async-job-abort:${jobId}`)
        ? 'canceled'
        : 'started',
    );
    mocks.releaseStreamLease.mockResolvedValue(true);
    mocks.releaseConversationJobGuard.mockResolvedValue(true);
    mocks.releaseUserJobGuard.mockResolvedValue(undefined);
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
    mocks.processDueMemoryRetentions.mockResolvedValue(undefined);
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
    vi.unstubAllEnvs();
  });

  it('keeps execution capacity and lease duration positive for sub-unit environment values', () => {
    vi.stubEnv('STREAM_WORKER_CONCURRENCY', '0.5');
    vi.stubEnv('STREAM_WORKER_LEASE_TTL_SECONDS', '0.5');
    const configured = streamWorkerOptionsFromEnv();
    expect(configured.concurrency).toBe(5);
    expect(configured.leaseTtlMs).toBe(30000);
  });

  it('continues memory retention polling while every execution slot is occupied', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const streamFinished = new Promise<void>((resolve) => (finish = resolve));
    mocks.startBackgroundStreamReader.mockImplementationOnce(async () => {
      await streamFinished;
      mocks.store.set('daedalus:async-job-status:job-1', {
        jobId: 'job-1',
        status: 'completed',
        finalizedAt: 2,
      });
    });
    mocks.claimStaleStreamJobs.mockResolvedValue({
      entries: [],
      nextCursor: '0-0',
    });
    mocks.readNewStreamJobs.mockResolvedValue([entry]);
    const runtime = new StreamWorkerRuntime({ ...options, concurrency: 1 });
    const running = runtime.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.startBackgroundStreamReader).toHaveBeenCalledOnce();
      expect(mocks.processDueMemoryRetentions).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(mocks.processDueMemoryRetentions).toHaveBeenCalledTimes(4);
      // Retention must not create additional chat capacity or queue reads.
      expect(mocks.readNewStreamJobs).toHaveBeenCalledOnce();
      let finishPoll!: () => void;
      mocks.processDueMemoryRetentions.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishPoll = resolve)),
      );
      await vi.advanceTimersByTimeAsync(4_000);
      // A slow retention batch must not overlap the following timer ticks.
      expect(mocks.processDueMemoryRetentions).toHaveBeenCalledTimes(5);
      finishPoll();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.processDueMemoryRetentions).toHaveBeenCalledTimes(6);
    } finally {
      const draining = runtime.beginDrain();
      finish();
      await draining;
      await running;
    }
    const polls = mocks.processDueMemoryRetentions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.processDueMemoryRetentions).toHaveBeenCalledTimes(polls);
  });

  it('leaves entries pending when a blocked queue read returns after shutdown starts', async () => {
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let deliver!: () => void;
    const readFinished = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    mocks.claimStaleStreamJobs.mockResolvedValue({
      entries: [],
      nextCursor: '0-0',
    });
    mocks.readNewStreamJobs.mockImplementation(async () => {
      reading();
      await readFinished;
      return [entry];
    });
    const runtime = new StreamWorkerRuntime(options);
    const running = runtime.run();
    await readStarted;
    await runtime.beginDrain();
    deliver();
    await running;
    expect(mocks.acquireStreamLease).not.toHaveBeenCalled();
    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
  });

  it.each(['1-0', '2-0'])(
    'retains the active entry while handling reclaimed entry %s',
    async (reclaimedId) => {
      let started!: () => void;
      const executionStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      const executionFinished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let observed!: () => void;
      const reclaimDispatched = new Promise<void>((resolve) => {
        observed = resolve;
      });
      let stopReading!: () => void;
      const readFinished = new Promise<void>((resolve) => {
        stopReading = resolve;
      });
      mocks.startBackgroundStreamReader.mockImplementation(async () => {
        started();
        await executionFinished;
        mocks.store.set('daedalus:async-job-status:job-1', {
          status: 'completed',
          finalizedAt: 2,
        });
      });
      const reclaimed = { ...entry, entryId: reclaimedId, reclaimed: true };
      mocks.claimStaleStreamJobs
        .mockResolvedValueOnce({ entries: [], nextCursor: '1-0' })
        .mockImplementationOnce(async () => {
          await executionStarted;
          return { entries: [reclaimed], nextCursor: '0-0' };
        })
        .mockResolvedValue({ entries: [], nextCursor: '0-0' });
      mocks.readNewStreamJobs
        .mockResolvedValueOnce([entry])
        .mockImplementation(async () => {
          observed();
          await readFinished;
          return [];
        });
      const runtime = new StreamWorkerRuntime({
        ...options,
        reclaimScanMs: 0,
        drainTimeoutMs: 100,
      });
      const running = runtime.run();
      try {
        await reclaimDispatched;
        expect(mocks.claimStaleStreamJobs).toHaveBeenNthCalledWith(
          2,
          mocks.readClient,
          expect.any(String),
          options.reclaimIdleMs,
          1,
          '1-0',
        );
        expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
        if (reclaimedId === entry.entryId) {
          expect(mocks.acknowledgeDuplicateStreamEntry).not.toHaveBeenCalled();
        } else {
          expect(mocks.acknowledgeDuplicateStreamEntry).toHaveBeenCalledWith(
            reclaimed,
          );
        }
      } finally {
        finish();
        const draining = runtime.beginDrain();
        stopReading();
        await Promise.all([running, draining]);
      }
      expect(mocks.startBackgroundStreamReader).toHaveBeenCalledTimes(1);
      expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
    },
  );

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

  it('passes the stream reader only cancellation and the start fence', async () => {
    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-control'),
    ).resolves.toBe('completed');

    expect(mocks.startBackgroundStreamReader).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      [{ role: 'user', content: 'trusted message' }],
      'testuser',
      {
        signal: expect.any(AbortSignal),
        beforeBackendRequest: expect.any(Function),
      },
    );
  });

  it('finalizes a job the reader left awaiting OAuth instead of parking it', async () => {
    mocks.startBackgroundStreamReader.mockImplementation(
      async (jobId: string, ...args: any[]) => {
        await args[3].beforeBackendRequest();
        const key = `daedalus:async-job-status:${jobId}`;
        mocks.store.set(key, {
          ...mocks.store.get(key),
          status: 'oauth_required',
          authUrl: 'https://example.test/oauth',
        });
      },
    );

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-oauth'),
    ).resolves.toBe('recovered_as_error');

    // Finalization releases the slots; the worker never acknowledges a live
    // job, which would leave it with no owner to reach a terminal state.
    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.anything(),
      'The backend stream ended without producing a terminal result.',
    );
    expect(mocks.releaseUserJobGuard).not.toHaveBeenCalled();
    expect(mocks.releaseConversationJobGuard).not.toHaveBeenCalled();
    expect(mocks.finalizeError.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acknowledgeStreamQueueEntry.mock.invocationCallOrder[0],
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

  it.each([false, true])(
    'does not replay a started request (reclaimed=%s)',
    async (isReclaimed) => {
      mocks.hasBackendRequestStarted.mockResolvedValue(true);
      const reclaimed = { ...entry, reclaimed: isReclaimed };

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
    },
  );

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

    await expect(promise).resolves.toBe('recovered_as_error');
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      'Job canceled by user',
    );
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

  function blockUntilAbortOrRelease() {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    mocks.startBackgroundStreamReader.mockImplementation(
      async (jobId: string, ...args: any[]) => {
        const control = args[3];
        signal = control.signal;
        await control.beforeBackendRequest();
        await Promise.race([
          released,
          new Promise<void>((resolve) =>
            control.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (control.signal.aborted) throw control.signal.reason;
        const key = `daedalus:async-job-status:${jobId}`;
        mocks.store.set(key, {
          ...mocks.store.get(key),
          status: 'completed',
          finalizedAt: 2,
        });
      },
    );
    return { release, aborted: () => Boolean(signal?.aborted) };
  }

  it('keeps executing when a heartbeat fails transiently inside the lease window', async () => {
    vi.useFakeTimers();
    const reader = blockUntilAbortOrRelease();
    mocks.renewStreamLease
      .mockRejectedValueOnce(new Error('Command timed out'))
      .mockResolvedValue(true);

    const promise = processStreamQueueEntry(
      entry,
      { ...options, leaseTtlMs: 30_000, heartbeatMs: 10 },
      undefined,
      'owner-transient',
    );
    await vi.advanceTimersByTimeAsync(25);
    // A failed renewal is not lease loss: Redis still holds this owner's
    // lease until its TTL, so the started backend run must not be dropped.
    expect(mocks.renewStreamLease.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The heartbeat also keeps cross-device streaming state for long runs.
    expect(mocks.renewStreamLease.mock.calls[0][6]).toBe(
      'daedalus:streaming:user:testuser:conversation:conv-1',
    );
    expect(reader.aborted()).toBe(false);
    reader.release();

    await expect(promise).resolves.toBe('completed');
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
    expect(mocks.finalizeError).not.toHaveBeenCalled();
  });

  it('aborts only after the lease validity window passes without a renewal', async () => {
    vi.useFakeTimers();
    const reader = blockUntilAbortOrRelease();
    mocks.renewStreamLease.mockRejectedValue(new Error('Connection is closed'));

    const promise = processStreamQueueEntry(
      entry,
      { ...options, leaseTtlMs: 100, heartbeatMs: 10 },
      undefined,
      'owner-expiring',
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(reader.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(reader.aborted()).toBe(true);

    await expect(promise).resolves.toBe('interrupted');
    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
    expect(mocks.finalizeError).not.toHaveBeenCalled();
  });

  it('records a user stop when its ownership check fails transiently inside the lease window', async () => {
    vi.useFakeTimers();
    blockUntilAbortOrRelease();
    mocks.renewStreamLease.mockRejectedValue(new Error('Command timed out'));

    const promise = processStreamQueueEntry(
      entry,
      { ...options, cancellationPollMs: 10, heartbeatMs: 60_000 },
      undefined,
      'owner-stop-transient',
    );
    await vi.advanceTimersByTimeAsync(1);
    mocks.store.set('daedalus:async-job-abort:job-1', true);
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toBe('recovered_as_error');
    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      'Job canceled by user',
    );
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
  });

  // A reader stand-in that records whether it would have sent the backend
  // request, which happens only after beforeBackendRequest resolves.
  function recordBackendRequests(): { sent: () => boolean } {
    let sent = false;
    mocks.startBackgroundStreamReader.mockImplementation(
      async (jobId: string, ...args: any[]) => {
        await args[3].beforeBackendRequest();
        sent = true;
        const key = `daedalus:async-job-status:${jobId}`;
        mocks.store.set(key, {
          ...mocks.store.get(key),
          status: 'completed',
          finalizedAt: 2,
        });
      },
    );
    return { sent: () => sent };
  }

  it('does not start the backend after a durable Stop recorded during reclaim preparation', async () => {
    const backend = recordBackendRequests();
    mocks.selectStreamBackendBaseUrl.mockImplementation(async () => {
      // DELETE /api/chat/async lands while reclaim re-probes backends.
      mocks.store.set('daedalus:async-job-abort:job-1', true);
      return 'http://backend-new:8000';
    });
    const reclaimed = { ...entry, reclaimed: true };

    await expect(
      processStreamQueueEntry(reclaimed, options, undefined, 'owner-x'),
    ).resolves.toBe('recovered_as_error');

    expect(backend.sent()).toBe(false);
    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      'Job canceled by user',
    );
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(reclaimed);
  });

  it('never sends the backend request when the start marker finds the lease lost', async () => {
    const backend = recordBackendRequests();
    mocks.markBackendRequestStarted.mockResolvedValue('lease_lost');

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-late'),
    ).resolves.toBe('interrupted');

    expect(backend.sent()).toBe(false);
    expect(mocks.finalizeError).not.toHaveBeenCalled();
    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
    expect(mocks.releaseStreamLease).toHaveBeenCalledWith(
      'job-1',
      'owner-late',
    );
  });

  it('fails and acknowledges a stream job whose queue payload expired', async () => {
    mocks.loadStreamQueuePayload.mockResolvedValue(null);

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-expired'),
    ).resolves.toBe('missing');

    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      'The durable stream payload expired before a worker could process it.',
    );
    expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
  });

  it.each([
    ['status', 'daedalus:async-job-status:job-1'],
    ['request', 'daedalus:async-job-request:job-1'],
  ])(
    'acknowledges an entry whose %s no longer exists without running it',
    async (_record, key) => {
      mocks.store.delete(key);

      await expect(
        processStreamQueueEntry(entry, options, undefined, 'owner-missing'),
      ).resolves.toBe('missing');

      expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
      expect(mocks.finalizeError).not.toHaveBeenCalled();
      expect(mocks.acknowledgeStreamQueueEntry).toHaveBeenCalledWith(entry);
      // Entries written before owner fields existed cannot release anything.
      expect(mocks.releaseUserJobGuard).not.toHaveBeenCalled();
      expect(mocks.releaseConversationJobGuard).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['status', 'daedalus:async-job-status:job-1'],
    ['request', 'daedalus:async-job-request:job-1'],
  ])(
    'releases the user slot and conversation guard of an owned entry whose %s expired',
    async (_record, key) => {
      mocks.store.delete(key);
      const owned = { ...entry, userId: 'testuser', conversationId: 'conv-1' };
      const order: string[] = [];
      mocks.releaseUserJobGuard.mockImplementation(async () => {
        order.push('release');
      });
      mocks.acknowledgeStreamQueueEntry.mockImplementation(async () => {
        order.push('ack');
      });

      await expect(
        processStreamQueueEntry(owned, options, undefined, 'owner-missing'),
      ).resolves.toBe('missing');

      expect(mocks.releaseUserJobGuard).toHaveBeenCalledWith(
        'testuser',
        'job-1',
      );
      expect(mocks.releaseConversationJobGuard).toHaveBeenCalledWith(
        'testuser',
        'conv-1',
        'job-1',
      );
      // A failed release leaves the entry pending for the next worker.
      expect(order).toEqual(['release', 'ack']);
      expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
      expect(mocks.finalizeError).not.toHaveBeenCalled();
    },
  );

  it('does not acknowledge a record-less owned entry when releasing its slot fails', async () => {
    mocks.store.delete('daedalus:async-job-status:job-1');
    mocks.store.delete('daedalus:async-job-request:job-1');
    mocks.releaseUserJobGuard.mockRejectedValue(new Error('Redis down'));

    await expect(
      processStreamQueueEntry(
        { ...entry, userId: 'testuser' },
        options,
        undefined,
        'owner-missing',
      ),
    ).rejects.toThrow('Redis down');

    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
  });

  it.each([
    ['a later phase', { phase: 'indexing', completed: 0, percent: 0 }],
    ['completed documents', { phase: 'queued', completed: 1, percent: 0 }],
    ['a percentage', { phase: 'queued', completed: 0, percent: 50 }],
  ])(
    'treats reported ingest progress (%s) as start evidence when the marker was evicted',
    async (_label, progress) => {
      const request = mocks.store.get('daedalus:async-job-request:job-1');
      mocks.store.set('daedalus:async-job-request:job-1', {
        ...request,
        executionMode: 'document_ingest',
      });
      // Ingestion is queued as `streaming`; only the marker or progress the
      // backend reported can prove the previous owner sent the request.
      mocks.store.set('daedalus:async-job-status:job-1', {
        jobId: 'job-1',
        status: 'streaming',
        ingestProgress: { total: 2, ...progress },
        createdAt: 1,
        updatedAt: 1,
      });
      mocks.hasBackendRequestStarted.mockResolvedValue(false);
      const reclaimed = { ...entry, reclaimed: true };

      await expect(
        processStreamQueueEntry(reclaimed, options, undefined, 'owner-evicted'),
      ).resolves.toBe('recovered_as_error');

      expect(mocks.startBackgroundDocumentIngest).not.toHaveBeenCalled();
      expect(mocks.finalizeError).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ executionMode: 'document_ingest' }),
        expect.stringContaining('not replayed'),
      );
    },
  );

  it('still runs a reclaimed ingestion whose status only shows the queued placeholder', async () => {
    const request = mocks.store.get('daedalus:async-job-request:job-1');
    mocks.store.set('daedalus:async-job-request:job-1', {
      ...request,
      executionMode: 'document_ingest',
    });
    mocks.store.set('daedalus:async-job-status:job-1', {
      jobId: 'job-1',
      status: 'streaming',
      ingestProgress: { total: 2, phase: 'queued', completed: 0, percent: 0 },
      createdAt: 1,
      updatedAt: 1,
    });
    mocks.startBackgroundDocumentIngest.mockImplementation(
      async (jobId: string) => {
        const key = `daedalus:async-job-status:${jobId}`;
        mocks.store.set(key, {
          ...mocks.store.get(key),
          status: 'completed',
          finalizedAt: 2,
        });
      },
    );

    await expect(
      processStreamQueueEntry(
        { ...entry, reclaimed: true },
        options,
        undefined,
        'owner-queued',
      ),
    ).resolves.toBe('completed');

    expect(mocks.startBackgroundDocumentIngest).toHaveBeenCalled();
  });

  it('fences document ingestion with the backend start marker', async () => {
    const request = mocks.store.get('daedalus:async-job-request:job-1');
    mocks.store.set('daedalus:async-job-request:job-1', {
      ...request,
      executionMode: 'document_ingest',
    });
    // Ingestion is queued as streaming and must still run when unstarted.
    mocks.store.set('daedalus:async-job-status:job-1', {
      jobId: 'job-1',
      status: 'streaming',
      createdAt: 1,
      updatedAt: 1,
    });
    let sent = false;
    mocks.startBackgroundDocumentIngest.mockImplementation(
      async (jobId: string, _request: any, _user: string, control: any) => {
        await control.beforeBackendRequest();
        sent = true;
        const key = `daedalus:async-job-status:${jobId}`;
        mocks.store.set(key, {
          ...mocks.store.get(key),
          status: 'completed',
          finalizedAt: 2,
        });
      },
    );

    await expect(
      processStreamQueueEntry(entry, options, undefined, 'owner-ingest'),
    ).resolves.toBe('completed');

    expect(mocks.markBackendRequestStarted).toHaveBeenCalledWith(
      'job-1',
      'owner-ingest',
    );
    expect(sent).toBe(true);
    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
  });

  it('leaves a stopped run to reclaim when its owner cannot confirm the lease', async () => {
    vi.useFakeTimers();
    blockUntilAbortOrRelease();
    mocks.renewStreamLease.mockResolvedValue(false);

    const promise = processStreamQueueEntry(
      entry,
      { ...options, cancellationPollMs: 10, heartbeatMs: 60_000 },
      undefined,
      'owner-stop-lost',
    );
    await vi.advanceTimersByTimeAsync(1);
    mocks.store.set('daedalus:async-job-abort:job-1', true);
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toBe('interrupted');
    expect(mocks.finalizeError).not.toHaveBeenCalled();
    expect(mocks.acknowledgeStreamQueueEntry).not.toHaveBeenCalled();
  });

  it('records a reclaimed started run that the user stopped as a cancellation', async () => {
    mocks.hasBackendRequestStarted.mockResolvedValue(true);
    mocks.store.set('daedalus:async-job-abort:job-1', true);
    const reclaimed = { ...entry, reclaimed: true };

    await expect(
      processStreamQueueEntry(
        reclaimed,
        options,
        undefined,
        'owner-after-stop',
      ),
    ).resolves.toBe('recovered_as_error');

    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      'Job canceled by user',
    );
    expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
  });

  it.each(['streaming', 'oauth_required'])(
    'does not replay a stream job whose %s status proves it started after the marker was evicted',
    async (state) => {
      mocks.store.set('daedalus:async-job-status:job-1', {
        jobId: 'job-1',
        status: state,
        createdAt: 1,
        updatedAt: 1,
      });
      const reclaimed = { ...entry, reclaimed: true };

      await expect(
        processStreamQueueEntry(reclaimed, options, undefined, 'owner-evicted'),
      ).resolves.toBe('recovered_as_error');

      expect(mocks.startBackgroundStreamReader).not.toHaveBeenCalled();
      expect(mocks.selectStreamBackendBaseUrl).not.toHaveBeenCalled();
      expect(mocks.finalizeError).toHaveBeenCalledWith(
        'job-1',
        expect.any(Object),
        expect.stringContaining('was not replayed'),
      );
    },
  );

  it('saves a fixed message instead of internal failure details', async () => {
    mocks.selectStreamBackendBaseUrl.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.42.0.17:6379'),
    );
    const reclaimed = { ...entry, reclaimed: true };

    await expect(
      processStreamQueueEntry(reclaimed, options, undefined, 'owner-redis'),
    ).resolves.toBe('recovered_as_error');

    const message = mocks.finalizeError.mock.calls[0][2];
    expect(message).toBe(
      'The response could not be processed because of an internal error. Please try again.',
    );
    expect(message).not.toContain('10.42.0.17');
  });

  it('keeps the public message of a user-facing route error', async () => {
    mocks.selectStreamBackendBaseUrl.mockRejectedValue(
      new ApiRouteError(
        502,
        'The assistant backend is temporarily unavailable. Please try again shortly.',
        'backend_unavailable',
      ),
    );

    await processStreamQueueEntry(
      { ...entry, reclaimed: true },
      options,
      undefined,
      'owner-unavailable',
    );

    expect(mocks.finalizeError).toHaveBeenCalledWith(
      'job-1',
      expect.any(Object),
      'The assistant backend is temporarily unavailable. Please try again shortly.',
    );
  });
});
