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

    const {
      entries: [reclaimed],
    } = await queue.claimStaleStreamJobs(client, 'replacement-worker', 50, 1);
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

  it('does not restart backend execution for a fresh duplicate after lease loss', async () => {
    const redis = await import('@/server/session/redis');
    const state = await import('@/server/chat/jobState');
    const streamState = await import('@/server/chat/streamState');
    const reader = await import('@/server/chat/streamReader');
    const worker = await import('@/server/chat/streamWorker');
    const duplicateJob = `${jobId}-duplicate`;
    const requestKey = redis.sessionKey(['async-job-request', duplicateJob]);
    const statusKey = redis.sessionKey(['async-job-status', duplicateJob]);
    const backend = vi
      .spyOn(reader, 'startBackgroundStreamReader')
      .mockRejectedValue(new Error('Backend execution must not be repeated'));
    const entries: string[] = [];
    try {
      await redis.jsonSetWithExpiry(
        requestKey,
        {
          jobId: duplicateJob,
          userId: 'duplicate-user',
          executionMode: 'stream',
          natBaseUrl: 'http://127.0.0.1:1',
          messages: [],
        },
        120,
      );
      await redis.jsonSetWithExpiry(
        statusKey,
        {
          jobId: duplicateJob,
          status: 'streaming',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        120,
      );
      const payload = {
        messagesForNat: [],
        verifiedUsername: 'duplicate-user',
      };
      entries.push(await queue.enqueueStreamJob(duplicateJob, payload));
      await queue.readNewStreamJobs(client, 'original-worker', 1, 100);
      expect(
        await queue.acquireStreamLease(duplicateJob, 'original', 30000, client),
      ).toBe(true);
      expect(
        await queue.markBackendRequestStarted(duplicateJob, 'original', client),
      ).toBe(true);
      await streamState.appendStreamResponseDelta(
        duplicateJob,
        'Already accepted output',
        0,
      );
      await queue.releaseStreamLease(duplicateJob, 'original', client);

      // A lost XADD reply can be retried by Redis transport. Its new stream ID
      // has never been delivered, although this job has already called backend.
      entries.push(await queue.enqueueStreamJob(duplicateJob, payload));
      const [duplicate] = await queue.readNewStreamJobs(
        client,
        'replacement-worker',
        1,
        100,
      );
      expect(duplicate.reclaimed).toBe(false);
      await expect(
        worker.processStreamQueueEntry(
          duplicate,
          worker.streamWorkerOptionsFromEnv(),
          undefined,
          'replacement',
        ),
      ).resolves.toBe('recovered_as_error');
      expect(backend).not.toHaveBeenCalled();
      expect(await redis.jsonGet(statusKey)).toMatchObject({
        status: 'error',
        partialResponse: 'Already accepted output',
        error: expect.stringContaining('was not replayed'),
      });
    } finally {
      backend.mockRestore();
      if (entries.length) {
        await client.xack(
          queue.STREAM_QUEUE_KEY,
          queue.STREAM_QUEUE_GROUP,
          ...entries,
        );
        await client.xdel(queue.STREAM_QUEUE_KEY, ...entries);
      }
      await client.del(
        requestKey,
        statusKey,
        queue.streamPayloadKey(duplicateJob),
        queue.streamLeaseKey(duplicateJob),
        queue.streamBackendStartedKey(duplicateJob),
        state.finalizationJournalKey(duplicateJob),
        state.abortKey(duplicateJob),
        streamState.streamResponseKey(duplicateJob),
      );
    }
  });

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

  it('renews a conversation-less job as the ACL-restricted stream worker', async () => {
    // The Helm stream-worker user. An empty placeholder key in the renewal
    // script made Redis reject every heartbeat for this user (NOPERM).
    const { sessionKey } = await import('@/server/session/redis');
    const { default: Redis } = await import('ioredis');
    const username = `stream-worker-acl-${process.pid}`;
    const password = `acl-${Date.now()}`;
    const restrictedJobId = `${jobId}-acl`;
    const userGuardKey = sessionKey(['user', 'acl-user', 'active-jobs']);
    await client.call(
      'ACL',
      'SETUSER',
      username,
      'on',
      `>${password}`,
      ...'~async-* ~conversation:* ~conversation-job:* ~streaming:user:*:conversation:* ~user:* ~memory-retention:* ~mcp-oauth-callback:* ~mcp-approval-status:* ~document:* ~session-documents:* ~generated:* ~image:* ~image-job:*'.split(
        ' ',
      ),
      '+@all',
      '-@dangerous',
      '+info',
    );
    const url = new URL(process.env.REDIS_URL as string);
    url.username = username;
    url.password = password;
    const restricted = new Redis(url.toString(), { maxRetriesPerRequest: 1 });
    try {
      await queue.acquireStreamLease(restrictedJobId, 'owner', 30000, client);
      await client.zadd(userGuardKey, Date.now() + 1000, restrictedJobId);
      expect(
        await queue.renewStreamLease(
          restrictedJobId,
          'owner',
          30000,
          restricted,
          undefined,
          userGuardKey,
        ),
      ).toBe(true);
      expect(await client.ttl(userGuardKey)).toBeGreaterThan(1000);
    } finally {
      restricted.disconnect();
      await client.call('ACL', 'DELUSER', username);
      await client.del(userGuardKey, queue.streamLeaseKey(restrictedJobId));
    }
  });

  it.each(['plain', 'json'])(
    'keeps %s streaming state only while it still names the running job',
    async (format) => {
      const { sessionKey } = await import('@/server/session/redis');
      const runningJobId = `${jobId}-streaming-${format}`;
      const streamingKey = sessionKey([
        'streaming',
        'user',
        'state-user',
        'conversation',
        `conversation-${format}`,
      ]);
      const write = async (sessionId: string) => {
        const state = JSON.stringify({
          conversationId: `conversation-${format}`,
          sessionId,
          startedAt: Date.now(),
          userId: 'state-user',
        });
        await client.del(streamingKey);
        if (format === 'json') {
          await client.call('JSON.SET', streamingKey, '$', state);
          await client.pexpire(streamingKey, 500);
        } else {
          await client.set(streamingKey, state, 'PX', 500);
        }
      };
      try {
        await queue.acquireStreamLease(runningJobId, 'owner', 30000, client);
        await write(runningJobId);
        expect(
          await queue.renewStreamLease(
            runningJobId,
            'owner',
            30000,
            client,
            undefined,
            undefined,
            streamingKey,
          ),
        ).toBe(true);
        expect(await client.ttl(streamingKey)).toBeGreaterThanOrEqual(599);

        await write('a-newer-job');
        await queue.renewStreamLease(
          runningJobId,
          'owner',
          30000,
          client,
          undefined,
          undefined,
          streamingKey,
        );
        expect(await client.pttl(streamingKey)).toBeLessThanOrEqual(500);
      } finally {
        await client.del(streamingKey, queue.streamLeaseKey(runningJobId));
      }
    },
  );

  it('reaches an abandoned entry beyond a page of recently touched pending entries', async () => {
    const ids: string[] = [];
    try {
      for (let index = 0; index < 12; index += 1) {
        ids.push(
          await client.xadd(
            queue.STREAM_QUEUE_KEY,
            '*',
            'jobId',
            `${jobId}-page-${index}`,
          ),
        );
      }
      const pending = await queue.readNewStreamJobs(
        client,
        'page-owner',
        12,
        100,
      );
      expect(pending).toHaveLength(12);
      // Set deterministic PEL idle ages; no wall-clock sleep or lease expiry.
      await client.xclaim(
        queue.STREAM_QUEUE_KEY,
        queue.STREAM_QUEUE_GROUP,
        'page-owner',
        0,
        ids[11],
        'IDLE',
        10000,
      );
      const first = await queue.claimStaleStreamJobs(
        client,
        'page-recovery',
        5000,
        1,
      );
      expect(first.entries).toEqual([]);
      expect(first.nextCursor).not.toBe('0-0');
      const next = await queue.claimStaleStreamJobs(
        client,
        'page-recovery',
        5000,
        1,
        first.nextCursor,
      );
      expect(next.entries).toEqual([{ ...pending[11], reclaimed: true }]);
    } finally {
      if (ids.length) {
        await client.xack(
          queue.STREAM_QUEUE_KEY,
          queue.STREAM_QUEUE_GROUP,
          ...ids,
        );
        await client.xdel(queue.STREAM_QUEUE_KEY, ...ids);
      }
    }
  });
});
