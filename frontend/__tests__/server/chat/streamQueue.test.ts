import {
  STREAM_QUEUE_GROUP,
  STREAM_QUEUE_KEY,
  acquireStreamLease,
  claimStaleStreamJobs,
  enqueueStreamJob,
  ensureStreamConsumerGroup,
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
  },
  jsonSetWithExpiry: vi.fn(),
  jsonDel: vi.fn(),
}));

vi.mock('@/server/session/redis', () => ({
  getRedis: vi.fn(() => mocks.redis),
  jsonDel: mocks.jsonDel,
  jsonGet: vi.fn(),
  jsonSetWithExpiry: mocks.jsonSetWithExpiry,
  sessionKey: vi.fn((parts: string[]) => `daedalus:${parts.join(':')}`),
}));

describe('durable stream queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.xgroup.mockResolvedValue('OK');
    mocks.redis.xadd.mockResolvedValue('1-0');
    mocks.redis.set.mockResolvedValue('OK');
    mocks.redis.eval.mockResolvedValue(1);
    mocks.jsonSetWithExpiry.mockResolvedValue(undefined);
    mocks.jsonDel.mockResolvedValue(1);
  });

  it('stores the execution payload before adding the reliable stream entry', async () => {
    const payload = {
      messagesForNat: [{ role: 'user', content: 'hello' }],
      verifiedUsername: 'testuser',
    };

    await expect(enqueueStreamJob('job-1', payload)).resolves.toBe('1-0');

    expect(mocks.jsonSetWithExpiry).toHaveBeenCalledWith(
      streamPayloadKey('job-1'),
      payload,
      3600,
    );
    expect(mocks.redis.xadd).toHaveBeenCalledWith(
      STREAM_QUEUE_KEY,
      '*',
      'jobId',
      'job-1',
    );
    expect(mocks.jsonSetWithExpiry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redis.xadd.mock.invocationCallOrder[0],
    );
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

  it('removes the payload when adding the stream entry fails', async () => {
    mocks.redis.xadd.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(
      enqueueStreamJob('job-failed', {
        messagesForNat: [],
        verifiedUsername: 'testuser',
      }),
    ).rejects.toThrow('Redis unavailable');

    expect(mocks.jsonDel).toHaveBeenCalledWith(streamPayloadKey('job-failed'));
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
    ).resolves.toEqual([
      { entryId: '1-0', jobId: 'job-stale', reclaimed: true },
    ]);
  });

  it('uses owner-token-checked lease and start-marker scripts', async () => {
    await expect(
      acquireStreamLease('job-1', 'owner-1', 30000, mocks.redis as any),
    ).resolves.toBe(true);
    await expect(
      renewStreamLease('job-1', 'owner-1', 30000, mocks.redis as any),
    ).resolves.toBe(true);
    await expect(
      markBackendRequestStarted('job-1', 'owner-1', mocks.redis as any),
    ).resolves.toBe(true);
    await expect(
      releaseStreamLease('job-1', 'owner-1', mocks.redis as any),
    ).resolves.toBe(true);

    expect(mocks.redis.set).toHaveBeenCalledWith(
      'daedalus:async-stream-lease:job-1',
      'owner-1',
      'PX',
      30000,
      'NX',
    );
    expect(mocks.redis.eval).toHaveBeenCalledTimes(3);
    expect(mocks.redis.eval.mock.calls[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("redis.call('set', KEYS[2]"),
        2,
        'daedalus:async-stream-lease:job-1',
        'daedalus:async-stream-backend-started:job-1',
        'owner-1',
      ]),
    );
  });
});
