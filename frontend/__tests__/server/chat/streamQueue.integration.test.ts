import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN_REAL_REDIS = process.env.RUN_REDIS_STREAM_INTEGRATION === '1';

/**
 * The stream-worker ACL exactly as the Helm chart writes it: key patterns,
 * channel patterns and command rules. Reading the chart keeps this test from
 * drifting from the deployed user; a format change fails loudly here.
 */
function chartStreamWorkerAclRules(): string[] {
  const chart = readFileSync(
    path.resolve(
      __dirname,
      '../../../../helm/daedalus/templates/redis-init-configmap.yaml',
    ),
    'utf8',
  );
  const user = chart.match(
    /write_acl_user "\$REDIS_STREAM_WORKER_USERNAME"[^\n]*\n[^\n]*\n\s*'([^']+)' \\\n\s*'([^']+)'/,
  );
  const commands = chart.match(/printf ' (\+@all[^'\\]*)\\n'/);
  if (!user || !commands) {
    throw new Error(
      'Stream-worker ACL not found in the Helm Redis init script',
    );
  }
  return [user[1], user[2], commands[1]].flatMap((rules) => rules.split(' '));
}

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
          `async-job-status:${jobId}`,
          `async-job-request:${jobId}`,
        )
        .catch(() => 0);
      client.disconnect();
    }
    delete process.env.STREAM_WORKER_QUEUE_KEY;
    delete process.env.STREAM_WORKER_GROUP;
  });

  it('reclaims an unacknowledged entry after the owning lease expires', async () => {
    await queue.ensureStreamConsumerGroup(client);
    await queue.enqueueStreamJob(
      jobId,
      {
        messagesForNat: [{ role: 'user', content: 'hello' }],
        verifiedUsername: 'testuser',
      },
      { userId: 'testuser' },
    );

    const [owned] = await queue.readNewStreamJobs(
      client,
      'worker-that-stops',
      1,
      100,
    );
    expect(owned).toEqual(expect.objectContaining({ jobId, reclaimed: false }));

    expect(
      await queue.acquireStreamLeaseSnapshot(jobId, 'dead-owner', 50, client),
    ).not.toBeNull();
    expect(
      await queue.markBackendRequestStarted(jobId, 'dead-owner', client),
    ).toBe('started');

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
    // The replacement owner's snapshot carries the start marker, so it
    // finalizes instead of replaying the request, and skips the payload.
    const { sessionKey } = await import('@/server/session/redis');
    await client.set(
      sessionKey(['async-job-status', jobId]),
      JSON.stringify({ jobId, status: 'pending', createdAt: 1, updatedAt: 1 }),
      'EX',
      60,
    );
    await client.set(
      sessionKey(['async-job-request', jobId]),
      JSON.stringify({ jobId, userId: 'testuser', executionMode: 'stream' }),
      'EX',
      60,
    );
    expect(
      await queue.acquireStreamLeaseSnapshot(
        jobId,
        'replacement-owner',
        1000,
        client,
      ),
    ).toMatchObject({ started: true, canceled: false, payload: null });

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
        await queue.enqueueStreamJob(
          selectedJob,
          {
            messagesForNat: [{ role: 'user', content: 'fixture' }],
            verifiedUsername: 'testuser',
          },
          { userId: 'testuser' },
        );
        const [entry] = await queue.readNewStreamJobs(
          client,
          'profile-worker',
          1,
          100,
        );
        expect(entry.jobId).toBe(selectedJob);
        const restored = (await jsonGet(requestKey)) as any;
        expect(restored.additionalProps).toEqual(additionalProps);
        expect(
          await jsonGet(queue.streamPayloadKey(selectedJob)),
        ).toMatchObject({ verifiedUsername: 'testuser' });
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
      entries.push(
        await queue.enqueueStreamJob(duplicateJob, payload, {
          userId: 'duplicate-user',
        }),
      );
      await queue.readNewStreamJobs(client, 'original-worker', 1, 100);
      expect(
        await queue.acquireStreamLeaseSnapshot(
          duplicateJob,
          'original',
          30000,
          client,
        ),
      ).not.toBeNull();
      expect(
        await queue.markBackendRequestStarted(duplicateJob, 'original', client),
      ).toBe('started');
      await streamState.appendStreamResponseDelta(
        duplicateJob,
        'Already accepted output',
        0,
      );
      await queue.releaseStreamLease(duplicateJob, 'original', client);

      // A lost XADD reply can be retried by Redis transport. Its new stream ID
      // has never been delivered, although this job has already called backend.
      entries.push(
        await queue.enqueueStreamJob(duplicateJob, payload, {
          userId: 'duplicate-user',
        }),
      );
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
      sessionKey(['async-job-abort', activeJobId]),
      sessionKey(['async-job-finalization', activeJobId]),
    ];
    try {
      await queue.acquireStreamLeaseSnapshot(
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
      // The guard TTL equals the job records' lifetime (JOB_EXPIRY_SECONDS).
      expect(await client.ttl(guardKey)).toBeGreaterThanOrEqual(3599);

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

  it('renews and starts a conversation-less job as the ACL-restricted stream worker', async () => {
    // The Helm stream-worker user. An empty placeholder key in the renewal
    // script made Redis reject every heartbeat for this user (NOPERM). Use the
    // real slot key: an invented key can match a pattern the real one misses.
    const { userJobGuardKey } = await import('@/server/chat/userJobGuard');
    const { abortKey } = await import('@/server/chat/jobState');
    const { default: Redis } = await import('ioredis');
    const username = `stream-worker-acl-${process.pid}`;
    const password = `acl-${Date.now()}`;
    const restrictedJobId = `${jobId}-acl`;
    const userGuardKey = userJobGuardKey('acl-user');
    const rules = chartStreamWorkerAclRules();
    expect(rules).toEqual(
      expect.arrayContaining(['~async-*', '&job:*:status', '+@all']),
    );
    await client.call(
      'ACL',
      'SETUSER',
      username,
      'reset',
      'on',
      `>${password}`,
      ...rules,
    );
    const url = new URL(process.env.REDIS_URL as string);
    url.username = username;
    url.password = password;
    const restricted = new Redis(url.toString(), { maxRetriesPerRequest: 1 });
    try {
      await queue.acquireStreamLeaseSnapshot(
        restrictedJobId,
        'owner',
        30000,
        client,
      );
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
      // The start marker also reads the job's stop signal under this ACL.
      expect(
        await queue.markBackendRequestStarted(
          restrictedJobId,
          'owner',
          restricted,
        ),
      ).toBe('started');
      // Live status and token events use the chart's exact channels.
      await expect(
        restricted.publish(`job:${restrictedJobId}:status`, '{}'),
      ).resolves.toBeGreaterThanOrEqual(0);
      await expect(
        restricted.publish('user:acl-user:chat:conv-1:tokens', '{}'),
      ).resolves.toBeGreaterThanOrEqual(0);
      await expect(restricted.publish('audit:other', '{}')).rejects.toThrow(
        /NOPERM/,
      );
    } finally {
      restricted.disconnect();
      await client.call('ACL', 'DELUSER', username);
      await client.del(
        userGuardKey,
        queue.streamLeaseKey(restrictedJobId),
        queue.streamBackendStartedKey(restrictedJobId),
        abortKey(restrictedJobId),
      );
    }
  });

  it('claims, streams, finalizes and queues retention as the ACL-restricted stream worker', async () => {
    // Every script the worker runs on a normal turn, under the chart's ACL:
    // the lease snapshot, start marker, cached append/status scripts, the
    // terminal claim with its lock, the conversation save, the single journal
    // write with its cleanup, publications and retention submission, the
    // acknowledgement, and the retention poll.
    const { sessionKey } = await import('@/server/session/redis');
    const { reserveConversationForUser } = await import(
      '@/server/session/conversationStore'
    );
    const guards = await import('@/server/chat/conversationJobGuard');
    const slots = await import('@/server/chat/userJobGuard');
    const rules = chartStreamWorkerAclRules();
    const username = `stream-worker-e2e-${process.pid}`;
    const password = `acl-e2e-${Date.now()}`;
    const aclJob = `async-acl-e2e-${process.pid}-${Date.now()}`;
    const userId = `acl-user-${process.pid}`;
    const conversationId = `acl-conversation-${process.pid}`;
    const queueKey = `async-test-queue-${aclJob}`;
    const group = `group-${aclJob}`;
    const env = {
      url: process.env.REDIS_URL,
      queue: process.env.STREAM_WORKER_QUEUE_KEY,
      group: process.env.STREAM_WORKER_GROUP,
    };
    const statusKey = sessionKey(['async-job-status', aclJob]);
    const requestKey = sessionKey(['async-job-request', aclJob]);
    const streamingKey = sessionKey([
      'streaming',
      'user',
      userId,
      'conversation',
      conversationId,
    ]);
    const guardKey = guards.conversationJobGuardKey(userId, conversationId);
    const submissionKey = sessionKey([
      'memory-retention',
      'submission',
      'v1',
      aclJob,
    ]);
    const observer = client.duplicate();
    const events: any[] = [];
    observer.on('message', (_channel: string, payload: string) =>
      events.push(JSON.parse(payload)),
    );
    let workerRedis: typeof import('@/server/session/redis') | undefined;
    try {
      await observer.subscribe(
        `job:${aclJob}:status`,
        `user:${userId}:chat:${conversationId}:tokens`,
      );
      await client.call(
        'ACL',
        'SETUSER',
        username,
        'reset',
        'on',
        `>${password}`,
        ...rules,
      );
      // What the (unrestricted) submit route writes before queueing.
      await reserveConversationForUser(userId, conversationId);
      await client.set(
        requestKey,
        JSON.stringify({
          jobId: aclJob,
          executionMode: 'stream',
          natBaseUrl: 'http://backend.test:8000',
          messages: [{ id: 'acl-user-turn', role: 'user', content: 'Status?' }],
          additionalProps: {},
          userId,
          conversationId,
          conversationName: 'ACL turn',
          assistantMessageId: 'acl-answer',
        }),
        'EX',
        600,
      );
      await client.set(
        statusKey,
        JSON.stringify({
          jobId: aclJob,
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          conversationId,
        }),
        'EX',
        600,
      );
      await client.set(
        streamingKey,
        JSON.stringify({
          conversationId,
          sessionId: aclJob,
          startedAt: Date.now(),
          userId,
        }),
        'EX',
        600,
      );
      await guards.acquireConversationJobGuard(
        userId,
        conversationId,
        aclJob,
        client,
      );
      await slots.acquireUserJobGuard(userId, aclJob, client);
      await client.xgroup('CREATE', queueKey, group, '0', 'MKSTREAM');
      await client.set(
        queue.streamPayloadKey(aclJob),
        JSON.stringify({
          messagesForNat: [{ role: 'user', content: 'Status?' }],
          verifiedUsername: userId,
        }),
        'EX',
        600,
      );
      const entryId = await client.xadd(queueKey, '*', 'jobId', aclJob);
      await client.xreadgroup(
        'GROUP',
        group,
        'acl-consumer',
        'COUNT',
        1,
        'STREAMS',
        queueKey,
        '>',
      );

      const url = new URL(process.env.REDIS_URL as string);
      url.username = username;
      url.password = password;
      process.env.REDIS_URL = url.toString();
      process.env.STREAM_WORKER_QUEUE_KEY = queueKey;
      process.env.STREAM_WORKER_GROUP = group;
      vi.resetModules();
      workerRedis = await import('@/server/session/redis');
      const worker = await import('@/server/chat/streamWorker');
      const retention = await import('@/server/chat/memoryRetention');
      const encoder = new TextEncoder();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL) => {
          if (String(input).endsWith('/v1/memory/retain-turn'))
            return new Response(JSON.stringify({ operation_id: 'acl-op' }), {
              status: 200,
            });
          return new Response(
            new ReadableStream({
              start(controller) {
                for (const content of ['All ', 'systems ', 'nominal.'])
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        choices: [{ delta: { content } }],
                      })}\n\n`,
                    ),
                  );
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        }),
      );

      await expect(
        worker.processStreamQueueEntry(
          { entryId, jobId: aclJob, reclaimed: false },
          worker.streamWorkerOptionsFromEnv(),
          undefined,
          'acl-owner',
        ),
      ).resolves.toBe('completed');
      // The retention queue is shared with other test files; send only this
      // job's submission.
      await retention.processMemoryRetention(aclJob);

      expect(JSON.parse(await client.get(statusKey))).toMatchObject({
        status: 'completed',
        fullResponse: 'All systems nominal.',
      });
      const saved = JSON.parse(
        await client.get(sessionKey(['conversation', conversationId])),
      );
      expect(saved.messages.map((message: any) => message.content)).toEqual([
        'Status?',
        'All systems nominal.',
      ]);
      expect(await client.exists(guardKey, streamingKey, submissionKey)).toBe(
        0,
      );
      expect(
        await client.zscore(slots.userJobGuardKey(userId), aclJob),
      ).toBeNull();
      expect(await client.xlen(queueKey)).toBe(0);
      expect(
        JSON.parse(
          await client.call(
            'JSON.GET',
            sessionKey(['memory-retention', 'record', 'v1', aclJob]),
            '.',
          ),
        ),
      ).toMatchObject({ operationId: 'acl-op', userId });
      await observer.ping();
      expect(events.map((event) => event.type ?? event.status)).toEqual(
        expect.arrayContaining(['chat_token', 'completed', 'chat_complete']),
      );
    } finally {
      vi.unstubAllGlobals();
      workerRedis?.getRedis().disconnect();
      workerRedis?.getPublisher().disconnect();
      observer.disconnect();
      if (env.url === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = env.url;
      if (env.queue === undefined) delete process.env.STREAM_WORKER_QUEUE_KEY;
      else process.env.STREAM_WORKER_QUEUE_KEY = env.queue;
      if (env.group === undefined) delete process.env.STREAM_WORKER_GROUP;
      else process.env.STREAM_WORKER_GROUP = env.group;
      vi.resetModules();
      await client.call('ACL', 'DELUSER', username);
      await client.del(
        queueKey,
        statusKey,
        requestKey,
        streamingKey,
        guardKey,
        submissionKey,
        slots.userJobGuardKey(userId),
        queue.streamPayloadKey(aclJob),
        queue.streamLeaseKey(aclJob),
        queue.streamBackendStartedKey(aclJob),
        sessionKey(['async-job-finalization', aclJob]),
        sessionKey(['async-job-finalizer-lock', aclJob]),
        sessionKey(['async-job-abort', aclJob]),
        sessionKey(['async-job-response', aclJob]),
        sessionKey(['async-job-steps-v2', aclJob]),
        sessionKey(['conversation', conversationId]),
        sessionKey(['user', userId, 'conversations']),
        sessionKey(['memory-retention', 'record', 'v1', aclJob]),
        sessionKey(['memory-retention', 'user', userId, 'v1']),
        sessionKey(['memory-retention', 'lock', 'v1', aclJob]),
      );
      await client.zrem(
        sessionKey(['memory-retention', 'queue', 'v1']),
        aclJob,
      );
      await client.zrem(
        sessionKey(['memory-retention', 'submission-queue', 'v1']),
        aclJob,
      );
    }
  }, 20_000);

  it('reaches the backend request in two round trips with one read of each record', async () => {
    const { recordRedisLayers } = await import('../../fixtures/redisLayers');
    const { jsonSetWithExpiry, sessionKey, getRedis } = await import(
      '@/server/session/redis'
    );
    const reader = await import('@/server/chat/streamReader');
    const worker = await import('@/server/chat/streamWorker');
    const claimJob = `${jobId}-claim-round-trips`;
    const statusKey = sessionKey(['async-job-status', claimJob]);
    const requestKey = sessionKey(['async-job-request', claimJob]);
    const history = Array.from({ length: 50 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: 'history '.repeat(100),
    }));
    let beforeFetch: ReturnType<typeof recordRedisLayers>['commands'] = [];
    const recorder = recordRedisLayers(getRedis());
    const backend = vi
      .spyOn(reader, 'startBackgroundStreamReader')
      .mockImplementation(async (_job, _request, messages, _user, control) => {
        expect(messages).toHaveLength(history.length);
        await control!.beforeBackendRequest!();
        beforeFetch = recorder.steady();
        recorder.stop();
        throw new Error('stop after the start marker');
      });
    try {
      await jsonSetWithExpiry(
        requestKey,
        {
          jobId: claimJob,
          executionMode: 'stream',
          natBaseUrl: 'http://127.0.0.1:1',
          messages: history,
          userId: 'claim-user',
        },
        120,
      );
      await jsonSetWithExpiry(
        statusKey,
        { jobId: claimJob, status: 'pending', createdAt: 1, updatedAt: 1 },
        120,
      );
      await client.set(
        queue.streamPayloadKey(claimJob),
        JSON.stringify({ messagesForNat: history, verifiedUsername: 'u' }),
        'EX',
        120,
      );
      recorder.commands.length = 0;
      await worker.processStreamQueueEntry(
        { entryId: '0-1', jobId: claimJob, reclaimed: false },
        worker.streamWorkerOptionsFromEnv(),
        undefined,
        'claim-owner',
      );
      expect(backend).toHaveBeenCalledOnce();
      // Lease + status + request + start evidence + stop signal + payload,
      // then the start marker with its stop check, immediately before fetch.
      expect(
        beforeFetch.map((command) => [command.layer, command.tag]),
      ).toEqual([
        [beforeFetch[0].layer, 'ACQUIRE_STREAM_LEASE_SNAPSHOT'],
        [beforeFetch[0].layer + 1, 'MARK_BACKEND_STARTED'],
      ]);
    } finally {
      recorder.stop();
      backend.mockRestore();
      await client.del(
        statusKey,
        requestKey,
        queue.streamPayloadKey(claimJob),
        queue.streamLeaseKey(claimJob),
        queue.streamBackendStartedKey(claimJob),
        sessionKey(['async-job-finalization', claimJob]),
        sessionKey(['async-job-finalizer-lock', claimJob]),
        sessionKey(['async-job-abort', claimJob]),
      );
    }
  });

  it('commits the payload with its entry, a recorded submission stop and the streaming notice', async () => {
    const { abortKey } = await import('@/server/chat/jobState');
    const enqueueJob = `${jobId}-enqueue`;
    const submissionKey = `job-submission:chat:enqueue-user:${enqueueJob}`;
    const channel = `user:enqueue-user:updates`;
    const observer = client.duplicate();
    const notices: string[] = [];
    observer.on('message', (_channel: string, payload: string) =>
      notices.push(payload),
    );
    const entries: string[] = [];
    try {
      await observer.subscribe(channel);
      await client.set(
        submissionKey,
        JSON.stringify({ jobId: enqueueJob, cancelled: true }),
        'EX',
        60,
      );
      entries.push(
        await queue.enqueueStreamJob(
          enqueueJob,
          {
            messagesForNat: [{ role: 'user', content: 'hi' }],
            verifiedUsername: 'u',
          },
          { userId: 'u' },
          {
            submissionKey,
            notice: { channel, payload: '{"type":"streaming_started"}' },
          },
        ),
      );
      expect(
        JSON.parse(await client.get(queue.streamPayloadKey(enqueueJob))),
      ).toEqual({
        messagesForNat: [{ role: 'user', content: 'hi' }],
        verifiedUsername: 'u',
      });
      expect(
        await client.ttl(queue.streamPayloadKey(enqueueJob)),
      ).toBeGreaterThan(0);
      expect(await client.get(abortKey(enqueueJob))).toBe('true');
      const [[entryId, fields]] = await client.xrange(
        queue.STREAM_QUEUE_KEY,
        entries[0],
        entries[0],
      );
      expect([entryId, fields]).toEqual([
        entries[0],
        ['jobId', enqueueJob, 'userId', 'u', 'conversationId', ''],
      ]);
      await observer.ping();
      expect(notices).toEqual(['{"type":"streaming_started"}']);

      // A failed entry write leaves no payload or stop signal behind. This
      // file's private queue key briefly holds the wrong type.
      await client.del(
        queue.streamPayloadKey(enqueueJob),
        abortKey(enqueueJob),
      );
      const parked = `${queue.STREAM_QUEUE_KEY}:parked`;
      await client.rename(queue.STREAM_QUEUE_KEY, parked);
      try {
        await client.set(queue.STREAM_QUEUE_KEY, 'not a stream');
        await expect(
          queue.enqueueStreamJob(
            enqueueJob,
            { messagesForNat: [], verifiedUsername: 'u' },
            { userId: 'u' },
            { submissionKey },
          ),
        ).rejects.toThrow(/WRONGTYPE/);
      } finally {
        await client.del(queue.STREAM_QUEUE_KEY);
        await client.rename(parked, queue.STREAM_QUEUE_KEY);
      }
      expect(
        await client.exists(
          queue.streamPayloadKey(enqueueJob),
          abortKey(enqueueJob),
        ),
      ).toBe(0);
    } finally {
      observer.disconnect();
      if (entries.length) await client.xdel(queue.STREAM_QUEUE_KEY, ...entries);
      await client.del(
        submissionKey,
        queue.streamPayloadKey(enqueueJob),
        abortKey(enqueueJob),
      );
    }
  });

  it('refuses to start a backend request after a recorded stop', async () => {
    const { abortKey } = await import('@/server/chat/jobState');
    const stoppedJobId = `${jobId}-stopped-before-start`;
    try {
      await queue.acquireStreamLeaseSnapshot(
        stoppedJobId,
        'owner',
        30000,
        client,
      );
      await client.set(abortKey(stoppedJobId), 'true', 'EX', 60);
      expect(
        await queue.markBackendRequestStarted(stoppedJobId, 'owner', client),
      ).toBe('canceled');
      expect(
        await client.exists(queue.streamBackendStartedKey(stoppedJobId)),
      ).toBe(0);
      // Lease ownership is still checked first: a non-owner learns nothing.
      expect(
        await queue.markBackendRequestStarted(stoppedJobId, 'other', client),
      ).toBe('lease_lost');
    } finally {
      await client.del(
        abortKey(stoppedJobId),
        queue.streamLeaseKey(stoppedJobId),
        queue.streamBackendStartedKey(stoppedJobId),
      );
    }
  });

  it('treats streamed output as start evidence when the marker is gone', async () => {
    const streamState = await import('@/server/chat/streamState');
    const { jsonSetWithExpiry, sessionKey } = await import(
      '@/server/session/redis'
    );
    const evictedJobId = `${jobId}-evicted-marker`;
    const statusKey = sessionKey(['async-job-status', evictedJobId]);
    const requestKey = sessionKey(['async-job-request', evictedJobId]);
    const snapshot = async () => {
      const result = await queue.acquireStreamLeaseSnapshot(
        evictedJobId,
        'owner',
        30000,
        client,
      );
      await queue.releaseStreamLease(evictedJobId, 'owner', client);
      return result;
    };
    try {
      // RedisJSON records (the submit route's format) and a plain-string
      // payload (the enqueue script's format) are both read.
      await jsonSetWithExpiry(
        statusKey,
        { jobId: evictedJobId, status: 'pending', createdAt: 1 },
        60,
      );
      await jsonSetWithExpiry(
        requestKey,
        { jobId: evictedJobId, userId: 'testuser', messages: [] },
        60,
      );
      await client.set(
        queue.streamPayloadKey(evictedJobId),
        JSON.stringify({ messagesForNat: [], verifiedUsername: 'testuser' }),
        'EX',
        60,
      );
      expect(await snapshot()).toEqual({
        status: { jobId: evictedJobId, status: 'pending', createdAt: 1 },
        request: { jobId: evictedJobId, userId: 'testuser', messages: [] },
        payload: { messagesForNat: [], verifiedUsername: 'testuser' },
        started: false,
        canceled: false,
      });
      await streamState.appendStreamSteps(evictedJobId, [{ id: 1 }], 0);
      expect(await snapshot()).toMatchObject({
        started: true,
        payload: null,
      });
    } finally {
      await client.del(
        statusKey,
        requestKey,
        queue.streamPayloadKey(evictedJobId),
        queue.streamLeaseKey(evictedJobId),
        streamState.streamStepsKey(evictedJobId),
        streamState.streamResponseKey(evictedJobId),
      );
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
        await queue.acquireStreamLeaseSnapshot(
          runningJobId,
          'owner',
          30000,
          client,
        );
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
