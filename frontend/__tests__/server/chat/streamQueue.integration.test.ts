import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN_REAL_REDIS = process.env.RUN_REDIS_STREAM_INTEGRATION === '1';

describe.skipIf(!RUN_REAL_REDIS)('durable stream queue with real Redis', () => {
  let client: any;
  let queue: typeof import('@/server/chat/streamQueue');
  let jobId: string;

  beforeAll(async () => {
    if (!process.env.REDIS_URL) {
      throw new Error(
        'RUN_REDIS_STREAM_INTEGRATION requires REDIS_URL for a disposable Redis instance',
      );
    }

    jobId = `stream-reclaim-${process.pid}-${Date.now()}`;
    process.env.STREAM_WORKER_QUEUE_KEY = `${jobId}:queue`;
    process.env.STREAM_WORKER_GROUP = `${jobId}:group`;
    vi.resetModules();

    queue = await import('@/server/chat/streamQueue');
    const redis = await import('@/server/session/redis');
    client = redis.getRedis();
    if (client.status === 'wait') await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client
        .del(
          queue.STREAM_QUEUE_KEY,
          queue.streamPayloadKey(jobId),
          queue.streamLeaseKey(jobId),
          queue.streamBackendStartedKey(jobId),
        )
        .catch(() => 0);
      client.disconnect();
    }
    delete process.env.STREAM_WORKER_QUEUE_KEY;
    delete process.env.STREAM_WORKER_GROUP;
  });

  it('reclaims an unacknowledged entry after the owning lease expires', async () => {
    await queue.ensureStreamConsumerGroup(client);
    await queue.enqueueStreamJob(jobId, {
      messagesForNat: [{ role: 'user', content: 'hello' }],
      verifiedUsername: 'testuser',
    });

    const [owned] = await queue.readNewStreamJobs(
      client,
      'worker-that-stops',
      1,
      100,
    );
    expect(owned).toEqual(expect.objectContaining({ jobId, reclaimed: false }));

    expect(
      await queue.acquireStreamLease(jobId, 'dead-owner', 50, client),
    ).toBe(true);
    expect(
      await queue.markBackendRequestStarted(jobId, 'dead-owner', client),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const [reclaimed] = await queue.claimStaleStreamJobs(
      client,
      'replacement-worker',
      50,
      1,
    );
    expect(reclaimed).toEqual(
      expect.objectContaining({
        entryId: owned.entryId,
        jobId,
        reclaimed: true,
      }),
    );
    expect(await queue.hasBackendRequestStarted(jobId, client)).toBe(true);
    expect(
      await queue.acquireStreamLease(jobId, 'replacement-owner', 1000, client),
    ).toBe(true);

    await queue.acknowledgeStreamQueueEntry(reclaimed, client);
    expect(await client.xlen(queue.STREAM_QUEUE_KEY)).toBe(0);
    expect(await client.exists(queue.streamPayloadKey(jobId))).toBe(0);
    expect(await client.exists(queue.streamBackendStartedKey(jobId))).toBe(0);
  });
});
