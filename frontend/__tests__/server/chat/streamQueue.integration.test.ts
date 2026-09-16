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

  it.each(['default', 'deep', 'deep_max', undefined])(
    'retains requested profile %s in the durable job through queue claim',
    async (modelProfile) => {
      const { jsonSetWithExpiry, jsonGet, sessionKey } = await import(
        '@/server/session/redis'
      );
      const selectedJob = `${jobId}-profile-${modelProfile ?? 'automatic'}`;
      const requestKey = sessionKey(['async-job-request', selectedJob]);
      const additionalProps = {
        ...(modelProfile ? { model_profile: modelProfile } : {}),
        unrelated: 'retained',
      };
      try {
        await jsonSetWithExpiry(
          requestKey,
          { jobId: selectedJob, userId: 'testuser', additionalProps },
          60,
        );
        await queue.enqueueStreamJob(selectedJob, {
          messagesForNat: [{ role: 'user', content: 'fixture' }],
          verifiedUsername: 'testuser',
        });
        const [entry] = await queue.readNewStreamJobs(
          client,
          'profile-worker',
          1,
          100,
        );
        expect(entry.jobId).toBe(selectedJob);
        const restored = (await jsonGet(requestKey)) as any;
        expect(restored.additionalProps).toEqual(additionalProps);
        expect(await queue.loadStreamQueuePayload(selectedJob)).toMatchObject({
          verifiedUsername: 'testuser',
        });
        await queue.acknowledgeStreamQueueEntry(entry, client);
        // Acknowledging queue transport does not remove request metadata used
        // by authorization/status handling.
        expect(((await jsonGet(requestKey)) as any).additionalProps).toEqual(
          additionalProps,
        );
      } finally {
        await client.del(requestKey, queue.streamPayloadKey(selectedJob));
      }
    },
  );

  it('keeps long-running job recovery state alive only for the lease owner', async () => {
    const { sessionKey } = await import('@/server/session/redis');
    const state = await import('@/server/chat/streamState');
    const guard = await import('@/server/chat/conversationJobGuard');
    const activeJobId = `${jobId}-long-running`;
    const guardKey = guard.conversationJobGuardKey('testuser', activeJobId);
    const keys = [
      sessionKey(['async-job-request', activeJobId]),
      sessionKey(['async-job-status', activeJobId]),
      queue.streamPayloadKey(activeJobId),
      queue.streamBackendStartedKey(activeJobId),
      state.streamResponseKey(activeJobId),
      state.streamStepsKey(activeJobId),
      state.legacyStreamStepsKey(activeJobId),
      sessionKey(['async-job-abort', activeJobId]),
      sessionKey(['async-job-finalization', activeJobId]),
    ];
    try {
      await queue.acquireStreamLease(
        activeJobId,
        'active-owner',
        30000,
        client,
      );
      for (const key of keys)
        await client.set(key, 'saved progress', 'PX', 500);
      await client.set(
        guardKey,
        JSON.stringify({ jobId: activeJobId }),
        'PX',
        500,
      );

      expect(
        await queue.renewStreamLease(
          activeJobId,
          'other-owner',
          30000,
          client,
          guardKey,
        ),
      ).toBe(false);
      for (const key of [...keys, guardKey]) {
        expect(await client.pttl(key)).toBeLessThanOrEqual(500);
      }

      expect(
        await queue.renewStreamLease(
          activeJobId,
          'active-owner',
          30000,
          client,
          guardKey,
        ),
      ).toBe(true);
      for (const key of keys) {
        expect(await client.ttl(key)).toBeGreaterThanOrEqual(3599);
        expect(await client.get(key)).toBe('saved progress');
      }
      expect(await client.ttl(guardKey)).toBeGreaterThanOrEqual(7199);

      await client.set(
        guardKey,
        JSON.stringify({ jobId: 'a-new-job' }),
        'PX',
        500,
      );
      await queue.renewStreamLease(
        activeJobId,
        'active-owner',
        30000,
        client,
        guardKey,
      );
      expect(await client.pttl(guardKey)).toBeLessThanOrEqual(500);
    } finally {
      await client.del(...keys, guardKey, queue.streamLeaseKey(activeJobId));
    }
  });
});
