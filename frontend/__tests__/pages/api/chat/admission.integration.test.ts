// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ username: '' }));
vi.mock('@/utils/auth/session', () => ({ getSession: async () => session }));
vi.mock('@/server/chat/backendSelection', () => ({
  selectStreamBackendBaseUrl: async () => 'http://127.0.0.1:1',
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'chat admission after interrupted finalization',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    const prefix = `admission-${randomUUID()}`;
    const jobs = new Set<string>();

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      session.username = prefix;
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      await client.ping();
    });

    afterAll(async () => {
      if (!client) return;
      const { STREAM_QUEUE_KEY, acknowledgeStreamQueueEntry } = await import(
        '@/server/chat/streamQueue'
      );
      for (const [entryId, fields] of await client.xrange(
        STREAM_QUEUE_KEY,
        '-',
        '+',
      )) {
        const jobId = fields[fields.indexOf('jobId') + 1];
        if (jobs.has(jobId))
          await acknowledgeStreamQueueEntry({
            entryId,
            jobId,
            reclaimed: false,
          });
      }
      // Only remove this test's random namespace and allocated job records.
      for (const token of [prefix, ...jobs]) {
        let cursor = '0';
        do {
          const [next, keys] = await client.scan(
            cursor,
            'MATCH',
            `*${token}*`,
            'COUNT',
            100,
          );
          if (keys.length) await client.del(...keys);
          cursor = next;
        } while (cursor !== '0');
      }
      redis.getPublisher().disconnect();
      client.disconnect();
    });

    it('includes the recovered answer in model input and the next saved turn', async () => {
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { acquireConversationJobGuard } = await import(
        '@/server/chat/conversationJobGuard'
      );
      const { claimTerminalJobStatus } = await import('@/server/chat/jobState');
      const { finalizeError } = await import('@/server/chat/finalization');
      const { streamPayloadKey } = await import('@/server/chat/streamQueue');
      const handler = (await import('@/pages/api/chat/async')).default;
      const previousJob = `${prefix}-previous`;
      const conversationId = `${prefix}-conversation`;
      jobs.add(previousJob);
      await reserveConversationForUser(prefix, conversationId);
      await acquireConversationJobGuard(prefix, conversationId, previousJob);
      await redis.setStreamingState(prefix, conversationId, previousJob);
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-status', previousJob]),
        { jobId: previousJob, status: 'streaming', createdAt: 1 },
        120,
      );
      const firstQuestion = {
        id: 'u1',
        role: 'user',
        content: 'First question',
      };
      // Simulate a crash after claiming the outcome but before saving it.
      expect(
        (
          await claimTerminalJobStatus(
            previousJob,
            { status: 'error', finalizedAt: 2 },
            {
              version: 1,
              state: 'pending',
              jobId: previousJob,
              finalizationId: previousJob,
              outcome: 'error',
              userId: prefix,
              finalizedAt: 2,
              conversation: {
                id: conversationId,
                name: 'Recovery',
                messages: [firstQuestion],
                assistantMessageId: 'a1',
                content: 'Recovered first answer',
                intermediateSteps: [],
                isPartial: true,
              },
            },
          )
        ).claimed,
      ).toBe(true);

      const followUp = { id: 'u2', role: 'user', content: 'Follow up' };
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await handler(
        {
          method: 'POST',
          headers: { cookie: 'sid=admission-test-session' },
          body: {
            conversationId,
            messages: [followUp],
            assistantMessageId: 'a2',
          },
        } as any,
        res as any,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const nextJob = res.json.mock.calls[0][0].jobId;
      jobs.add(nextJob);
      const request = await redis.jsonGet(
        redis.sessionKey(['async-job-request', nextJob]),
      );
      expect(request.messages.map((message: any) => message.id)).toEqual([
        'u1',
        'a1',
        'u2',
      ]);
      const payload = await redis.jsonGet(streamPayloadKey(nextJob));
      expect(
        payload?.messagesForNat.map((message: any) => message.content),
      ).toEqual([
        expect.stringContaining('[IDENTITY]'),
        'First question',
        'Recovered first answer',
        'Follow up',
      ]);
      await finalizeError(nextJob, request, 'Synthetic stop', {
        response: 'Second partial answer',
        pendingSteps: [],
        persistedStepCount: 0,
      });
      const saved = await redis.jsonGet(
        redis.sessionKey(['conversation', conversationId]),
      );
      expect(saved.messages.map((message: any) => message.id)).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
      ]);
      expect(saved.messages[1].content).toBe('Recovered first answer');
    });

    it('recovers a conversation and slot from a submission that died before queueing', async () => {
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { conversationJobGuardKey } = await import(
        '@/server/chat/conversationJobGuard'
      );
      const { acquireUserJobGuard, userJobGuardKey } = await import(
        '@/server/chat/userJobGuard'
      );
      const handler = (await import('@/pages/api/chat/async')).default;
      const deadJob = `${prefix}-dead-submission`;
      const conversationId = `${prefix}-dead-conversation`;
      jobs.add(deadJob);
      await reserveConversationForUser(prefix, conversationId);
      const acquiredAt = Date.now() - 10 * 60 * 1000;
      // What the submitting process wrote before it died: the guard, a
      // provisional slot and a provisional status, but no request or payload.
      await client.set(
        conversationJobGuardKey(prefix, conversationId),
        JSON.stringify({
          version: 1,
          userId: prefix,
          conversationId,
          jobId: deadJob,
          acquiredAt,
        }),
        'EX',
        7200,
      );
      expect(await acquireUserJobGuard(prefix, deadJob, client, 120)).toBe(
        true,
      );
      const deadStatusKey = redis.sessionKey(['async-job-status', deadJob]);
      await redis.jsonSetWithExpiry(
        deadStatusKey,
        {
          jobId: deadJob,
          status: 'pending',
          createdAt: acquiredAt,
          updatedAt: acquiredAt,
          conversationId,
        },
        120,
      );

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      await handler(
        {
          method: 'POST',
          headers: { cookie: 'sid=admission-test-session' },
          body: {
            conversationId,
            messages: [{ id: 'u1', role: 'user', content: 'Try again' }],
          },
        } as any,
        res as any,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const nextJob = res.json.mock.calls[0][0].jobId;
      jobs.add(nextJob);
      expect(
        JSON.parse(
          (await client.get(conversationJobGuardKey(prefix, conversationId)))!,
        ).jobId,
      ).toBe(nextJob);
      expect(await client.exists(deadStatusKey)).toBe(0);
      const slots = userJobGuardKey(prefix);
      expect(await client.zscore(slots, deadJob)).toBeNull();
      expect(await client.zscore(slots, nextJob)).not.toBeNull();
      // The new job is queued with its full lifetime.
      expect(
        await client.ttl(redis.sessionKey(['async-job-status', nextJob])),
      ).toBeGreaterThan(3000);
    });

    it('queues a turn with its payload, entry and streaming notice in one commit', async () => {
      const { recordRedisLayers } = await import(
        '../../../fixtures/redisLayers'
      );
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const { streamPayloadKey } = await import('@/server/chat/streamQueue');
      const handler = (await import('@/pages/api/chat/async')).default;
      const conversationId = `${prefix}-one-commit`;
      await reserveConversationForUser(prefix, conversationId);
      const notices: any[] = [];
      const observer = client.duplicate();
      observer.on('message', (_channel: string, payload: string) =>
        notices.push(JSON.parse(payload)),
      );
      await observer.subscribe(redis.channels.userUpdates(prefix));
      const recorder = recordRedisLayers(client);
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      try {
        await handler(
          {
            method: 'POST',
            headers: { cookie: 'sid=admission-test-session' },
            body: {
              conversationId,
              messages: [{ id: 'u1', role: 'user', content: 'Hello' }],
            },
          } as any,
          res as any,
        );
      } finally {
        recorder.stop();
      }
      expect(res.status).toHaveBeenCalledWith(200);
      const jobId = res.json.mock.calls[0][0].jobId;
      jobs.add(jobId);
      const names = recorder
        .steady()
        .map((command) =>
          command.name === 'EVAL' || command.name === 'EVALSHA'
            ? command.tag
            : command.name,
        );
      // State is written before the job is queued; the queue entry, payload
      // and notice are one script, not separate XADD/SET/PUBLISH commands.
      expect(
        names.filter((name) => name === 'ENQUEUE_STREAM_JOB'),
      ).toHaveLength(1);
      expect(names).not.toContain('XADD');
      expect(names).not.toContain('PUBLISH');
      const enqueue = recorder
        .steady()
        .find((command) => command.tag === 'ENQUEUE_STREAM_JOB')!;
      expect(
        recorder
          .steady()
          .filter((command) =>
            command.args.some((arg) =>
              String(arg).includes(`async-job-request:${jobId}`),
            ),
          )
          .every((command) => command.layer < enqueue.layer),
      ).toBe(true);
      expect(enqueue.layer).toBe(recorder.steady().at(-1)!.layer);
      expect(
        JSON.parse((await client.get(streamPayloadKey(jobId)))!),
      ).toMatchObject({ verifiedUsername: prefix });
      await observer.ping();
      expect(notices).toContainEqual(
        expect.objectContaining({
          type: 'streaming_started',
          data: { conversationId, sessionId: jobId, isStreaming: true },
        }),
      );
      observer.disconnect();
    });

    it('answers a status poll in one round trip without reading the request history', async () => {
      const { recordRedisLayers } = await import(
        '../../../fixtures/redisLayers'
      );
      const handler = (await import('@/pages/api/chat/async')).default;
      const jobId = `${prefix}-poll`;
      jobs.add(jobId);
      const history = Array.from({ length: 100 }, (_, index) => ({
        id: `m${index}`,
        role: 'user',
        content: 'history '.repeat(100),
      }));
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-request', jobId]),
        { jobId, executionMode: 'stream', userId: prefix, messages: history },
        120,
      );
      await redis.jsonSetWithExpiry(
        redis.sessionKey(['async-job-status', jobId]),
        { jobId, status: 'streaming', createdAt: 1, updatedAt: 2 },
        120,
      );
      await client.set(
        redis.sessionKey(['async-job-response', jobId]),
        'Live text',
        'EX',
        120,
      );
      // Warm the RedisJSON capability check and the script cache: a steady
      // stream of polls sends only script digests.
      await handler(
        { method: 'GET', query: { jobId } } as any,
        { status: () => ({ json: () => undefined }), setHeader() {} } as any,
      );
      const recorder = recordRedisLayers(client);
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      try {
        await handler({ method: 'GET', query: { jobId } } as any, res as any);
      } finally {
        recorder.stop();
      }
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0]).toMatchObject({
        status: 'streaming',
        partialResponse: 'Live text',
      });
      expect(recorder.layers()).toBe(1);
      const ownership = recorder.commands.find(
        (command) => command.tag === 'READ_JSON_FIELDS',
      )!;
      expect(ownership.replyBytes).toBeLessThan(200);
      expect(JSON.stringify(history).length).toBeGreaterThan(50_000);

      // Another user's poll learns nothing.
      session.username = `${prefix}-other`;
      const denied = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
      };
      try {
        await handler(
          { method: 'GET', query: { jobId } } as any,
          denied as any,
        );
      } finally {
        session.username = prefix;
      }
      expect(denied.status).toHaveBeenCalledWith(404);
      expect(denied.json).toHaveBeenCalledWith({ error: 'Job not found' });
    });
  },
);
