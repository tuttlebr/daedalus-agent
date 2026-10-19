import {
  STREAM_QUEUE_GROUP,
  STREAM_QUEUE_KEY,
  acquireStreamLeaseSnapshot,
  claimStaleStreamJobs,
  enqueueStreamJob,
  ensureStreamConsumerGroup,
  getStreamJobPresence,
  markBackendRequestStarted,
  readNewStreamJobs,
  releaseStreamLease,
  renewStreamLease,
  streamPayloadKey,
} from '@/server/chat/streamQueue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: {
    xgroup: vi.fn(),
    xadd: vi.fn(),
    xreadgroup: vi.fn(),
    xautoclaim: vi.fn(),
    set: vi.fn(),
    eval: vi.fn(),
    // An empty script cache: every digest call falls back to EVAL.
    evalsha: vi.fn(),
    exists: vi.fn(),
  },
}));

vi.mock('@/server/session/redis', () => ({
  STREAMING_STATE_TTL_SECONDS: 600,
  getRedis: vi.fn(() => mocks.redis),
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
}));

describe('durable stream queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.xgroup.mockResolvedValue('OK');
    mocks.redis.xadd.mockResolvedValue('1-0');
    mocks.redis.set.mockResolvedValue('OK');
    mocks.redis.eval.mockResolvedValue(1);
    mocks.redis.evalsha.mockRejectedValue(
      new Error('NOSCRIPT No matching script. Please use EVAL.'),
    );
    mocks.redis.exists.mockResolvedValue(0);
  });

  it('stores the payload and its stream entry in one commit', async () => {
    const payload = {
      messagesForNat: [{ role: 'user', content: 'hello' }],
      verifiedUsername: 'testuser',
    };
    mocks.redis.eval.mockResolvedValueOnce('1-0');

    await expect(
      enqueueStreamJob('job-1', payload, {
        submissionKey: 'daedalus:job-submission:chat:testuser:sub-1',
        notice: { channel: 'user:testuser:updates', payload: '{}' },
      }),
    ).resolves.toBe('1-0');

    expect(mocks.redis.eval).toHaveBeenCalledOnce();
    expect(mocks.redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('ENQUEUE_STREAM_JOB'),
      4,
      streamPayloadKey('job-1'),
      STREAM_QUEUE_KEY,
      'daedalus:async-job-abort:job-1',
      'daedalus:job-submission:chat:testuser:sub-1',
      JSON.stringify(payload),
      3600,
      'job-1',
      'user:testuser:updates',
      '{}',
    );
    expect(mocks.redis.xadd).not.toHaveBeenCalled();
  });

  it('creates the consumer group idempotently', async () => {
    await ensureStreamConsumerGroup(mocks.redis as any);
    mocks.redis.xgroup.mockRejectedValueOnce(new Error('BUSYGROUP exists'));
    await expect(
      ensureStreamConsumerGroup(mocks.redis as any),
    ).resolves.toBeUndefined();

    expect(mocks.redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      STREAM_QUEUE_KEY,
      STREAM_QUEUE_GROUP,
      '0',
      'MKSTREAM',
    );
  });

  it('reports a failed enqueue to the submitting route', async () => {
    mocks.redis.eval.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(
      enqueueStreamJob('job-failed', {
        messagesForNat: [],
        verifiedUsername: 'testuser',
      }),
    ).rejects.toThrow('Redis unavailable');
  });

  it('parses new and reclaimed Redis Stream entries', async () => {
    mocks.redis.xreadgroup.mockResolvedValue([
      [STREAM_QUEUE_KEY, [['2-0', ['jobId', 'job-new']]]],
    ]);
    mocks.redis.xautoclaim.mockResolvedValue([
      '0-0',
      [['1-0', ['jobId', 'job-stale']]],
      [],
    ]);

    await expect(
      readNewStreamJobs(mocks.redis as any, 'consumer-1', 2, 1000),
    ).resolves.toEqual([
      { entryId: '2-0', jobId: 'job-new', reclaimed: false },
    ]);
    await expect(
      claimStaleStreamJobs(mocks.redis as any, 'consumer-1', 45000, 2),
    ).resolves.toEqual({
      entries: [{ entryId: '1-0', jobId: 'job-stale', reclaimed: true }],
      nextCursor: '0-0',
    });
  });

  it('returns and resumes an empty reclaim page without restarting its scan', async () => {
    mocks.redis.xautoclaim.mockResolvedValueOnce(['11-0', [], []]);
    const page = await claimStaleStreamJobs(
      mocks.redis as any,
      'worker',
      45000,
      1,
    );
    expect(page).toEqual({ entries: [], nextCursor: '11-0' });
    mocks.redis.xautoclaim.mockResolvedValueOnce([
      '0-0',
      [['12-0', ['jobId', 'abandoned']]],
      [],
    ]);
    const next = await claimStaleStreamJobs(
      mocks.redis as any,
      'worker',
      45000,
      1,
      page.nextCursor,
    );
    expect(next.entries).toEqual([
      { entryId: '12-0', jobId: 'abandoned', reclaimed: true },
    ]);
    expect(mocks.redis.xautoclaim).toHaveBeenLastCalledWith(
      STREAM_QUEUE_KEY,
      STREAM_QUEUE_GROUP,
      'worker',
      45000,
      '11-0',
      'COUNT',
      1,
    );
  });

  it('reads a lease snapshot, or nothing when another owner holds the lease', async () => {
    mocks.redis.eval.mockResolvedValueOnce([
      1,
      JSON.stringify({ jobId: 'job-1', status: 'pending' }),
      JSON.stringify({ jobId: 'job-1', userId: 'testuser' }),
      JSON.stringify({ messagesForNat: [], verifiedUsername: 'testuser' }),
      0,
      1,
    ]);
    await expect(
      acquireStreamLeaseSnapshot('job-1', 'owner-1', 30000, mocks.redis as any),
    ).resolves.toEqual({
      status: { jobId: 'job-1', status: 'pending' },
      request: { jobId: 'job-1', userId: 'testuser' },
      payload: { messagesForNat: [], verifiedUsername: 'testuser' },
      started: false,
      canceled: true,
    });
    const [script, keyCount, ...rest] = mocks.redis.eval.mock.calls[0];
    expect(script).toContain('ACQUIRE_STREAM_LEASE_SNAPSHOT');
    expect(rest.slice(0, keyCount)).toEqual([
      'daedalus:async-stream-lease:job-1',
      'daedalus:async-job-status:job-1',
      'daedalus:async-job-request:job-1',
      'daedalus:async-stream-payload:job-1',
      'daedalus:async-stream-backend-started:job-1',
      'daedalus:async-job-response:job-1',
      'daedalus:async-job-steps-v2:job-1',
      'daedalus:async-job-abort:job-1',
    ]);
    expect(rest.slice(keyCount)).toEqual(['owner-1', 30000]);

    mocks.redis.eval.mockResolvedValueOnce([0]);
    await expect(
      acquireStreamLeaseSnapshot('job-1', 'owner-2', 30000, mocks.redis as any),
    ).resolves.toBeNull();
  });

  it('uses owner-token-checked lease and start-marker scripts', async () => {
    await expect(
      renewStreamLease('job-1', 'owner-1', 30000, mocks.redis as any),
    ).resolves.toBe(true);
    await expect(
      markBackendRequestStarted('job-1', 'owner-1', mocks.redis as any),
    ).resolves.toBe('started');
    await expect(
      releaseStreamLease('job-1', 'owner-1', mocks.redis as any),
    ).resolves.toBe(true);

    expect(mocks.redis.eval).toHaveBeenCalledTimes(3);
    expect(mocks.redis.eval.mock.calls[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("redis.call('set', KEYS[2]"),
        3,
        'daedalus:async-stream-lease:job-1',
        'daedalus:async-stream-backend-started:job-1',
        'daedalus:async-job-abort:job-1',
        'owner-1',
      ]),
    );
  });

  it('renews every fixed job key and declares how many there are', async () => {
    await renewStreamLease('job-1', 'owner-1', 30000, mocks.redis as any);

    const [script, keyCount, ...rest] = mocks.redis.eval.mock.calls[0];
    expect(script).toContain('for index = 2, tonumber(ARGV[11])');
    const keys = rest.slice(0, keyCount);
    expect(keys).toEqual([
      'daedalus:async-stream-lease:job-1',
      'daedalus:async-job-request:job-1',
      'daedalus:async-job-status:job-1',
      'daedalus:async-stream-payload:job-1',
      'daedalus:async-stream-backend-started:job-1',
      'daedalus:async-job-response:job-1',
      'daedalus:async-job-steps-v2:job-1',
      'daedalus:async-job-abort:job-1',
      'daedalus:async-job-finalization:job-1',
    ]);
    expect(rest[keyCount + 10]).toBe(keys.length);
  });

  it.each([
    [1, 'started'],
    [2, 'canceled'],
    [0, 'lease_lost'],
  ])('maps start marker result %s to %s', async (scriptResult, expected) => {
    mocks.redis.eval.mockResolvedValueOnce(scriptResult);
    await expect(
      markBackendRequestStarted('job-1', 'owner-1', mocks.redis as any),
    ).resolves.toBe(expected);
  });

  it('reports which execution records a job still has', async () => {
    mocks.redis.exists.mockImplementation(async (key: string) =>
      key.includes('async-job-request') ? 1 : 0,
    );
    await expect(
      getStreamJobPresence('job-1', mocks.redis as any),
    ).resolves.toEqual({ request: true, payload: false, lease: false });
  });
});
